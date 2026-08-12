// T44 — the memory-trigger consumer (12 §5.0, 10 §5): a published terminal
// task event on the T21 durable starts memoryConsolidationWorkflow with the
// deterministic `memory-consolidation-<company>-task-<task>` id; non-task
// trigger kinds are acked without a start; redelivery is dedupe-safe because
// the starter swallows already-started.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, type NatsConnection } from "nats";
import { subjectFor } from "@acos/events";
import { provisionJetStream } from "../../src/modules/events/jetstream.js";
import {
  startMemoryTrigger,
  type ConsolidationStartInput,
  type MemoryTriggerHandle,
} from "../../src/modules/memory/trigger.js";
import { startNats } from "./helpers";

const COMPANY = "018f0000-0000-7000-8000-00000000aaaa";
const TASK = "018f0000-0000-7000-8000-00000000bbbb";

let natsHandle: Awaited<ReturnType<typeof startNats>>;
let nc: NatsConnection;
let trigger: MemoryTriggerHandle;
const started: ConsolidationStartInput[] = [];

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor timed out");
}

function envelope(type: string, taskId: string | null) {
  return JSON.stringify({
    id: crypto.randomUUID(),
    companyId: COMPANY,
    seq: 1,
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    actor: { kind: "system", id: null },
    subject: { taskId, projectId: null, agentId: null },
    correlationId: crypto.randomUUID(),
    causationId: null,
    payload: {},
  });
}

beforeAll(async () => {
  natsHandle = await startNats();
  nc = await connect({ servers: natsHandle.url });
  await provisionJetStream(nc);
  trigger = await startMemoryTrigger({
    nats: nc,
    start: async (input) => {
      started.push(input);
    },
    onError: (err) => console.error("trigger error:", err),
  });
}, 300_000);

afterAll(async () => {
  await trigger?.stop().catch(() => {});
  await nc?.close().catch(() => {});
  await natsHandle?.container.stop();
});

describe("memory-trigger consumer (T44)", { timeout: 30_000 }, () => {
  it("task.completed and task.failed start consolidation; other kinds ack silently", async () => {
    const js = nc.jetstream();
    await js.publish(subjectFor(COMPANY, "task.completed"), envelope("task.completed", TASK));
    await js.publish(subjectFor(COMPANY, "task.failed"), envelope("task.failed", TASK));
    // filtered subject the consumer also sees but must not start from (post-MVP kind)
    await js.publish(subjectFor(COMPANY, "agent.escalated"), envelope("agent.escalated", null));

    await waitFor(() => started.length >= 2);
    // give the escalation message time to be (wrongly) turned into a start
    await new Promise((r) => setTimeout(r, 500));
    expect(started).toHaveLength(2);
    expect(started[0]).toEqual({ companyId: COMPANY, taskId: TASK, trigger: "task_completed" });
    expect(started[1]).toEqual({ companyId: COMPANY, taskId: TASK, trigger: "task_failed" });
  });
});
