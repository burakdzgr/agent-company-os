// memory-trigger consumer (T44; 10 §5, 12 §5.0). Drains the T21 durable
// JetStream consumer and starts one memoryConsolidationWorkflow per terminal
// task — workflow id `memory-consolidation-<company_id>-task-<task_id>` makes
// redelivery and double-publish harmless. Escalation/experiment/N-events
// triggers join with their owning tasks (T45+) [recorded MVP narrowing].
import type { NatsConnection } from "nats";
import { STREAM_NAME } from "../events/jetstream.js";

export interface ConsolidationStartInput {
  companyId: string;
  taskId: string;
  trigger: "task_completed" | "task_failed";
}

export interface MemoryTriggerOptions {
  nats: NatsConnection;
  /** starts memoryConsolidationWorkflow; must swallow already-started */
  start: (input: ConsolidationStartInput) => Promise<void>;
  /** T49: project-completion check + executive report on terminal tasks */
  onTaskTerminal?: ((input: { companyId: string; taskId: string }) => Promise<void>) | undefined;
  onError: (err: unknown) => void;
}

interface TriggerEnvelope {
  companyId?: string;
  type?: string;
  subject?: { taskId?: string | null };
}

export interface MemoryTriggerHandle {
  stop: () => Promise<void>;
}

export async function startMemoryTrigger(options: MemoryTriggerOptions): Promise<MemoryTriggerHandle> {
  const js = options.nats.jetstream();
  const consumer = await js.consumers.get(STREAM_NAME, "memory-trigger");
  const messages = await consumer.consume();

  const loop = (async () => {
    for await (const msg of messages) {
      try {
        const envelope = JSON.parse(msg.string()) as TriggerEnvelope;
        const taskId = envelope.subject?.taskId;
        if (
          envelope.companyId &&
          taskId &&
          (envelope.type === "task.completed" || envelope.type === "task.failed")
        ) {
          await options.start({
            companyId: envelope.companyId,
            taskId,
            trigger: envelope.type === "task.failed" ? "task_failed" : "task_completed",
          });
          // demo 23–24 (T49): the same terminal signal drives the
          // project-completion check + the CEO's executive report
          await options.onTaskTerminal?.({ companyId: envelope.companyId, taskId });
        }
        msg.ack(); // non-task triggers ack too (post-MVP kinds)
      } catch (err) {
        options.onError(err);
        msg.nak(5_000); // redeliver; max_deliver 5 → DLQ (T21)
      }
    }
  })().catch((err) => options.onError(err));

  return {
    stop: async () => {
      messages.stop();
      await loop;
    },
  };
}
