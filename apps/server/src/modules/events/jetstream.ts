// JetStream topology (10 §5): ACOS_EVENTS stream + durable pull consumers.
import {
  AckPolicy,
  DeliverPolicy,
  RetentionPolicy,
  StorageType,
  DiscardPolicy,
  type JetStreamManager,
  type NatsConnection,
} from "nats";

export const STREAM_NAME = "ACOS_EVENTS";
const HOUR_NS = 3_600_000_000_000;
const SECOND_NS = 1_000_000_000;

export const DURABLE_CONSUMERS: Array<{ name: string; filters: string[] }> = [
  { name: "office-projector", filters: ["co.*.agent.>", "co.*.task.>", "co.*.approval.>"] },
  {
    name: "memory-trigger",
    filters: [
      "co.*.task.completed",
      "co.*.task.failed",
      "co.*.agent.escalated",
      "co.*.review.completed",
    ],
  },
  { name: "cost-aggregator", filters: ["co.*.task.>", "co.*.budget.>"] },
  {
    name: "notification",
    filters: [
      "co.*.approval.>",
      "co.*.agent.escalated",
      "co.*.security.alert",
      "co.*.budget.exceeded",
      "co.*.task.deadline.missed",
    ],
  },
];

export async function ensureStream(jsm: JetStreamManager): Promise<void> {
  const config = {
    name: STREAM_NAME,
    subjects: ["co.*.>"],
    storage: StorageType.File,
    num_replicas: 1,
    retention: RetentionPolicy.Limits,
    max_age: 72 * HOUR_NS, // working retention; replay truth is the events table
    discard: DiscardPolicy.Old,
    duplicate_window: 120 * SECOND_NS, // Nats-Msg-Id = event id
  };
  try {
    await jsm.streams.info(STREAM_NAME);
    await jsm.streams.update(STREAM_NAME, config);
  } catch {
    await jsm.streams.add(config);
  }
}

export async function ensureDurableConsumers(
  jsm: JetStreamManager,
  overrides?: { ackWaitNs?: number; maxDeliver?: number },
): Promise<void> {
  for (const consumer of DURABLE_CONSUMERS) {
    const config = {
      durable_name: consumer.name,
      ack_policy: AckPolicy.Explicit,
      ack_wait: overrides?.ackWaitNs ?? 30 * SECOND_NS,
      max_deliver: overrides?.maxDeliver ?? 5,
      deliver_policy: DeliverPolicy.All,
      filter_subjects: consumer.filters,
    };
    try {
      await jsm.consumers.info(STREAM_NAME, consumer.name);
    } catch {
      await jsm.consumers.add(STREAM_NAME, config);
    }
  }
}

export async function provisionJetStream(nc: NatsConnection): Promise<void> {
  const jsm = await nc.jetstreamManager();
  await ensureStream(jsm);
  await ensureDurableConsumers(jsm);
}
