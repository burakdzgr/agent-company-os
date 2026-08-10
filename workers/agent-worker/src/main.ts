// Hello-world agent-worker stub (T05). Temporal worker registration on the
// agent-tasks/memory/intake queues lands in T31; this only serves the
// /healthz endpoint compose healthchecks rely on (27 §14).
import { createServer } from "node:http";

const port = Number(process.env.HEALTH_PORT ?? 3020);

createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "agent-worker" }));
    return;
  }
  res.writeHead(404).end();
}).listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ msg: "agent-worker stub listening", port }));
});
