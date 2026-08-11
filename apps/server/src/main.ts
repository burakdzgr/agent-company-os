// Boot sequence (T15, 28 §2): config → migrate under advisory lock → routes.
import { Pool } from "pg";
import { loadConfigOrExit } from "@acos/config";
import { runMigrations } from "@acos/db";
import { buildApp } from "./app.js";
import { buildCheckers } from "./checkers.js";

async function main(): Promise<void> {
  const config = loadConfigOrExit(process.env);

  await runMigrations(config.database.url); // pg_advisory_lock inside — safe under multi-boot
  const pool = new Pool({ connectionString: config.database.url });

  const app = await buildApp({
    healthCheckers: buildCheckers({
      pool,
      natsUrl: config.nats.url,
      temporalAddress: config.temporal.address,
    }),
    version: process.env.npm_package_version ?? "0.0.0",
  });

  const close = async () => {
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
