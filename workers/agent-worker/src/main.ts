// agent-worker boot (T31/T32; 09 §3, §4.1): three Temporal workers in one
// unprivileged container. Activities get real DB + ModelRouter deps;
// LLM_MODE=scripted swaps in the deterministic fake (32 §6) — used by the
// e2e/demo profile, never by default.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { eq } from "drizzle-orm";
import { NativeConnection, Worker } from "@temporalio/worker";
import { loadConfigOrExit, TASK_QUEUES, type Config } from "@acos/config";
import { createDb, createGuardedDb, type CompanyContext, type GuardedDb } from "@acos/db";
import { modelProviders } from "@acos/db/schema";
import {
  ModelRouter,
  createAnthropicAdapter,
  createOllamaAdapter,
  createOpenAiAdapter,
  createOpenRouterAdapter,
  type ProviderAdapter,
  type RoutingContext,
} from "@acos/llm";
import { createScriptedAdapter, loadScript } from "@acos/llm/testing";
import * as trivialActivities from "./activities/index.js";
import {
  createAgentTaskActivities,
  createDbRoutingLoader,
} from "./activities/agent-task.js";

const require = createRequire(import.meta.url);

interface RouterDeps {
  router: ModelRouter;
  routingFor: (ctx: CompanyContext, agentId: string) => Promise<RoutingContext>;
}

/** Scripted mode (32 §6): fake adapter behind a real model_providers row so
 *  llm_calls FKs stay honest. */
async function buildScriptedRouter(pool: Pool): Promise<RouterDeps> {
  const db = createDb(pool);
  const [existing] = await db
    .select()
    .from(modelProviders)
    .where(eq(modelProviders.name, "scripted"));
  const provider =
    existing ??
    (await db.insert(modelProviders).values({ kind: "ollama", name: "scripted" }).returning())[0]!;

  const scriptsDir = join(dirname(require.resolve("@acos/llm/package.json")), "testing/scripts");
  const scripts = readdirSync(scriptsDir)
    .filter((f) => f.endsWith(".yaml"))
    .map((f) => loadScript(readFileSync(join(scriptsDir, f), "utf8")));
  const adapter: ProviderAdapter = { ...createScriptedAdapter(scripts), providerId: provider.id };
  return {
    router: new ModelRouter({
      providers: new Map([[provider.id, adapter]]),
      logCall: () => {},
    }),
    routingFor: async () => ({
      bindings: [],
      profiles: [{ purpose: "reasoning", providerId: provider.id, model: "scripted" }],
    }),
  };
}

/** Prod: adapters per model_providers row (keyed by row id — what profiles
 *  and bindings reference), transports from config keys. */
async function buildLiveRouter(pool: Pool, guardedDb: GuardedDb, config: Config): Promise<RouterDeps> {
  const db = createDb(pool);
  const rows = await db.select().from(modelProviders).where(eq(modelProviders.enabled, true));
  const providers = new Map<string, ProviderAdapter>();
  for (const row of rows) {
    let adapter: ProviderAdapter | null = null;
    if (row.kind === "anthropic" && config.llm.anthropicApiKey) {
      adapter = createAnthropicAdapter({ providerId: row.id, apiKey: config.llm.anthropicApiKey });
    } else if (row.kind === "openai" && config.llm.openaiApiKey) {
      adapter = createOpenAiAdapter({ providerId: row.id, apiKey: config.llm.openaiApiKey });
    } else if (row.kind === "openrouter" && config.llm.openrouterApiKey) {
      adapter = { ...createOpenRouterAdapter({ apiKey: config.llm.openrouterApiKey }), providerId: row.id };
    } else if ((row.kind === "ollama" || row.kind === "vllm") && config.llm.ollamaBaseUrl) {
      adapter = { ...createOllamaAdapter({ baseUrl: config.llm.ollamaBaseUrl }), providerId: row.id };
    }
    if (adapter) providers.set(row.id, adapter);
  }
  return {
    router: new ModelRouter({ providers, logCall: () => {} }),
    routingFor: createDbRoutingLoader(guardedDb),
  };
}

