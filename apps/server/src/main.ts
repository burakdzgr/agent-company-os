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
  });

  // message delivery signalling (11 §4.4, T33): best-effort Temporal client —
  // messages stay durable without it, agents just poll their thread slice
  try {
    const { Client, Connection } = await import("@temporalio/client");
    const temporalConnection = await Connection.connect({ address: config.temporal.address });
    const temporalClient = new Client({ connection: temporalConnection, namespace: "acos" });
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
  }

  const close = async () => {
    clearInterval(approvalSweep);
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
