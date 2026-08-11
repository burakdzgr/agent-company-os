// T23 acceptance — WS replay: connect, receive live flow, drop the socket,
// mutate while disconnected, reconnect with `resume after_seq` ⇒ the exact gap
// is replayed from the events table and the stream continues live with no
// gaps or duplicates. Plus: auth (cookie + ?pat=), topic authorization,
// ping/pong, bad ops.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { connect, type NatsConnection } from "nats";
import WebSocket from "ws";
import { createDb, createGuardedDb, runMigrations, type Db, type GuardedDb } from "@acos/db";
import { buildApp, type App } from "../../src/app.js";
import { OutboxRelay } from "../../src/modules/events/relay.js";
import { ensureStream } from "../../src/modules/events/jetstream.js";
import { startNats, startPostgres, type StartedPostgreSqlContainer } from "./helpers";

const MASTER_KEY = Buffer.alloc(32, 11).toString("base64");
const ok = async () => {};

let pgContainer: StartedPostgreSqlContainer;
let natsHandle: Awaited<ReturnType<typeof startNats>>;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let nc: NatsConnection;
let relay: OutboxRelay;
let app: App;
let baseUrl = "";
let wsUrl = "";
let sessionCookie = "";
let csrfToken = "";
let companyId = "";

const authHeaders = () => ({
  cookie: `acos_session=${sessionCookie}; acos_csrf=${csrfToken}`,
  "x-csrf-token": csrfToken,
});

async function api(method: "GET" | "POST" | "PATCH", url: string, payload?: unknown) {
  const response = await app.inject({
    method,
    url,
    headers: authHeaders(),
    ...(payload !== undefined && { payload: payload as Record<string, unknown> }),
  });
  expect(response.statusCode, `${method} ${url} → ${response.body}`).toBeLessThan(300);
  return response.json();
}

/** Tiny promise-based WS test client: frames arrive into a queue. */
class WsProbe {
  readonly frames: unknown[] = [];
  readonly socket: WebSocket;
  closed: Promise<{ code: number }>;

  constructor(headers?: Record<string, string>, urlSuffix = "") {
    this.socket = new WebSocket(`${wsUrl}${urlSuffix}`, { headers: headers ?? {} });
    this.socket.on("message", (raw) => this.frames.push(JSON.parse(String(raw))));
    this.closed = new Promise((resolve) => {
      this.socket.on("close", (code) => resolve({ code }));
    });
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  /** Waits until a frame matching the predicate has arrived; returns it. */
  async expectFrame<T>(predicate: (f: unknown) => boolean, timeoutMs = 10_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.frames.find(predicate);
      if (hit !== undefined) return hit as T;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`expected frame not received; got ${JSON.stringify(this.frames)}`);
  }

  /** All event seqs received on a topic, in arrival order. */
  eventSeqs(topic: string): number[] {
    return this.frames
      .filter((f): f is { topic: string; events: Array<{ seq: number }> } => {
        const frame = f as { topic?: string; events?: unknown };
        return frame.topic === topic && Array.isArray(frame.events);
      })
      .flatMap((f) => f.events.map((e) => e.seq));
  }

  close(): void {
    this.socket.terminate();
  }
}

let settingsFlip = false;
/** One mutation = exactly one outbox event (company.settings.updated). */
async function mutate(): Promise<void> {
  settingsFlip = !settingsFlip;
  await api("PATCH", `/api/v1/companies/${companyId}/settings`, {
    timezone: settingsFlip ? "Europe/Istanbul" : "UTC",
  });
}