async function run(): Promise<void> {
  const config = loadConfigOrExit(process.env);
  // Tool Gateway endpoint (17 §1): compose-internal, never the public proxy
  const serverInternalUrl = process.env.SERVER_INTERNAL_URL ?? "http://server:3000";

  const port = Number(process.env.HEALTH_PORT ?? 3020);
  let ready = false;
  const health = createServer((req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: ready ? "ok" : "starting", service: "agent-worker" }));
      return;
    }
    res.writeHead(404).end();
  });
  health.listen(port, "0.0.0.0");

  const pool = new Pool({ connectionString: config.database.url });
  const guardedDb = createGuardedDb(pool);
  // migrations run in the server's boot — retry briefly on a fresh database
  // (compose also orders worker after server-healthy; this covers races)
  let routerDeps: RouterDeps | null = null;
  for (let attempt = 1; attempt <= 10 && !routerDeps; attempt++) {
    try {
      routerDeps =
        process.env.LLM_MODE === "scripted"
          ? await buildScriptedRouter(pool)
          : await buildLiveRouter(pool, guardedDb, config);
    } catch (err) {
      if (attempt === 10) throw err;
      console.log(JSON.stringify({ msg: "router bootstrap retry", attempt, err: String(err) }));
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  const { router, routingFor } = routerDeps!;

  const connection = await NativeConnection.connect({ address: config.temporal.address });
  const { Connection: ClientConnection, Client } = await import("@temporalio/client");
  const clientConnection = await ClientConnection.connect({ address: config.temporal.address });
  const temporalClient = new Client({ connection: clientConnection, namespace: "acos" });
  const { createTemporalSignalPort } = await import("./delivery.js");
  const { startAgentTaskWorkflow, workflowIds } = await import("./client.js");
  const { uuidv7 } = await import("@acos/domain");
  const { createReviewActivities } = await import("./review/activities.js");

  // shared seams (T40/T43): the gateway client + review workflow starter
  const invokeTool = async (req: object) => {
    const res = await fetch(`${serverInternalUrl}/internal/v1/tools/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.security.internalApiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      throw new Error(`tool gateway transport failure: ${res.status}`);
    }
    return (await res.json()) as Awaited<
      ReturnType<NonNullable<Parameters<typeof createAgentTaskActivities>[0]["invokeTool"]>>
    >;
  };
  const startReviewWorkflow = async (input: {
    companyId: string;
    reviewId: string;
    taskId: string;
    reviewerAgentId: string;
    authorAgentId: string;
  }) => {
    await temporalClient.workflow
      .start("reviewWorkflow", {
        taskQueue: TASK_QUEUES.agentTasks,
        workflowId: workflowIds.review(input.reviewId),
        args: [input],
      })
      .catch((err: unknown) => {
        if ((err as { name?: string }).name !== "WorkflowExecutionAlreadyStartedError") throw err;
      });
  };

  const activities = {
    ...trivialActivities,
    ...createAgentTaskActivities({
      guardedDb,
      router,
      routingFor,
      signalPort: createTemporalSignalPort(temporalClient),
      // delegation → child workflow start (09 §4, T36); duplicate = no-op
      startAgentWorkflow: async ({ companyId, agentId, taskId }) => {
        await startAgentTaskWorkflow(temporalClient, "agentTaskWorkflow", {
          companyId,
          agentId,
          taskId,
          sessionId: uuidv7(),
          attempt: 1,
        }).catch((err: unknown) => {
          if ((err as { name?: string }).name !== "WorkflowExecutionAlreadyStartedError") throw err;
        });
      },
      // use_tool → Tool Gateway internal HTTP (T40; S3 single choke point)
      invokeTool,
      // request_review → independent reviewer's reviewWorkflow (T43)
      startReviewWorkflow,
    }),
    ...createReviewActivities({
      guardedDb,
      invokeTool,
      startReviewWorkflow,
      // rework re-entry with the verdict pre-seeded (T43): the prior run
      // closed at request_review — the deterministic id is REUSED
      startAgentWorkflow: async ({ companyId, agentId, taskId, initialReviewVerdict }) => {
        await startAgentTaskWorkflow(
          temporalClient,
          "agentTaskWorkflow",
          {
            companyId,
            agentId,
            taskId,
            sessionId: uuidv7(),
            attempt: 1,
            ...(initialReviewVerdict && { initialReviewVerdict }),
          },
          { allowReentry: true },
        ).catch((err: unknown) => {
          if ((err as { name?: string }).name !== "WorkflowExecutionAlreadyStartedError") throw err;
        });
      },
    }),
  };

  const agentWorker = await Worker.create({
    connection,
    namespace: "acos",
    taskQueue: TASK_QUEUES.agentTasks,
    workflowsPath: require.resolve("./workflows/index.js"),
    activities,
    maxConcurrentWorkflowTaskExecutions: 40,
    maxConcurrentActivityTaskExecutions: 64,
    maxCachedWorkflows: 200,
    shutdownGraceTime: "30s",
  });
  const memoryWorker = await Worker.create({
    connection,
    namespace: "acos",
    taskQueue: TASK_QUEUES.memory,
    workflowsPath: require.resolve("./workflows/memory/index.js"),
    activities: {}, // embedding/extraction activities land with T44
    maxConcurrentActivityTaskExecutions: 8,
    shutdownGraceTime: "30s",
  });
  const { createIntakeControlActivities } = await import("./intake/activities.js");
  const intakeWorker = await Worker.create({
    connection,
    namespace: "acos",
    taskQueue: TASK_QUEUES.intake,
    workflowsPath: require.resolve("./workflows/intake/index.js"),
    activities: createIntakeControlActivities({
      guardedDb,
      // routed GOAL → CEO agentTaskWorkflow (09 §4, same port as T36)
      startAgentWorkflow: async ({ companyId, agentId, taskId }) => {
        await startAgentTaskWorkflow(temporalClient, "agentTaskWorkflow", {
          companyId,
          agentId,
          taskId,
          sessionId: uuidv7(),
          attempt: 1,
        }).catch((err: unknown) => {
          if ((err as { name?: string }).name !== "WorkflowExecutionAlreadyStartedError") throw err;
        });
      },
    }),
    maxConcurrentActivityTaskExecutions: 4,
    shutdownGraceTime: "30s",
  });

  ready = true;
  console.log(
    JSON.stringify({
      msg: "agent-worker up",
      queues: [TASK_QUEUES.agentTasks, TASK_QUEUES.memory, TASK_QUEUES.intake],
      temporal: config.temporal.address,
      llmMode: process.env.LLM_MODE === "scripted" ? "scripted" : "live",
      healthPort: port,
    }),
  );

  const shutdown = () => {
    ready = false;
    agentWorker.shutdown();
    memoryWorker.shutdown();
    intakeWorker.shutdown();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await Promise.all([agentWorker.run(), memoryWorker.run(), intakeWorker.run()]);
  await connection.close();
  await pool.end();
  health.close();
}

run().catch((err) => {
  console.error("agent-worker boot failed:", err);
  process.exit(1);
});
