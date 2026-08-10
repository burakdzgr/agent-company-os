// Hello-world control-plane stub (T05). The real boot sequence
// (config -> migrate under advisory lock -> modules/routes) lands in T15;
// GET /api/health with aggregated dependency checks lands there too.
import Fastify from "fastify";

const app = Fastify({ logger: true });

app.get("/healthz", () => ({ status: "ok", service: "server" }));

const port = Number(process.env.SERVER_PORT ?? 3000);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