beforeAll(async () => {
  [pgContainer, natsHandle] = await Promise.all([startPostgres(), startNats()]);
  await runMigrations(pgContainer.getConnectionUri());
  pool = new Pool({ connectionString: pgContainer.getConnectionUri() });
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);
  nc = await connect({ servers: natsHandle.url });
  await ensureStream(await nc.jetstreamManager());

  app = await buildApp({
    healthCheckers: { postgres: ok, nats: ok, temporal: ok },
    logger: false,
    db,
    guardedDb,
    masterKey: MASTER_KEY,
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
  wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  void baseUrl;

  app.realtime!.attachNats(nc);
  relay = new OutboxRelay({ connectionString: pgContainer.getConnectionUri(), nats: nc });
  await relay.start();

  const setup = await app.inject({
    method: "POST",
    url: "/api/v1/auth/setup",
    payload: { email: "founder@ws.local", password: "correct-horse-battery", displayName: "F" },
  });
  for (const c of setup.cookies) {
    if (c.name === "acos_session") sessionCookie = c.value;
    if (c.name === "acos_csrf") csrfToken = c.value;
  }
  const company = await api("POST", "/api/v1/companies", {
    name: "WsCo",
    slug: "wsco",
    currency: "USD",
  });
  companyId = company.id; // events so far: seq 1 company.created, 2 member.added
}, 240_000);

afterAll(async () => {
  await relay?.stop();
  await app?.close();
  await nc?.close().catch(() => {});
  await pool?.end();
  await pgContainer?.stop();
  await natsHandle?.container.stop();
});

describe("/ws gateway (T23)", () => {
  it("rejects unauthenticated upgrades with close 4401", async () => {
    const probe = new WsProbe();
    const { code } = await probe.closed;
    expect(code).toBe(4401);
  });

  it("connect → live flow → drop → resume after_seq ⇒ exact gap replay, then live", async () => {
    const topic = `events:${companyId}`;

    // -- connect + subscribe (from now) --
    const probe = new WsProbe({ cookie: `acos_session=${sessionCookie}` });
    await probe.expectFrame((f) => (f as { op?: string }).op === "hello");
    probe.send({ op: "subscribe", topics: [topic] });
    const subOk = await probe.expectFrame<{ current_seq: number; mode: string }>(
      (f) => (f as { op?: string }).op === "sub_ok",
    );
    expect(subOk.mode).toBe("live");
    const head = subOk.current_seq; // 2 (created + member.added)
    expect(head).toBeGreaterThanOrEqual(2);

    // -- live delivery through outbox → relay → NATS → gateway --
    await mutate(); // seq head+1
    await probe.expectFrame(
      (f) => (f as { topic?: string; seq?: number }).topic === topic && (f as { seq: number }).seq === head + 1,
    );
    expect(probe.eventSeqs(topic)).toEqual([head + 1]);

    // -- drop, mutate twice while disconnected (the gap), reconnect + resume --
    probe.close();
    await probe.closed;
    await mutate(); // head+2
    await mutate(); // head+3

    const probe2 = new WsProbe({ cookie: `acos_session=${sessionCookie}` });
    await probe2.expectFrame((f) => (f as { op?: string }).op === "hello");
    probe2.send({ op: "resume", topic, after_seq: head + 1 });
    const resumeOk = await probe2.expectFrame<{ mode: string; current_seq: number }>(
      (f) => (f as { op?: string }).op === "sub_ok",
    );
    expect(resumeOk.mode).toBe("replay");
    const replayDone = await probe2.expectFrame<{ up_to_seq: number }>(
      (f) => (f as { op?: string }).op === "replay_done",
    );
    expect(replayDone.up_to_seq).toBeGreaterThanOrEqual(head + 3);
    // the exact gap — nothing before the cursor, nothing missing after it
    expect(probe2.eventSeqs(topic)).toEqual([head + 2, head + 3]);

    // -- live continues after replay with no gap or duplicate --
    await mutate(); // head+4
    await probe2.expectFrame(
      (f) => (f as { topic?: string; seq?: number }).topic === topic && (f as { seq: number }).seq === head + 4,
    );
    const all = probe2.eventSeqs(topic);
    expect(all).toEqual([head + 2, head + 3, head + 4]);

    // envelopes carry the persisted event shape (id + type + payload)
    const frame = probe2.frames.find((f) => {
      const candidate = f as { topic?: string; events?: unknown };
      return candidate.topic === topic && Array.isArray(candidate.events);
    }) as { events: Array<{ id: string; type: string; seq: number }> };
    expect(frame.events[0]!.id).toBeTruthy();
    expect(frame.events[0]!.type).toBe("company.settings.updated");
    probe2.close();
  });

  it("refuses topics for companies the user is not a member of", async () => {
    const probe = new WsProbe({ cookie: `acos_session=${sessionCookie}` });
    await probe.expectFrame((f) => (f as { op?: string }).op === "hello");
    probe.send({ op: "subscribe", topics: ["events:018f0000-0000-7000-8000-00000000dead"] });
    const error = await probe.expectFrame<{ code: string }>(
      (f) => (f as { op?: string }).op === "error",
    );
    expect(error.code).toBe("forbidden_topic");
    // terminal topics resolve session→company; unknown session fails closed
    probe.send({ op: "subscribe", topics: ["terminal:018f0000-0000-7000-8000-00000000beef"] });
    const terminalError = await probe.expectFrame<{ code: string; topic: string }>(
      (f) =>
        (f as { op?: string; topic?: string }).op === "error" &&
        (f as { topic?: string }).topic?.startsWith("terminal:") === true,
    );
    expect(terminalError.code).toBe("forbidden_topic");
    probe.close();
  });

  it("answers ping with pong and flags malformed ops", async () => {
    const probe = new WsProbe({ cookie: `acos_session=${sessionCookie}` });
    await probe.expectFrame((f) => (f as { op?: string }).op === "hello");
    probe.send({ op: "ping", t: 1712 });
    const pong = await probe.expectFrame<{ t: number }>((f) => (f as { op?: string }).op === "pong");
    expect(pong.t).toBe(1712);
    probe.send({ op: "warp" });
    const error = await probe.expectFrame<{ code: string }>(
      (f) => (f as { op?: string }).op === "error",
    );
    expect(error.code).toBe("bad_op");
    probe.close();
  });

  it("subscribes the presence topic with a snapshot-then-delta bootstrap", async () => {
    const probe = new WsProbe({ cookie: `acos_session=${sessionCookie}` });
    await probe.expectFrame((f) => (f as { op?: string }).op === "hello");
    probe.send({ op: "subscribe", topics: [`presence:${companyId}`] });
    const snapshot = await probe.expectFrame<{ state: { agents: unknown[] } }>(
      (f) => (f as { op?: string }).op === "snapshot",
    );
    expect(snapshot.state).toMatchObject({ layoutVersion: 0, agents: [], interactions: [] });
    probe.close();
  });

  it("authenticates CLI connections via ?pat= with read:events scope", async () => {
    const pat = await api("POST", "/api/v1/auth/pats", {
      name: "ws-probe",
      scopes: ["read:events"],
    });
    const good = new WsProbe(undefined, `?pat=${pat.token}`);
    await good.expectFrame((f) => (f as { op?: string }).op === "hello");
    good.send({ op: "subscribe", topics: [`events:${companyId}`] });
    await good.expectFrame((f) => (f as { op?: string }).op === "sub_ok");
    good.close();

    const scopeless = await api("POST", "/api/v1/auth/pats", {
      name: "ws-scopeless",
      scopes: ["read:tasks"],
    });
    const bad = new WsProbe(undefined, `?pat=${scopeless.token}`);
    const { code } = await bad.closed;
    expect(code).toBe(4401);
  });
});
