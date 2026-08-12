// agentTaskWorkflow activities (08 §3, T32). All IO of the loop lives here;
// the workflow only orchestrates. Effects are exactly-once at the DB via
// stepId-derived idempotency keys (08 §11). Task transitions go through the
// ONE status writer (TaskStateService — @acos/db/task-engine).
import { and, eq, sql } from "drizzle-orm";
import { uuidv5 } from "@acos/domain";
import { parseEventPayload } from "@acos/events";
import {
  ApprovalError,
  ApprovalsService,
  ChannelService,
  CostService,
  DelegationService,
  MessageService,
  ReviewError,
  ReviewsService,
  TaskEngineError,
  TasksService,
  TaskStateService,
  appendEvents,
  companyContext,
  deliverMessage,
  type CompanyContext,
  type GuardedDb,
  type InboxItem,
  type NewEventInput,
  type SignalPort,
  type Tx,
} from "@acos/db";
import {
  agentModelBindings,
  agentSessions,
  agentSteps,
  agents,
  llmCalls,
  modelProfiles,
  positions,
  tasks,
  workspaces as workspacesTable,
} from "@acos/db/schema";
import type { ModelRouter, RoutingContext, LlmMessage, LlmUsage } from "@acos/llm";
import { CONTEXT_SENTINEL_UUID, type AgentAction } from "@acos/llm/agent-action";
import { FENCE_PREAMBLE, provenanceFence } from "@acos/tools";

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

/**
 * The canonical 32 §6.1 script tool names → registry tools (T40, recorded
 * mapping): scripted sessions speak `write_file`/`run_command`; the gateway
 * registry speaks `fs.write`/`terminal.run`. Live models are prompted with
 * registry names directly, so unknown names pass through untouched and the
 * gateway fail-closes on them.
 */
export function mapToolCall(
  tool: string,
  input: unknown,
): { toolName: string; input: unknown } {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (tool) {
    case "write_file":
      return {
        toolName: "fs.write",
        input: {
          path: args.path,
          content:
            typeof args.content === "string"
              ? args.content
              : `// ${String(args.contentRef ?? "generated")}`,
        },
      };
    case "run_command":
    case "run_tests":
      return { toolName: "terminal.run", input: { command: args.command ?? "npm test" } };
    case "read_file":
      return { toolName: "fs.read", input: { path: args.path } };
    default:
      return { toolName: tool, input: args };
  }
}

export interface AgentTaskActivityDeps {
  guardedDb: GuardedDb;
  router: ModelRouter;
  /** RoutingContext loader — DB bindings/profiles in prod, fixed in scripted mode. */
  routingFor(ctx: CompanyContext, agentId: string): Promise<RoutingContext>;
  /** Post-commit message delivery transport (11 §4.4); absent in narrow tests. */
  signalPort?: SignalPort | undefined;
  /** Assignment → workflow start (09 §4 trigger, T36): after a successful
   *  delegation the child owner's agentTaskWorkflow starts. Best-effort —
   *  REJECT_DUPLICATE double-starts are swallowed by the implementation. */
  startAgentWorkflow?: ((input: { companyId: string; agentId: string; taskId: string }) => Promise<void>) | undefined;
  /** use_tool → Tool Gateway internal HTTP (17 §4, T40). Absent in narrow
   *  scripted tests: the pre-T40 stub observation is preserved so guard and
   *  loop suites stay deterministic without a gateway. */
  invokeTool?:
    | ((req: {
        companyId: string;
        agentId: string;
        taskId: string;
        agentSessionId?: string | undefined;
        toolName: string;
        input: unknown;
        idempotencyKey: string;
      }) => Promise<{
        invocationId: string | null;
        decision: string;
        status: string;
        reason: string | null;
        output?: unknown;
        error?: string | undefined;
        costCents?: number | undefined;
        retryAfterSec?: number | undefined;
      }>)
    | undefined;
  /** request_review → independent reviewer's reviewWorkflow start (T43). */
  startReviewWorkflow?:
    | ((input: {
        companyId: string;
        reviewId: string;
        taskId: string;
        reviewerAgentId: string;
        authorAgentId: string;
      }) => Promise<void>)
    | undefined;
}

export interface SessionRef {
  companyId: string;
  agentId: string;
  taskId: string;
  sessionId: string;
}

export interface WorkingSet {
  messages: LlmMessage[];
  digest: string;
}

export interface ModelCallResult {
  text: string;
  usage: LlmUsage;
  model: string;
  costCents: number;
  latencyMs: number;
}

