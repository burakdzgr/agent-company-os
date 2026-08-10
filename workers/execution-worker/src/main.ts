// Hello-world execution-worker stub (T05). The activities-only Temporal
// worker on the execution queue lands in T40; this only serves the
// /healthz endpoint compose healthchecks rely on (27 §14).
import { createServer } from "node:http";

const port = Number(process.env.HEALTH_PORT ?? 3021);

createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "execution-worker" }));
    return;
  }
  res.writeHead(404).end();
}).listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ msg: "execution-worker stub listening", port }));
});
