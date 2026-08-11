// agentTaskWorkflow core loop (08 §1–2, T32): build Working Set → call LLM →
// strict AgentAction parse (2 bounded repairs, then a synthesized abandon of
// the step via a failed observation) → execute → persist → next. Signals /
// wait_for land with T33; the six guards + continueAsNew with T34 (a hard
// safety stop at 60 steps protects until then). Pure orchestration — every
// side effect is an activity; stepId = uuidv5(String(stepNo), sessionId) is
// deterministic and replay-safe (08 §2).
import { condition, proxyActivities, setHandler, workflowInfo } from "@temporalio/workflow";
import { uuidv5 } from "@acos/domain";
import { AgentActionSchema, type AgentAction } from "@acos/llm/agent-action";
import type { createAgentTaskActivities } from "../activities/agent-task.js";
import type { LlmMessage } from "@acos/llm";
import {
  approvalVerdictSignal,
  cancelSignal,
  dependencyResolvedSignal,
  managerDirectiveSignal,
  messageReceivedSignal,
  reviewVerdictSignal,
  type InboxItemSignal,
} from "./signals.js";

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

  // ---- signal state (08 §5; carried-state versions arrive with T34) ----
  const seenSignalIds = new Set<string>();
  const pendingMessages: InboxItemSignal[] = [];
  // property access (not closed-over lets) — keeps TS control-flow honest
  // about mutations arriving from signal handlers
  const signals: {
    resolvedDependencies: string[];
    reviewVerdict: { verdict: string; notes?: string | undefined } | null;
    approvalVerdict: { verdict: string; note?: string | undefined } | null;
    paused: boolean;
    cancelled: { by: string; reason: string } | null;
  } = {
    resolvedDependencies: [],
    reviewVerdict: null,
    approvalVerdict: null,
    paused: false,
    cancelled: null,
  };

  setHandler(messageReceivedSignal, (item) => {
    if (seenSignalIds.has(item.signalId)) return; // at-least-once dedupe
    seenSignalIds.add(item.signalId);
    if (pendingMessages.length < 50) pendingMessages.push(item);
  });
  setHandler(dependencyResolvedSignal, (payload) => {
    signals.resolvedDependencies.push(payload.dependsOnTaskId);
  });
  setHandler(reviewVerdictSignal, (payload) => {
    signals.reviewVerdict = { verdict: payload.verdict, notes: payload.notes };
  });
  setHandler(approvalVerdictSignal, (payload) => {
    signals.approvalVerdict = { verdict: payload.verdict, note: payload.note };
  });
  setHandler(managerDirectiveSignal, (payload) => {
    if (payload.directive === "pause") signals.paused = true;
    if (payload.directive === "resume") signals.paused = false;
  });
  setHandler(cancelSignal, (payload) => {
    signals.cancelled = payload;
  });

  const wakeConditionMet = (what: string): boolean => {
    if (signals.cancelled) return true;
    switch (what) {
      case "reply":
        return pendingMessages.length > 0;
      case "dependency":
        return signals.resolvedDependencies.length > 0;
      case "review":
        return signals.reviewVerdict !== null;
      case "approval":
        return signals.approvalVerdict !== null;
      default:
        return false; // timer waits only time out
    }
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

      if (signals.cancelled !== null) {
        outcome = "abandoned";
        break;
      }
      if (signals.paused) {
        await condition(() => !signals.paused || signals.cancelled !== null);
        continue;
      }

      // drain the signal buffer into this step's working set (08 §5)
      const drained = pendingMessages.splice(0, pendingMessages.length);
      const signalMarkers: string[] = drained.map(
        (m) => `[signal:message=${m.kind}] from ${m.senderAgentId ?? "founder"}: ${m.preview}`,
      );
      if (signals.reviewVerdict !== null) {
        signalMarkers.push(`[signal:reviewVerdict=${signals.reviewVerdict.verdict}]`);
        signals.reviewVerdict = null;
      }
      if (signals.approvalVerdict !== null) {
        signalMarkers.push(`[signal:approvalVerdict=${signals.approvalVerdict.verdict}]`);
        signals.approvalVerdict = null;
      }

      const workingSet = await activities.buildWorkingSetActivity({
        ...ref,
        stepNo,
        signalMarkers,
      });

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

      // wait_for maps to Temporal condition + timer — never polling (08 §6)
      if (action.type === "wait_for") {
        await activities.executeActionActivity({ ...ref, stepId, action }); // → WAITING
        const woken = await condition(
          () => wakeConditionMet(action.what),
          action.timeoutMinutes * 60_000,
        );
        await activities.persistStepActivity({
          ...ref,
          stepId,
          stepNo,
          action,
          observation: { ok: true, woken, waitedFor: action.what },
          usage,
          costCents,
          durationMs: Date.now() - stepStart,
        });
        if (signals.cancelled !== null) {
          outcome = "abandoned";
          break;
        }
        await activities.resumeFromWaitActivity({ ...ref });
        continue;
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
