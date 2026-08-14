// agentTaskWorkflow core loop (08 §1–2, §9–10; T32/T33/T34): build Working
// Set → call LLM → strict AgentAction parse (2 bounded repairs) → execute →
// persist → GUARDS. Runaway protection is code, not prompt text: (a) budget,
// (b) deadline timer firing even mid-wait, (c) step cap 40 soft / >50 hard
// cumulative, (d) loop detector over normalized action hashes, (f) depth via
// createTaskActivity refusal; (e) ping-pong lives in the message pipeline.
// continueAsNew every 50 local steps or >5k history events with carried
// state. Pure orchestration — every side effect is an activity; stepId =
// uuidv5(String(stepNo), sessionId) is deterministic and replay-safe.
import {
  condition,
  continueAsNew,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from "@temporalio/workflow";
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

/** Carried across continueAsNew (08 §10) — small, schema-versioned. */
export interface CarriedState {
  stepNo: number;
  loopHashes: string[]; // guard (d) ring, last 6
  pendingMessages: InboxItemSignal[]; // capped 50
  seenSignalIds: string[]; // capped ring 200
  version: 1;
}

export interface AgentTaskInput {
  companyId: string;
  agentId: string;
  taskId: string;
  sessionId: string;
  attempt: number;
  carriedState?: CarriedState | undefined;
  /** Rework re-entry (T43, 15 §5): a changes_requested verdict restarts the
   *  owner's loop with the verdict pre-seeded so the first Working Set
   *  carries the [signal:reviewVerdict=…] marker the script branches on. */
  initialReviewVerdict?: { verdict: string; notes?: string | undefined } | undefined;
}

export interface AgentTaskOutcome {
  outcome: "review_requested" | "completed" | "abandoned" | "guard_stopped";
  steps: number;
}

const MAX_REPAIRS = 2;
const STEP_SOFT_WARN = 40; // guard (c) soft — injected into section 10
const STEP_HARD_CAP = 50; // guard (c) hard — cumulative across continues
const CONTINUE_EVERY_STEPS = 50; // 08 §10 (local steps per run)
const HISTORY_EVENT_LIMIT = 5_000;
const LOOP_WINDOW = 6; // guard (d)
const LOOP_TRIP = 3;

/**
 * Canlı model toleransı (2026-08-14): markdown çiti / önsöz-sonsöz metni
 * içinden ilk dengeli JSON nesnesini çıkarır. Şema doğrulaması KATI kalır
 * (08 §4) — yalnız çıkarım toleranslıdır. Deterministik saf string işlemi
 * (workflow-güvenli).
 */
function extractJsonCandidate(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const source = (fenced?.[1] ?? text).trim();
  if (source.startsWith("{") && source.endsWith("}")) return source;
  const start = source.indexOf("{");
  if (start === -1) return source;
  let depth = 0;
  let inString = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  return source.slice(start);
}

/** guard (d) normalization: lowercase, strip volatile fields (08 §9). */
function normalizedActionHash(action: AgentAction): string {
  const raw = JSON.stringify(action)
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z?/g, "<ts>");
  let hash = 0x811c9dc5;
  for (let i = 0; i < raw.length; i++) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

export async function agentTaskWorkflow(input: AgentTaskInput): Promise<AgentTaskOutcome> {
  const info = workflowInfo();
  const ref = {
    companyId: input.companyId,
    agentId: input.agentId,
    taskId: input.taskId,
    sessionId: input.sessionId,
  };

  // ---- signal + guard state, re-hydrated across continueAsNew (08 §10) ----
  const carried = input.carriedState;
  const seenSignalIds = new Set<string>(carried?.seenSignalIds ?? []);
  const pendingMessages: InboxItemSignal[] = [...(carried?.pendingMessages ?? [])];
  const loopHashes: string[] = [...(carried?.loopHashes ?? [])];
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
    // rework re-entry pre-seeds the verdict (T43) — undefined on old histories
    reviewVerdict: input.initialReviewVerdict ?? null,
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

  // guard (b): a timer set at workflow start fires at the deadline even
  // mid-wait (08 §9b); the snapshot supplies the wall-clock deadline
  const guardFlags = { deadlineReached: false, deadlineEscalated: false };
  const initialSnapshot = await activities.getGuardSnapshotActivity(ref);
  if (initialSnapshot.deadline) {
    const untilDeadline = new Date(initialSnapshot.deadline).getTime() - Date.now();
    if (untilDeadline <= 0) guardFlags.deadlineReached = true;
    else {
      void sleep(untilDeadline).then(() => {
        guardFlags.deadlineReached = true;
      });
    }
  }

  let stepNo = carried?.stepNo ?? 0; // cumulative across continues (guard c)
  let localSteps = 0;
  let continuing = false;
  let outcome: AgentTaskOutcome["outcome"] = "guard_stopped";

  const carryState = (): CarriedState => ({
    stepNo,
    loopHashes: loopHashes.slice(-LOOP_WINDOW),
    pendingMessages: pendingMessages.slice(0, 50),
    seenSignalIds: [...seenSignalIds].slice(-200),
    version: 1,
  });

  try {
    for (;;) {
      // guard (c) hard: cumulative cap — starting a step beyond 50 is refused
      if (stepNo >= STEP_HARD_CAP) {
        await activities.guardEscalateActivity({
          ...ref,
          stepId: uuidv5(`guard:step_cap:${stepNo}`, input.sessionId),
          guard: "step_cap",
          detail: `cumulative step ${stepNo} reached the hard cap ${STEP_HARD_CAP}`,
        });
        outcome = "guard_stopped";
        break;
      }
      stepNo += 1;
      localSteps += 1;
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

      // guard (b): deadline breach forces one escalation, then work continues
      // under the manager's direction (extend / rescope / reassign)
      if (guardFlags.deadlineReached && !guardFlags.deadlineEscalated) {
        guardFlags.deadlineEscalated = true;
        await activities.guardEscalateActivity({
          ...ref,
          stepId: uuidv5("guard:deadline", input.sessionId),
          guard: "deadline",
          detail: "wall-clock deadline passed",
        });
      }
      // guard (a): budget — never start a step you cannot pay for (08 §9a)
      const snapshot = await activities.getGuardSnapshotActivity(ref);
      if (
        snapshot.remainingCents !== null &&
        (snapshot.remainingCents <= 0 || snapshot.remainingCents <= snapshot.estimatedNextStepCents)
      ) {
        await activities.guardEscalateActivity({
          ...ref,
          stepId: uuidv5(`guard:budget:${stepNo}`, input.sessionId),
          guard: "budget",
          detail: `remaining ${snapshot.remainingCents}¢ ≤ estimated next step ${snapshot.estimatedNextStepCents}¢`,
        });
        outcome = "guard_stopped";
        break;
      }
      // guard (c) soft: constraint injected into section 10 (08 §9c)
      if (stepNo >= STEP_SOFT_WARN) {
        signalMarkers.push(`[guard:step_cap_warning] step ${stepNo} of ${STEP_HARD_CAP}`);
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
      let lastModelText = "";
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
        lastModelText = result.text;
        let parsed: unknown;
        try {
          parsed = JSON.parse(extractJsonCandidate(result.text));
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
          // teşhis: son ham model çıktısının ilk 400 karakteri kayda geçer
          observation: { ok: false, parseFailed: true, sample: lastModelText.slice(0, 400) },
          usage,
          costCents,
          durationMs: Date.now() - stepStart,
        });
        outcome = "abandoned";
        break;
      }

      // guard (d): loop detector — ≥3 identical normalized hashes within the
      // last 6 steps forces request_help (08 §9d)
      const actionHash = normalizedActionHash(action);
      loopHashes.push(actionHash);
      if (loopHashes.length > LOOP_WINDOW) loopHashes.shift();
      if (loopHashes.filter((h) => h === actionHash).length >= LOOP_TRIP) {
        await activities.persistStepActivity({
          ...ref,
          stepId,
          stepNo,
          action,
          observation: { ok: false, guard: "loop", hash: actionHash },
          usage,
          costCents,
          durationMs: Date.now() - stepStart,
        });
        await activities.guardEscalateActivity({
          ...ref,
          stepId,
          guard: "loop",
          detail: `action hash ${actionHash} repeated ${LOOP_TRIP}x within ${LOOP_WINDOW} steps`,
        });
        outcome = "guard_stopped";
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

      // escalate = Approval Engine wait (19 §7, T35): the workflow blocks
      // durably on the Founder verdict until the derived expiry; on silence
      // it closes the approval itself (expired ≡ rejected — nothing
      // irreversible proceeds). The verdict reaches the next working set as
      // a [signal:approvalVerdict=…] marker.
      if (
        action.type === "escalate" &&
        typeof observation.approvalId === "string" &&
        observation.approvalStatus === "pending"
      ) {
        const untilExpiry = new Date(String(observation.expiresAt)).getTime() - Date.now();
        await condition(
          () => signals.approvalVerdict !== null || signals.cancelled !== null,
          Math.max(untilExpiry, 1),
        );
        if (signals.cancelled !== null) {
          outcome = "abandoned";
          break;
        }
        if (signals.approvalVerdict === null) {
          const { status } = await activities.expireApprovalActivity({
            ...ref,
            approvalId: observation.approvalId,
          });
          signals.approvalVerdict = { verdict: status, note: undefined };
        }
        await activities.resumeFromWaitActivity({ ...ref });
        continue;
      }

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

      // continueAsNew boundary (08 §10) — independent of the step cap; the
      // session stays open across continues (truth lives in Postgres)
      if (
        localSteps >= CONTINUE_EVERY_STEPS ||
        workflowInfo().historyLength > HISTORY_EVENT_LIMIT
      ) {
        continuing = true;
        await continueAsNew<typeof agentTaskWorkflow>({
          ...input,
          carriedState: carryState(),
        });
      }
    }
  } finally {
    if (!continuing) {
      await activities.closeAgentSessionActivity({
        ...ref,
        status: outcome === "abandoned" ? "failed" : "completed",
      });
    }
  }
  return { outcome, steps: stepNo };
}