function fnvDigest(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export function createAgentTaskActivities(deps: AgentTaskActivityDeps) {
  const { guardedDb } = deps;
  const taskState = new TaskStateService(guardedDb);
  const channelService = new ChannelService(guardedDb);
  const messageService = new MessageService(guardedDb, channelService);
  const tasksService = new TasksService(guardedDb);
  const delegationService = new DelegationService(guardedDb, tasksService, taskState);
  const costService = new CostService(guardedDb);
  const approvalsService = new ApprovalsService(guardedDb);
  const reviewsService = new ReviewsService(guardedDb);

  /** Checkpoint before review (T43, recorded): the submit implies "my work
   *  is on the branch" — an automatic commit (allowEmpty) + push makes the
   *  diff reviewable and the branch mergeable; the squash collapses WIP
   *  commits anyway (15 §3.4). Best-effort: toolless flows have no gateway. */
  async function checkpointBranch(input: SessionRef): Promise<void> {
    if (!deps.invokeTool) return;
    // only when the task ALREADY worked in a workspace — a toolless task must
    // not have a workspace provisioned as a review side effect
    const [live] = await guardedDb
      .select({ id: workspacesTable.id })
      .from(workspacesTable)
      .where(
        and(
          eq(workspacesTable.companyId, input.companyId),
          eq(workspacesTable.taskId, input.taskId),
          sql`${workspacesTable.status} IN ('ready','in_use','idle')`,
        ),
      )
      .limit(1);
    if (!live) return;
    try {
      await deps.invokeTool({
        companyId: input.companyId,
        agentId: input.agentId,
        taskId: input.taskId,
        agentSessionId: input.sessionId,
        toolName: "git.commit",
        input: { message: "chore: review checkpoint", allowEmpty: true },
        idempotencyKey: `checkpoint-commit:${input.sessionId}:${Date.now() >> 13}`,
      });
      await deps.invokeTool({
        companyId: input.companyId,
        agentId: input.agentId,
        taskId: input.taskId,
        agentSessionId: input.sessionId,
        toolName: "git.branch",
        input: { force: true }, // task/* only — rebase-safe (15 §3.7)
        idempotencyKey: `checkpoint-push:${input.sessionId}:${Date.now() >> 13}`,
      });
    } catch {
      /* no workspace (toolless) or gateway down — review can still proceed */
    }
  }

  /** request_review / review-shaped complete_task: open (or reset) the code
   *  review row and start the independent reviewer's workflow (T43). Tool-
   *  less tasks (no project/workspace) keep the pre-T43 transition-only path. */
  async function openCodeReview(ctx: CompanyContext, taskId: string, authorAgentId: string) {
    try {
      const { review } = await reviewsService.requestReview(ctx, {
        taskId,
        authorAgentId,
      });
      if (review.reviewerAgentId && deps.startReviewWorkflow) {
        await deps.startReviewWorkflow({
          companyId: ctx.companyId,
          reviewId: review.id,
          taskId,
          reviewerAgentId: review.reviewerAgentId,
          authorAgentId,
        });
      }
      return { reviewId: review.id, reviewerAgentId: review.reviewerAgentId };
    } catch (err) {
      if (err instanceof ReviewError &&
          (err.code === "REVIEW_TASK_INVALID" || err.code === "REVIEW_NO_ELIGIBLE_REVIEWER")) {
        return null; // toolless/projectless task or a one-agent org — transition-only
      }
      throw err;
    }
  }

  return {
    /** 08 §1: mark the pre-created session running; task started + presence. */
    async startAgentSessionActivity(input: SessionRef & {
      workflowId: string;
      runId: string;
      attempt: number;
    }): Promise<void> {
      const ctx = companyContext(input.companyId);
      await guardedDb.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: agentSessions.id, status: agentSessions.status })
          .from(agentSessions)
          .where(and(eq(agentSessions.companyId, ctx.companyId), eq(agentSessions.id, input.sessionId)));
        if (existing?.status === "running") return; // idempotent retry
        if (existing) {
          await tx
            .update(agentSessions)
            .set({ status: "running", currentActivity: "WORKING", workflowId: input.workflowId, runId: input.runId })
            .where(and(eq(agentSessions.companyId, ctx.companyId), eq(agentSessions.id, input.sessionId)));
        } else {
          await tx.insert(agentSessions).values({
            id: input.sessionId,
            companyId: ctx.companyId,
            agentId: input.agentId,
            taskId: input.taskId,
            workflowId: input.workflowId,
            runId: input.runId,
            status: "running",
            currentActivity: "WORKING",
          });
        }
        await emitDomainEvent(tx, ctx, {
          type: "agent.task.started",
          actor: { kind: "agent", id: input.agentId },
          taskId: input.taskId,
          agentId: input.agentId,
          causationId: input.sessionId,
          payload: {
            taskId: input.taskId,
            agentId: input.agentId,
            sessionId: input.sessionId,
            attempt: input.attempt,
          },
        });
        await emitDomainEvent(tx, ctx, {
          type: "agent.status.changed",
          actor: { kind: "system", id: null },
          agentId: input.agentId,
          payload: { sessionId: input.sessionId, from: "IDLE", to: "WORKING" },
        });
      });
    },

    /** 08 §8 section order; memory sections land with T45. */
    async buildWorkingSetActivity(
      input: SessionRef & { stepNo: number; signalMarkers?: string[] | undefined },
    ): Promise<WorkingSet> {
      const ctx = companyContext(input.companyId);
      const [agentRow] = await guardedDb
        .select({
          name: agents.name,
          persona: agents.persona,
          seniority: agents.seniority,
          autonomyLevel: agents.autonomyLevel,
          positionTitle: positions.title,
          defaultRole: positions.defaultRole,
        })
        .from(agents)
        .innerJoin(positions, eq(agents.positionId, positions.id))
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, input.agentId)));
      const [task] = await guardedDb
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
      if (!agentRow || !task) throw new Error("agent or task not found for working set");

      const chain = await guardedDb.execute(sql`
        WITH RECURSIVE up AS (
          SELECT e.to_agent_id, 1 AS depth FROM org_edges e
          WHERE e.company_id = ${ctx.companyId} AND e.from_agent_id = ${input.agentId}
            AND e.kind = 'reports_to' AND e.ended_at IS NULL
          UNION ALL
          SELECT e.to_agent_id, up.depth + 1 FROM org_edges e
          JOIN up ON e.from_agent_id = up.to_agent_id
          WHERE e.company_id = ${ctx.companyId} AND e.kind = 'reports_to'
            AND e.ended_at IS NULL AND up.depth < 10
        )
        SELECT a.name FROM up JOIN agents a ON a.id = up.to_agent_id
        WHERE a.company_id = ${ctx.companyId} ORDER BY up.depth
      `);
      const managers = (chain.rows as Array<{ name: string }>).map((r) => r.name);

      const recentSteps = await guardedDb
        .select({
          stepNo: agentSteps.stepNo,
          actionKind: agentSteps.actionKind,
          observation: agentSteps.observation,
        })
        .from(agentSteps)
        .where(
          and(
            eq(agentSteps.companyId, ctx.companyId),
            eq(agentSteps.agentSessionId, input.sessionId),
          ),
        )
        .orderBy(sql`${agentSteps.stepNo} DESC`)
        .limit(5);

      const taskContext = task.context as Record<string, unknown>;
      const lastObservation = recentSteps[0]?.observation as
        | { exitCode?: number; signal?: Record<string, string> }
        | null
        | undefined;
      const markers = [
        `[role:${agentRow.defaultRole}]`,
        `[agentName:${agentRow.name}]`,
        `[ctxTask:${input.taskId}]`,
        `[taskFixture:${String(taskContext.taskFixture ?? "none")}]`,
        `[lastExitCode:${lastObservation?.exitCode ?? 0}]`,
        ...Object.entries(lastObservation?.signal ?? {}).map(([k, v]) => `[signal:${k}=${v}]`),
        ...(input.signalMarkers ?? []), // drained signal buffer (08 §5, T33)
      ].join(" ");

      // sections 1–10 of 08 §8 (memory 4–6 and thread 7 are placeholders
      // until T45/T33; token budgets enforced with the char/4 heuristic there)
      // S5 (18 §11.1): observations carrying EXTERNAL content (workspace
      // files, web responses) enter the prompt only inside provenance fences;
      // flagged outputs keep their taint visible. Fencing is central — here,
      // never in tool authors' code.
      const renderStep = (s: (typeof recentSteps)[number]): string => {
        const obs = (s.observation ?? {}) as {
          output?: { provenance?: string };
          outputFlagged?: boolean;
        };
        const compact = JSON.stringify(s.observation ?? {}).slice(0, 200);
        const provenance = obs.output?.provenance;
        if (provenance === "workspace" || provenance === "web" || obs.outputFlagged) {
          return `${s.stepNo}. ${s.actionKind} ->\n${provenanceFence(compact, {
            source: `${provenance ?? "tool"}:step-${s.stepNo}`,
          })}`;
        }
        return `${s.stepNo}. ${s.actionKind} -> ${compact}`;
      };
      const hasFences = recentSteps.some((s) => {
        const obs = (s.observation ?? {}) as {
          output?: { provenance?: string };
          outputFlagged?: boolean;
        };
        const p = obs.output?.provenance;
        return p === "workspace" || p === "web" || obs.outputFlagged === true;
      });

      const system = [
        `You are ${agentRow.name}, ${agentRow.positionTitle} (${agentRow.seniority}, autonomy L${agentRow.autonomyLevel}).`,
        agentRow.persona,
        `Non-negotiable rules: act only via a single AgentAction JSON object; never invent tools.`,
        ...(hasFences ? [FENCE_PREAMBLE] : []),
        markers,
      ].join("\n");
      const user = [
        `# Org context\nEscalation chain: ${managers.join(" -> ") || "(top level)"} -> Founder`,
        `# Task TASK-${task.number}: ${task.title}\nObjective: ${task.objective}\nStatus: ${task.status} | Priority: ${task.priority} | Risk: ${task.risk}\nSuccess criteria: ${task.successCriteria.join("; ") || "(none)"}\nBudget remaining cents: ${task.budgetCents === null ? "inherit" : task.budgetCents - task.spentCents}`,
        `# Thread + signals\n${(input.signalMarkers ?? []).join("\n") || "(no new messages)"}`,
        `# Recent steps\n${recentSteps.slice().reverse().map(renderStep).join("\n") || "(none yet)"}`,
        `# Output\nRespond with EXACTLY one AgentAction JSON object, no prose. Step ${input.stepNo}.`,
      ].join("\n\n");

      const messages: LlmMessage[] = [
        { role: "system", content: system },
        { role: "user", content: user },
      ];
      return { messages, digest: fnvDigest(system + user) };
    },

    /** ModelRouter call + idempotent llm_calls accounting (08 §11). */
    async callModelActivity(input: SessionRef & {
      stepId: string;
      repairAttempt: number;
      messages: LlmMessage[];
    }): Promise<ModelCallResult> {
      const ctx = companyContext(input.companyId);
      const routing = await deps.routingFor(ctx, input.agentId);
      const result = await deps.router.complete(
        {
          purpose: "reasoning",
          messages: input.messages,
          agentId: input.agentId,
          taskId: input.taskId,
          sessionId: input.sessionId,
        },
        routing,
      );
      const llmCallId = uuidv5(`llm:${input.repairAttempt}`, input.stepId);
      await guardedDb.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: llmCalls.id })
          .from(llmCalls)
          .where(and(eq(llmCalls.companyId, ctx.companyId), eq(llmCalls.id, llmCallId)));
        if (existing) return; // retried activity — cost not double-counted
        await tx.insert(llmCalls).values({
          id: llmCallId,
          companyId: ctx.companyId,
          agentId: input.agentId,
          taskId: input.taskId,
          agentSessionId: input.sessionId,
          purpose: "reasoning",
          providerId: result.providerId,
          model: result.model,
          tokensIn: result.usage.inputTokens,
          tokensOut: result.usage.outputTokens,
          tokensCached: result.usage.cachedInputTokens,
          costCents: result.costCents,
          latencyMs: result.latencyMs,
          status: "ok",
        });
      });
      return {
        text: result.text,
        usage: result.usage,
        model: result.model,
        costCents: result.costCents,
        latencyMs: result.latencyMs,
      };
    },

    /** Action dispatch (08 §3). T32 scope: status moves via the single writer,
     *  stubbed tool execution (gateway lands T39/T40), think as no-op. */
    async executeActionActivity(input: SessionRef & {
      stepId: string;
      action: AgentAction;
    }): Promise<Record<string, unknown>> {
      const ctx = companyContext(input.companyId);
      const action = input.action;
      // context sentinel (T36): "my current task" in task-ref positions
      const selfTask = (id: string) => (id === CONTEXT_SENTINEL_UUID ? input.taskId : id);
      switch (action.type) {
        case "update_task_status": {
          const updated = await taskState.transition(ctx, selfTask(action.taskId), action.to, {
            kind: "agent",
            agentId: input.agentId,
          }, { note: action.note });
          return { ok: true, status: updated.status };
        }
        case "request_review": {
          // owner submits: IN_PROGRESS→REVIEW (07 §5) + the code review row
          // with an INDEPENDENT reviewer whose workflow starts now (T43)
          const taskId = selfTask(action.taskId);
          await checkpointBranch(input);
          const updated = await taskState.transition(ctx, taskId, "REVIEW", {
            kind: "agent",
            agentId: input.agentId,
          }, { note: action.summary });
          const opened = await openCodeReview(ctx, taskId, input.agentId);
          return {
            ok: true,
            status: updated.status,
            reviewRequested: true,
            ...(opened && { reviewId: opened.reviewId, reviewerAgentId: opened.reviewerAgentId }),
          };
        }
        case "use_tool": {
          // T40: every tool effect traverses the Tool Gateway (S3) — it
          // authorizes, audits, dispatches into the task workspace and
          // records cost. The observation keeps the exitCode shape scripted
          // branches key on ([lastExitCode:n]). Without a wired gateway
          // (narrow tests) the pre-T40 stub observation is preserved.
          if (!deps.invokeTool) {
            return { ok: true, tool: action.tool, exitCode: 0, stub: true, input: action.input };
          }
          const mapped = mapToolCall(action.tool, action.input);
          // S5 taint carry (18 §11.3): once any output in this session was
          // flagged, later tool calls run tainted — the gateway elevates the
          // effective risk one class (fail-secure sticky bit; recorded MVP
          // coarsening of the per-argument substring derivation)
          const [flaggedStep] = await guardedDb
            .select({ id: agentSteps.id })
            .from(agentSteps)
            .where(
              and(
                eq(agentSteps.companyId, ctx.companyId),
                eq(agentSteps.agentSessionId, input.sessionId),
                sql`${agentSteps.observation} ->> 'outputFlagged' = 'true'`,
              ),
            )
            .limit(1);
          const res = await deps.invokeTool({
            companyId: input.companyId,
            agentId: input.agentId,
            taskId: input.taskId,
            agentSessionId: input.sessionId,
            toolName: mapped.toolName,
            input: mapped.input,
            ...(flaggedStep && { tainted: true }),
            // deterministic per step ⇒ Temporal retries replay the result
            idempotencyKey: `tool:${input.stepId}`,
          });
          const output = (res.output ?? {}) as { exitCode?: number };
          const exitCode =
            res.status === "succeeded" ? (output.exitCode ?? 0) : (output.exitCode ?? 1);
          const flaggedNow = (res as { outputFlagged?: boolean }).outputFlagged === true;
          return {
            ok: res.status === "succeeded",
            tool: action.tool,
            decision: res.decision,
            status: res.status,
            exitCode,
            ...(res.output !== undefined && { output: res.output }),
            ...(flaggedNow && {
              outputFlagged: true,
              flaggedPatterns: (res as { flaggedPatterns?: string[] }).flaggedPatterns ?? [],
            }),
            ...(res.reason !== null && { reason: res.reason }),
            ...(res.error !== undefined && { error: res.error }),
            ...(res.costCents !== undefined && { costCents: res.costCents }),
            ...(res.retryAfterSec !== undefined && { retryAfterSec: res.retryAfterSec }),
          };
        }
        case "send_message": {
          // sentinel channel = the agent's own task thread (T36)
          let channelId = action.channelId;
          if (channelId === CONTEXT_SENTINEL_UUID) {
            const thread = await guardedDb.transaction((tx) =>
              channelService.provisionInTx(tx, ctx, {
                kind: "task_thread",
                taskId: input.taskId,
                memberAgentIds: [input.agentId],
              }),
            );
            channelId = thread.id;
          }
          // the ONE send path (11 §0.2) + post-commit delivery via SignalPort
          const plan = await messageService.send(ctx, {
            channelId,
            senderAgentId: input.agentId,
            kind: action.kind === "text" ? "text" : action.kind,
            body: action.body,
            refs: action.refs,
            mentions: action.mentions,
            idempotencyKey: uuidv5("msg", input.stepId),
          });
          if (deps.signalPort) {
            await deliverMessage(guardedDb, ctx, plan, deps.signalPort);
          }
          return { ok: true, messageId: plan.message.id, recipients: plan.recipients.length };
        }
        case "wait_for": {
          // status move only — the workflow owns the Temporal condition (08 §6)
          const [current] = await guardedDb
            .select({ status: tasks.status })
            .from(tasks)
            .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
          if (current?.status === "IN_PROGRESS") {
            await taskState.transition(ctx, input.taskId, "WAITING", {
              kind: "agent",
              agentId: input.agentId,
            }, { note: `waiting for ${action.what}` });
          }
          return { ok: true, waiting: action.what };
        }
        case "create_task": {
          // depth ≤ 5 enforced inside (07 §2); the structured error appears
          // in the next Working Set instead of crashing the loop (guard f)
          try {
            const child = await delegationService.createChildTask(ctx, input.agentId, {
              parentTaskId: selfTask(action.parentTaskId),
              kind: action.kind,
              title: action.title,
              objective: action.objective,
              priority: action.priority,
              estimatedEffort: action.estimatedEffort,
              successCriteria: action.successCriteria,
              risk: action.risk,
              orgUnitId: action.orgUnitId,
            });
            return { ok: true, taskId: child.id, number: child.number };
          } catch (err) {
            if (err instanceof TaskEngineError) {
              return { ok: false, error: err.code, detail: err.message };
            }
            throw err;
          }
        }
        case "delegate_task": {
          try {
            // sentinel task = the oldest unassigned child of the current
            // task; sentinel target = @-mention in the note, else the
            // least-loaded eligible direct report (T36)
            let taskId = action.taskId;
            if (taskId === CONTEXT_SENTINEL_UUID) {
              const child = await delegationService.resolveNextChildTask(ctx, input.taskId);
              if (!child) return { ok: false, error: "NO_UNASSIGNED_CHILD" };
              taskId = child.id;
            }
            let toAgentId = action.toAgentId;
            if (toAgentId === CONTEXT_SENTINEL_UUID) {
              const target = await delegationService.resolveDelegateTarget(
                ctx,
                input.agentId,
                action.note,
              );
              if (!target) return { ok: false, error: "NO_ELIGIBLE_DELEGATE" };
              toAgentId = target;
            }
            const result = await delegationService.delegateTask(ctx, input.agentId, taskId, toAgentId);
            if (result.ok && deps.startAgentWorkflow) {
              // assignment triggers the owner's workflow (09 §4) —
              // post-commit, best-effort; a duplicate start is swallowed
              await deps
                .startAgentWorkflow({ companyId: ctx.companyId, agentId: toAgentId, taskId })
                .catch(() => {});
            }
            return result.ok
              ? { ok: true, delegated: true, taskId, toAgentId }
              : { ok: false, error: result.reason, candidates: result.candidates };
          } catch (err) {
            if (err instanceof TaskEngineError) {
              return { ok: false, error: err.code, detail: err.message };
            }
            throw err;
          }
        }
        case "escalate": {
          // Approval Engine entry (19 §7, T35): compose the 11-field brief
          // from the action + task context (canonical 08 §4 escalate carries
          // a subset — missing fields are filled with explicit placeholders,
          // recorded deviation from 19 §10's action-carries-brief ideal),
          // create the pending approval idempotently, park the task; the
          // workflow then blocks on approvalVerdict until the derived expiry.
          const [task] = await guardedDb
            .select()
            .from(tasks)
            .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
          if (!task) return { ok: false, error: "TASK_NOT_FOUND" };
          const [session] = await guardedDb
            .select({ workflowId: agentSessions.workflowId })
            .from(agentSessions)
            .where(and(eq(agentSessions.companyId, ctx.companyId), eq(agentSessions.id, input.sessionId)));
          const options = action.options.slice(0, 10).map((o) => ({
            option: o.option.slice(0, 500),
            pros: "",
            cons: o.risk.slice(0, 500),
            cost_cents: 0,
          }));
          while (options.length < 2) {
            options.push({
              option: options.length === 0 ? "Proceed as requested" : "Do not proceed",
              pros: options.length === 0 ? "unblocks the task" : "no cost or risk incurred",
              cons: options.length === 0 ? "carries the stated risk" : "the request stays unfulfilled",
              cost_cents: 0,
            });
          }
          const urgency =
            task.priority === "P0" ? "critical" : task.priority === "P1" ? "high" : "normal";
          const brief = {
            title: `Approval: ${task.title}`.slice(0, 120),
            request: action.reason.slice(0, 1200),
            reason: action.reason.slice(0, 1200),
            attempted:
              action.attempted.length > 0
                ? action.attempted.map((a) => a.slice(0, 500))
                : ["(no autonomous attempts recorded by the agent)"],
            options,
            recommendation: action.recommendation.slice(0, 1200) || "(none given)",
            risk: `${task.risk} — escalated from TASK-${task.number}`,
            cost: { amount_cents: 0, currency: "USD" },
            impact: `Approved: TASK-${task.number} ("${task.title}") proceeds. Rejected: the agent adjusts the plan or abandons.`.slice(0, 1200),
            urgency: `${urgency} — derived from task priority ${task.priority}`,
            deadline: task.deadline?.toISOString() ?? null,
          };
          try {
            const { row, created } = await approvalsService.create(ctx, {
              id: uuidv5("approval", input.stepId),
              kind: "other",
              brief,
              requestedByAgentId: input.agentId,
              risk: task.risk,
              urgency,
              deadline: task.deadline,
              taskId: input.taskId,
              workflowId: session?.workflowId ?? undefined,
            });
            if (created) {
              await guardedDb.transaction((tx) =>
                emitDomainEvent(tx, ctx, {
                  type: "agent.escalated",
                  actor: { kind: "agent", id: input.agentId },
                  taskId: input.taskId,
                  agentId: input.agentId,
                  payload: {
                    reason: action.reason,
                    attempted: action.attempted,
                    recommendation: action.recommendation,
                  },
                }),
              );
            }
            if (task.status === "IN_PROGRESS") {
              await taskState.transition(ctx, input.taskId, "WAITING", {
                kind: "agent",
                agentId: input.agentId,
              }, { note: `awaiting approval ${row.id}` });
            }
            return {
              ok: true,
              approvalId: row.id,
              approvalStatus: row.status,
              expiresAt: approvalsService.expiresAt(row).toISOString(),
            };
          } catch (err) {
            if (err instanceof ApprovalError) {
              return { ok: false, error: err.code, detail: err.message };
            }
            throw err;
          }
        }
        case "think":
          return { ok: true, thought: true };
        case "complete_task": {
          // T43 (recorded): after a changes_requested rework the owner's
          // "done" cannot self-approve — the machine routes it back through
          // re-review (CHANGES_REQUESTED→IN_PROGRESS→REVIEW, same row reset)
          const [row] = await guardedDb
            .select({ status: tasks.status })
            .from(tasks)
            .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
          if (row && ["CHANGES_REQUESTED", "IN_PROGRESS"].includes(row.status)) {
            const priorReviews = await reviewsService.listForTask(ctx, input.taskId);
            if (priorReviews.length > 0) {
              const owner = { kind: "agent" as const, agentId: input.agentId };
              if (row.status === "CHANGES_REQUESTED") {
                await taskState.transition(ctx, input.taskId, "IN_PROGRESS", owner);
              }
              await checkpointBranch(input);
              await taskState.transition(ctx, input.taskId, "REVIEW", owner);
              const opened = await openCodeReview(ctx, input.taskId, input.agentId);
              return {
                ok: true,
                completed: false,
                reReviewRequested: true,
                ...(opened && { reviewId: opened.reviewId }),
              };
            }
          }
          return { ok: true, completed: true };
        }
        case "abandon":
          return { ok: true, abandoned: true, reason: action.reason };
        default:
          // send_message / create_task / delegate_task / escalate / wait_for
          // etc. arrive with T33+ — surface a structured refusal the agent
          // sees next step instead of crashing the loop
          return { ok: false, error: `action ${action.type} not yet wired (T33+)` };
      }
    },

    /** agent_steps + cost entry + session counters, one tx, stepId-idempotent. */
    async persistStepActivity(input: SessionRef & {
      stepId: string;
      stepNo: number;
      action: AgentAction;
      observation: Record<string, unknown>;
      usage: LlmUsage;
      costCents: number;
      durationMs: number;
    }): Promise<{ inserted: boolean }> {
      const ctx = companyContext(input.companyId);
      // schema CHECK carries the canonical 12 kinds — think persists under
      // record_decision with the true type kept in action JSON (recorded
      // deviation; altering the CHECK would be a migration change)
      const actionKind = input.action.type === "think" ? "record_decision" : input.action.type;
      return guardedDb.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: agentSteps.id })
          .from(agentSteps)
          .where(and(eq(agentSteps.companyId, ctx.companyId), eq(agentSteps.id, input.stepId)));
        if (existing) return { inserted: false }; // exactly-once effect
        await tx.insert(agentSteps).values({
          id: input.stepId,
          companyId: ctx.companyId,
          agentSessionId: input.sessionId,
          agentId: input.agentId,
          taskId: input.taskId,
          stepNo: input.stepNo,
          actionKind,
          action: input.action as unknown as Record<string, unknown>,
          observation: input.observation,
          tokensIn: input.usage.inputTokens,
          tokensOut: input.usage.outputTokens,
          costCents: input.costCents,
          durationMs: input.durationMs,
        });
        await tx
          .update(agentSessions)
          .set({
            stepsCount: sql`GREATEST(${agentSessions.stepsCount}, ${input.stepNo})`,
            tokensIn: sql`${agentSessions.tokensIn} + ${input.usage.inputTokens}`,
            tokensOut: sql`${agentSessions.tokensOut} + ${input.usage.outputTokens}`,
            costCents: sql`${agentSessions.costCents} + ${input.costCents}`,
          })
          .where(and(eq(agentSessions.companyId, ctx.companyId), eq(agentSessions.id, input.sessionId)));
        return { inserted: true };
      }).then(async (result) => {
        // per-step cost through CostService (08 §13, T34): idempotent id,
        // breach detection + company circuit breaker fire from agent spend
        if (result.inserted && input.costCents > 0) {
          await costService.recordCost(ctx, {
            id: uuidv5("llm-cost", input.stepId),
            kind: "llm",
            ref: uuidv5(`llm:0`, input.stepId),
            amountCents: input.costCents,
            quantity: input.usage.inputTokens + input.usage.outputTokens,
            agentId: input.agentId,
            taskId: input.taskId,
          });
        }
        return result;
      });
    },

    /** Guard snapshot (08 §3): budget remaining + deadline, refreshed per step. */
    async getGuardSnapshotActivity(input: SessionRef): Promise<{
      budgetCents: number | null;
      spentCents: number;
      remainingCents: number | null;
      estimatedNextStepCents: number;
      deadline: string | null;
    }> {
      const ctx = companyContext(input.companyId);
      const [task] = await guardedDb
        .select({
          budgetCents: tasks.budgetCents,
          spentCents: tasks.spentCents,
          deadline: tasks.deadline,
        })
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
      const recent = await guardedDb
        .select({ costCents: agentSteps.costCents })
        .from(agentSteps)
        .where(
          and(eq(agentSteps.companyId, ctx.companyId), eq(agentSteps.agentSessionId, input.sessionId)),
        )
        .orderBy(sql`${agentSteps.stepNo} DESC`)
        .limit(5);
      const avg =
        recent.length > 0
          ? recent.reduce((s, r) => s + r.costCents, 0) / recent.length
          : 0;
      return {
        budgetCents: task?.budgetCents ?? null,
        spentCents: task?.spentCents ?? 0,
        remainingCents: task?.budgetCents === null ? null : (task?.budgetCents ?? 0) - (task?.spentCents ?? 0),
        estimatedNextStepCents: Math.ceil(avg * 1.5),
        deadline: task?.deadline?.toISOString() ?? null,
      };
    },

    /** Guard enforcement (08 §9): forced help/escalation to the manager —
     *  message via the ONE send path + agent.guard.triggered/agent.escalated
     *  events + task WAITING (budget/loop/step_cap) per the guard table. */
    async guardEscalateActivity(input: SessionRef & {
      stepId: string;
      guard: "budget" | "deadline" | "step_cap" | "loop" | "ping_pong" | "depth";
      detail: string;
    }): Promise<void> {
      const ctx = companyContext(input.companyId);
      await guardedDb.transaction(async (tx) => {
        await emitDomainEvent(tx, ctx, {
          type: "agent.guard.triggered",
          actor: { kind: "system", id: null },
          agentId: input.agentId,
          taskId: input.taskId,
          payload: { guard: input.guard, context: { detail: input.detail } },
        });
        await emitDomainEvent(tx, ctx, {
          type: "agent.escalated",
          actor: { kind: "system", id: null },
          agentId: input.agentId,
          taskId: input.taskId,
          payload: {
            reason: `guard ${input.guard}: ${input.detail}`,
            attempted: [],
            recommendation: "manager intervention",
            guardFlag: input.guard,
          },
        });
      });
      // help message into the task thread (best-effort — thread may not exist
      // for directly-inserted fixture tasks)
      try {
        const thread = await guardedDb.transaction((tx) =>
          channelService.provisionInTx(tx, ctx, {
            kind: "task_thread",
            taskId: input.taskId,
            memberAgentIds: [input.agentId],
          }),
        );
        await messageService.send(ctx, {
          channelId: thread.id,
          senderAgentId: input.agentId,
          kind: "help_request",
          body: `Guard ${input.guard} tripped: ${input.detail}`,
          refs: [{ kind: "task", id: input.taskId }],
          idempotencyKey: uuidv5(`guard-msg:${input.guard}`, input.stepId),
        });
      } catch {
        /* message is advisory; events already durable */
      }
      // budget/step_cap/loop park the task (08 §9a/c/d); deadline only escalates
      if (input.guard !== "deadline") {
        const [current] = await guardedDb
          .select({ status: tasks.status })
          .from(tasks)
          .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
        if (current?.status === "IN_PROGRESS") {
          await taskState.transition(ctx, input.taskId, "WAITING", { kind: "system" }, {
            note: `guard ${input.guard}`,
          });
        }
      }
    },

    /** wake from wait_for: WAITING→IN_PROGRESS (system actor, 07 §5). */
    async resumeFromWaitActivity(input: SessionRef): Promise<void> {
      const ctx = companyContext(input.companyId);
      const [current] = await guardedDb
        .select({ status: tasks.status })
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
      if (current?.status === "WAITING") {
        await taskState.transition(ctx, input.taskId, "IN_PROGRESS", { kind: "system" });
      }
    },

    /** Workflow-timer expiry fallback (19 §6/§7): if the wait on the verdict
     *  times out at the derived expiry, the workflow closes the approval
     *  itself. Idempotent against the server sweep — whoever commits first
     *  wins; the returned status is the settled truth for the next step. */
    async expireApprovalActivity(input: SessionRef & { approvalId: string }): Promise<{
      status: string;
    }> {
      const ctx = companyContext(input.companyId);
      const { row } = await approvalsService.expire(ctx, input.approvalId);
      return { status: row.status };
    },

    /** Inbox triage (08 §7): cheap model classifies items act|queue|ignore;
     *  no fast route resolves ⇒ ignore (still marks read). */
    async triageInboxActivity(input: {
      companyId: string;
      agentId: string;
      items: InboxItem[];
    }): Promise<{ verdict: "act" | "queue" | "ignore" }> {
      const ctx = companyContext(input.companyId);
      try {
        const routing = await deps.routingFor(ctx, input.agentId);
        const result = await deps.router.complete(
          {
            purpose: "fast",
            messages: [
              {
                role: "system",
                content:
                  'Triage the inbox items. Reply with exactly one JSON object {"verdict":"act"|"queue"|"ignore"}.',
              },
              {
                role: "user",
                content: input.items.map((i) => `${i.kind}: ${i.preview}`).join("\n"),
              },
            ],
            agentId: input.agentId,
          },
          routing,
        );
        const parsed = JSON.parse(result.text) as { verdict?: string };
        if (parsed.verdict === "act" || parsed.verdict === "queue") return { verdict: parsed.verdict };
        return { verdict: "ignore" };
      } catch {
        return { verdict: "ignore" }; // no fast profile / parse failure — FYI path
      }
    },

    async markInboxReadActivity(input: {
      companyId: string;
      agentId: string;
      channelIds: string[];
    }): Promise<void> {
      const ctx = companyContext(input.companyId);
      for (const channelId of new Set(input.channelIds)) {
        await channelService.markRead(ctx, channelId, input.agentId);
      }
    },

    async closeAgentSessionActivity(input: SessionRef & {
      status: "completed" | "failed" | "cancelled";
    }): Promise<void> {
      const ctx = companyContext(input.companyId);
      await guardedDb.transaction(async (tx) => {
        const [session] = await tx
          .select()
          .from(agentSessions)
          .where(and(eq(agentSessions.companyId, ctx.companyId), eq(agentSessions.id, input.sessionId)))
          .for("update");
        if (!session || session.endedAt) return; // idempotent
        await tx
          .update(agentSessions)
          .set({ status: input.status, currentActivity: "IDLE", endedAt: sql`now()` })
          .where(and(eq(agentSessions.companyId, ctx.companyId), eq(agentSessions.id, input.sessionId)));
        await emitDomainEvent(tx, ctx, {
          type: "agent.session.ended",
          actor: { kind: "system", id: null },
          agentId: input.agentId,
          taskId: input.taskId,
          payload: {
            sessionId: input.sessionId,
            status: input.status,
            steps: session.stepsCount,
            tokens: session.tokensIn + session.tokensOut,
            costCents: session.costCents,
          },
        });
        await emitDomainEvent(tx, ctx, {
          type: "agent.status.changed",
          actor: { kind: "system", id: null },
          agentId: input.agentId,
          payload: { sessionId: input.sessionId, from: "WORKING", to: "IDLE" },
        });
      });
    },
  };
}

