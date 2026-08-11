// agentTaskWorkflow core loop (08 §1–2, T32): build Working Set → call LLM →
// strict AgentAction parse (2 bounded repairs, then a synthesized abandon of
// the step via a failed observation) → execute → persist → next. Signals /
// wait_for land with T33; the six guards + continueAsNew with T34 (a hard
// safety stop at 60 steps protects until then). Pure orchestration — every
// side effect is an activity; stepId = uuidv5(String(stepNo), sessionId) is
// deterministic and replay-safe (08 §2).
import { proxyActivities, workflowInfo } from "@temporalio/workflow";
import { uuidv5 } from "@acos/domain";
import { AgentActionSchema, type AgentAction } from "@acos/llm/agent-action";
import type { createAgentTaskActivities } from "../activities/agent-task.js";
import type { LlmMessage } from "@acos/llm";

const activities = proxyActivities<ReturnType<typeof createAgentTaskActivities>>({
  startToCloseTimeout: "120s", // LLM class ceiling; fast DB ops finish well under
  retry: { maximumAttempts: 3, initialInterval: "2s", maximumInterval: "60s" },
});

export interface AgentTaskInput {
  companyId: string;
  agentId: string;
  taskId: string;
  sessionId: string;
  attempt: number;
}

export interface AgentTaskOutcome {
  outcome: "review_requested" | "completed" | "abandoned" | "step_limit";
  steps: number;
}

const MAX_REPAIRS = 2;
const HARD_STEP_STOP = 60; // T34 replaces with guard (c) + continueAsNew

export async function agentTaskWorkflow(input: AgentTaskInput): Promise<AgentTaskOutcome> {
  const info = workflowInfo();
  const ref = {
    companyId: input.companyId,
    agentId: input.agentId,
    taskId: input.taskId,
    sessionId: input.sessionId,
  };
  await activities.startAgentSessionActivity({
    ...ref,
    workflowId: info.workflowId,
    runId: info.runId,
    attempt: input.attempt,
  });

  let stepNo = 0;
  let outcome: AgentTaskOutcome["outcome"] = "step_limit";
  try {
    while (stepNo < HARD_STEP_STOP) {
      stepNo += 1;
      const stepId = uuidv5(String(stepNo), input.sessionId);
      const stepStart = Date.now(); // Temporal-deterministic Date in workflows

      const workingSet = await activities.buildWorkingSetActivity({ ...ref, stepNo });

      // strict parse with bounded auto-repair (08 §4)
      let action: AgentAction | null = null;
      let usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
      let costCents = 0;
      const messages: LlmMessage[] = [...workingSet.messages];
      for (let repair = 0; repair <= MAX_REPAIRS; repair++) {
        const result = await activities.callModelActivity({
          ...ref,
          stepId,
          repairAttempt: repair,
          messages,
        });
        usage = {
          inputTokens: usage.inputTokens + result.usage.inputTokens,
          outputTokens: usage.outputTokens + result.usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens + result.usage.cachedInputTokens,
        };
        costCents += result.costCents;
        let parsed: unknown;
        try {
          parsed = JSON.parse(result.text);
        } catch (err) {
          messages.push(
            { role: "assistant", content: result.text },
            { role: "user", content: `Your reply was not valid JSON (${String(err)}). Respond with exactly one AgentAction JSON object.` },
          );
          continue;
        }
        const verdict = AgentActionSchema.safeParse(parsed);
        if (verdict.success) {
          action = verdict.data;
          break;
        }
        messages.push(
          { role: "assistant", content: result.text },
          {
            role: "user",
            content: `Your action failed schema validation: ${verdict.error.issues
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; ")}. Respond with exactly one corrected AgentAction JSON object.`,
          },
        );
      }

      if (!action) {
        // 3rd failure = failed step (08 §4); persist it and stop — the full
        // request_help forcing arrives with T33 messaging
        await activities.persistStepActivity({
          ...ref,
          stepId,
          stepNo,
          action: { type: "abandon", reason: "model output failed AgentAction parse after 2 repairs" },
          observation: { ok: false, parseFailed: true },
          usage,
          costCents,
          durationMs: Date.now() - stepStart,
        });
        outcome = "abandoned";
        break;
      }

      const observation = await activities.executeActionActivity({ ...ref, stepId, action });
      await activities.persistStepActivity({
        ...ref,
        stepId,
        stepNo,
        action,
        observation,
        usage,
        costCents,
        durationMs: Date.now() - stepStart,
      });

      if (action.type === "request_review") {
        outcome = "review_requested";
        break;
      }
      if (action.type === "complete_task") {
        outcome = "completed";
        break;
      }
      if (action.type === "abandon") {
        outcome = "abandoned";
        break;
      }
    }
  } finally {
    await activities.closeAgentSessionActivity({
      ...ref,
      status: outcome === "abandoned" ? "failed" : "completed",
    });
  }
  return { outcome, steps: stepNo };
}
