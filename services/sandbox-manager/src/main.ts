// Hello-world sandbox-manager stub (T05). dockerode lifecycle, PTY exec and
// NATS frame publishing land in T37; this only serves /healthz (27 §14).
import Fastify from "fastify";

const app = Fastify({ logger: true });

app.get("/healthz", () => ({ status: "ok", service: "sandbox-manager" }));

const port = Number(process.env.SANDBOX_MANAGER_PORT ?? 3010);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
