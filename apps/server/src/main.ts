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
    healthCheckers: buildCheckers({
      pool,
      natsUrl: config.nats.url,
      temporalAddress: config.temporal.address,
    }),
    version: process.env.npm_package_version ?? "0.0.0",
  });

  const nats = await natsConnect({ servers: config.nats.url }).catch((err: unknown) => {
    app.log.error({ err }, "NATS unavailable at boot — outbox relay disabled");
    return null;
  });
  let relay: OutboxRelay | null = null;
  let dlq: DlqHandler | null = null;
  if (nats) {
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