export type AgentTaskActivities = ReturnType<typeof createAgentTaskActivities>;

/** Prod routing loader: agent bindings + company profiles from the DB. */
export function createDbRoutingLoader(guardedDb: GuardedDb) {
  return async (ctx: CompanyContext, agentId: string): Promise<RoutingContext> => {
    const bindings = await guardedDb
      .select()
      .from(agentModelBindings)
      .where(and(eq(agentModelBindings.companyId, ctx.companyId), eq(agentModelBindings.agentId, agentId)));
    const profiles = await guardedDb
      .select()
      .from(modelProfiles)
      .where(and(eq(modelProfiles.companyId, ctx.companyId), eq(modelProfiles.enabled, true)));
    return {
      bindings: bindings.map((b) => ({
        purpose: b.purpose as "primary" | "fast" | "embedding",
        providerId: b.providerId,
        model: b.model,
        params: (b.params ?? {}) as Record<string, unknown>,
        priority: b.priority,
      })),
      profiles: profiles.map((p) => ({
        purpose: p.purpose as RoutingContext["profiles"][number]["purpose"],
        providerId: p.providerId,
        model: p.model,
        params: (p.params ?? {}) as Record<string, unknown>,
        priority: p.priority,
        enabled: p.enabled,
        maxTokensPerCall: p.maxTokensPerCall,
        costCapCentsPerCall: p.costCapCentsPerCall,
      })),
    };
  };
}
