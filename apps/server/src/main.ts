// Boot sequence (T15, 28 §2): config → migrate under advisory lock → routes.
import { Pool } from "pg";
import { loadConfigOrExit } from "@acos/config";
import { createDb, createGuardedDb, runMigrations } from "@acos/db";
import { connect as natsConnect } from "nats";
import { buildApp } from "./app.js";
import { provisionJetStream } from "./modules/events/jetstream.js";
import { OutboxRelay } from "./modules/events/relay.js";
import { DlqHandler } from "./modules/events/dlq.js";
import { buildCheckers } from "./checkers.js";

async function main(): Promise<void> {
  const config = loadConfigOrExit(process.env);

  await runMigrations(config.database.url); // pg_advisory_lock inside — safe under multi-boot
  const pool = new Pool({ connectionString: config.database.url });

  const guardedDb = createGuardedDb(pool);
  if (config.seedDemo) {
    const { ensureSeed, SEED_FOUNDER_EMAIL } = await import("./seed.js");
    const seeded = await ensureSeed(guardedDb);
    if (seeded.created && seeded.founderPassword) {
      console.log(`ACOS ready — ${SEED_FOUNDER_EMAIL} / ${seeded.founderPassword}`);
    }
  }

  const app = await buildApp({
    db: createDb(pool),
    guardedDb,
    masterKey: config.security.masterKey,
    internalApiToken: config.security.internalApiToken,
    autologinFounder: config.security.autologinFounder,
    sandboxManagerUrl: config.sandbox.managerUrl,
    healthCheckers: buildCheckers({
      pool,
      natsUrl: config.nats.url,
      temporalAddress: config.temporal.address,
    }),
    version: process.env.npm_package_version ?? "0.0.0",
  });

  // Tool Gateway dispatch arm (T40): workspace tools execute via
  // sandbox-manager; the gateway stays the only caller (S3)
  const { createSandboxDispatchPort } = await import("./modules/tools/dispatch.js");
  app.toolDispatchPort = createSandboxDispatchPort({
    guardedDb,
    sandboxManagerUrl: config.sandbox.managerUrl,
    internalApiToken: config.security.internalApiToken,
    // B3': db.inspect must never be aimed at the platform DB (every company's rows)
    platformDatabaseUrl: config.database.url,
  });

  // message delivery signalling (11 §4.4, T33): best-effort Temporal client —
  // messages stay durable without it, agents just poll their thread slice
  let temporalClientRef: import("@temporalio/client").Client | null = null;
  try {
    const { Client, Connection } = await import("@temporalio/client");
    const temporalConnection = await Connection.connect({ address: config.temporal.address });
    const temporalClient = new Client({ connection: temporalConnection, namespace: "acos" });
    temporalClientRef = temporalClient;
    app.commsSignalPort = {
      async signalActiveSession({ workflowId, item }) {
        try {
          await temporalClient.workflow.getHandle(workflowId).signal("messageReceived", item);
          return true;
        } catch {
          return false;
        }
      },
      async signalInbox({ companyId, agentId, item }) {
        await temporalClient.workflow.signalWithStart("agentInboxWorkflow", {
          taskQueue: "agent-tasks",
          workflowId: `agent-inbox.${agentId}`,
          args: [{ companyId, agentId }],
          signal: "inboxItem",
          signalArgs: [item],
        });
      },
    };
    app.approvalSignalPort = async ({ workflowId, approvalId, verdict, note }) => {
      try {
        await temporalClient.workflow
          .getHandle(workflowId)
          .signal("approvalVerdict", { approvalId, verdict, note });
        return true;
      } catch (err) {
        // workflow already finished/cancelled — the DB verdict stays authoritative (19 §7)
        app.log.warn({ err, workflowId, approvalId }, "approvalVerdict signal undeliverable");
        return false;
      }
    };
    const { createAgentWorkflowStarter } = await import("./modules/workflows/client.js");
    app.agentWorkflowStarter = createAgentWorkflowStarter(temporalClient, (err, input) =>
      app.log.warn({ err, ...input }, "agentTaskWorkflow start failed"),
    );
    // project creation → projectIntakeWorkflow on the intake queue (T42)
    app.intakeStarter = async ({ companyId, projectId, source }) => {
      await temporalClient.workflow
        .start("projectIntakeWorkflow", {
          taskQueue: "intake",
          workflowId: `intake.${projectId}`,
          args: [{ companyId, projectId, source }],
        })
        .catch((err: unknown) => {
          if ((err as { name?: string }).name !== "WorkflowExecutionAlreadyStartedError") {
            throw err;
          }
        });
    };
    app.log.info("comms delivery signal port attached (Temporal)");
  } catch (err) {
    app.log.error({ err }, "Temporal unavailable — comms delivery signalling disabled");
  }

  // cost rollup refresh (26 §7, T49): every 5 min — the server interval is a
  // recorded narrowing of the Temporal-cron scheduler activity
  const { sql: rawSql } = await import("drizzle-orm");
  const rollupDb = createDb(pool);
  const rollupRefresh = setInterval(() => {
    rollupDb
      .execute(rawSql`REFRESH MATERIALIZED VIEW cost_rollup_daily`)
      .catch((err) => app.log.error({ err }, "cost rollup refresh failed"));
  }, 300_000);

  // retrieval-count batch (12 §7.4, T45): every 60s aggregate UNLOGGED
  // memory_retrievals into memories.retrieval_count + 14-day sweep
  const { applyRetrievalCounts } = await import("@acos/db");
  const retrievalDb = createDb(pool);
  const retrievalBatch = setInterval(() => {
    applyRetrievalCounts(retrievalDb).catch((err) =>
      app.log.error({ err }, "retrieval-count batch failed"),
    );
  }, 60_000);

  // approval expiry + reminder sweep (19 §6, T35): every 30s; expired rows
  // deliver verdict `expired` (= rejected semantics) into waiting workflows
  const { sweepApprovals } = await import("@acos/db");
  const sweepDb = createDb(pool);
  const approvalSweep = setInterval(() => {
    void (async () => {
      const result = await sweepApprovals(sweepDb, guardedDb);
      for (const expired of result.expired) {
        if (expired.workflowId && app.approvalSignalPort) {
          await app.approvalSignalPort({
            workflowId: expired.workflowId,
            approvalId: expired.approvalId,
            verdict: "expired",
          });
        }
      }
    })().catch((err) => app.log.error({ err }, "approval sweep failed"));
  }, 30_000);

  const nats = await natsConnect({ servers: config.nats.url }).catch((err: unknown) => {
    app.log.error({ err }, "NATS unavailable at boot — outbox relay disabled");
    return null;
  });
  let relay: OutboxRelay | null = null;
  let dlq: DlqHandler | null = null;
  let memoryTrigger: import("./modules/memory/trigger.js").MemoryTriggerHandle | null = null;
  let breakerConsumer:
    | import("./modules/costs/breaker-consumer.js").BreakerConsumerHandle
    | null = null;
  if (nats) {
    app.attachOfficeNats?.(nats); // projector publishes office.* (T25)
    app.realtime?.attachNats(nats); // /ws live fanout (T23)
    await provisionJetStream(nats);
    relay = new OutboxRelay({
      connectionString: config.database.url,
      nats,
      onError: (err) => app.log.error({ err }, "outbox relay error"),
    });
    await relay.start();
    dlq = new DlqHandler(nats, createDb(pool));
    await dlq.start();
    app.log.info("outbox relay + DLQ handler started");

    // 12 §5.0 triggers → memoryConsolidationWorkflow (T44/M1) — rides the T21
    // memory-trigger durable; the deterministic workflow id
    // `memory-consolidation-<companyId>-<triggerRef>` dedupes (12 §5)
    if (temporalClientRef) {
      const temporalClient = temporalClientRef;
      const { startMemoryTrigger } = await import("./modules/memory/trigger.js");
      const { ExecutiveReportService, companyContext: reportCtx } = await import("@acos/db");
      const { CompanyService } = await import("./modules/companies/service.js");
      const reportService = new ExecutiveReportService(guardedDb);
      const companyService = new CompanyService(guardedDb);
      memoryTrigger = await startMemoryTrigger({
        nats,
        // demo 23–24 (T49): terminal task → project-completion check → the
        // CEO's executive report (artifact + Founder DM)
        onTaskTerminal: async ({ companyId, taskId }) => {
          await reportService
            .onTaskTerminal(reportCtx(companyId), taskId)
            .catch((err) => app.log.error({ err, taskId }, "executive report hook failed"));
        },
        // 12 §5.0 row 2: N comes from the existing company setting, not a new one
        thresholdFor: async (companyId) => {
          const settings = await companyService.getSettings(reportCtx(companyId));
          return settings?.consolidationEventThreshold ?? 25;
        },
        start: async ({ companyId, taskId, agentId, sourceEventIds, trigger, triggerRef }) => {
          await temporalClient.workflow
            .start("memoryConsolidationWorkflow", {
              taskQueue: "memory",
              workflowId: `memory-consolidation-${companyId}-${triggerRef}`,
              args: [{ companyId, taskId, agentId, sourceEventIds, trigger }],
            })
            .catch((err: unknown) => {
              if ((err as { name?: string }).name !== "WorkflowExecutionAlreadyStartedError") {
                throw err;
              }
            });
        },
        onError: (err) => app.log.error({ err }, "memory-trigger consumer error"),
      });
      app.log.info("memory-trigger consumer started");

      // 26 §5 madde 3: kesicinin ikinci yarısı — koşan oturumlara
      // managerDirective(pause). Veritabanı yarısı (agents → paused)
      // CostService.tripBreaker'da; o satırı koşan workflow okumadığı için
      // kesici tek başına bir sonraki adımı durdurmuyordu.
      const { startBreakerConsumer } = await import("./modules/costs/breaker-consumer.js");
      const { agentSessions } = await import("@acos/db/schema");
      const { and: sqlAnd, eq: sqlEq, inArray, sql: rawSql } = await import("drizzle-orm");
      // workflow id'yi yeniden kurmuyoruz: oturum satırı onu zaten taşıyor
      // (agent_sessions.workflow_id NOT NULL), yani kimlik kuralı değişse
      // bile sinyal doğru workflow'a gider.
      const liveSessions = async (companyId: string, agentIds: string[]) =>
        agentIds.length === 0
          ? []
          : guardedDb
              .select({ workflowId: agentSessions.workflowId, agentId: agentSessions.agentId })
              .from(agentSessions)
              .where(
                sqlAnd(
                  sqlEq(agentSessions.companyId, companyId),
                  inArray(agentSessions.agentId, agentIds),
                  rawSql`${agentSessions.status} IN ('starting','running','waiting')`,
                ),
              );
      breakerConsumer = await startBreakerConsumer({
        nats,
        signal: async ({ companyId, agentIds, directive, reason }) => {
          for (const session of await liveSessions(companyId, agentIds)) {
            if (!session.workflowId) continue;
            await temporalClient.workflow
              .getHandle(session.workflowId)
              .signal("managerDirective", { directive, reason })
              // bitmiş/hiç başlamamış workflow: ajan satırı zaten paused,
              // yeni başlatmalar onu görür (26 §5 "new workflow starts refused")
              .catch((err: unknown) =>
                app.log.debug({ err, agentId: session.agentId }, "managerDirective undeliverable"),
              );
          }
        },
        // budget.restored: kesicinin duraklattıkları restoreBudget içinde zaten
        // `active`e döndü; sinyal onların park edilmiş döngülerini uyandırır.
        // Zaten koşan bir döngüye resume göndermek etkisiz — güvenli.
        resumedAgentIds: async (companyId) => {
          const rows = await guardedDb
            .select({ id: agentSessions.agentId })
            .from(agentSessions)
            .where(
              sqlAnd(
                sqlEq(agentSessions.companyId, companyId),
                rawSql`${agentSessions.status} IN ('starting','running','waiting')`,
              ),
            );
          return [...new Set(rows.map((r) => r.id))];
        },
        onError: (err) => app.log.error({ err }, "breaker consumer error"),
      });
      app.log.info("cost circuit-breaker consumer started");
    }
  }

  const close = async () => {
    clearInterval(approvalSweep);
    clearInterval(retrievalBatch);
    clearInterval(rollupRefresh);
    await memoryTrigger?.stop().catch(() => {});
    await breakerConsumer?.stop().catch(() => {});
    await relay?.stop();
    await dlq?.stop();
    await nats?.close().catch(() => {});
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);

  await app.listen({ port: config.serverPort, host: "0.0.0.0" });
  app.log.info({ port: config.serverPort }, "ACOS server up");
}

main().catch((err) => {
  console.error("server boot failed:", err);
  process.exit(1);
});
