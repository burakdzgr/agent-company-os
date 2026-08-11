// agent-worker boot (T31; 09 §3, §4.1 canonical shape): three Temporal
// workers in one unprivileged container — agent-tasks (workflows + control-
// plane activities), memory and intake (own queues for blast-radius
// isolation). Plus the /healthz endpoint compose healthchecks rely on.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { NativeConnection, Worker } from "@temporalio/worker";
import { loadConfigOrExit, TASK_QUEUES } from "@acos/config";
import * as activities from "./activities/index.js";

const require = createRequire(import.meta.url);

async function run(): Promise<void> {
  const config = loadConfigOrExit(process.env);

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

  const connection = await NativeConnection.connect({ address: config.temporal.address });

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
  const intakeWorker = await Worker.create({
    connection,
    namespace: "acos",
    taskQueue: TASK_QUEUES.intake,
    workflowsPath: require.resolve("./workflows/intake/index.js"),
    activities: {}, // analysis orchestration activities land with T42
    maxConcurrentActivityTaskExecutions: 4,
    shutdownGraceTime: "30s",
  });

  ready = true;
  console.log(
    JSON.stringify({
      msg: "agent-worker up",
      queues: [TASK_QUEUES.agentTasks, TASK_QUEUES.memory, TASK_QUEUES.intake],
      temporal: config.temporal.address,
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
  health.close();
}

run().catch((err) => {
  console.error("agent-worker boot failed:", err);
  process.exit(1);
});
