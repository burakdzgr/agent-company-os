// agentTaskWorkflow activities (08 §3, T32). All IO of the loop lives here;
// the workflow only orchestrates. Effects are exactly-once at the DB via
// stepId-derived idempotency keys (08 §11). Task transitions go through the
// ONE status writer (TaskStateService — @acos/db/task-engine).
import { and, eq, sql } from "drizzle-orm";
import { uuidv5 } from "@acos/domain";
import { parseEventPayload } from "@acos/events";
import {
  TaskStateService,
  appendEvents,
  companyContext,
  type CompanyContext,
  type GuardedDb,
  type NewEventInput,
  type Tx,
} from "@acos/db";
import {
  agentModelBindings,
  agentSessions,
  agentSteps,
  agents,
  costEntries,
  llmCalls,
  modelProfiles,
  positions,
  tasks,
} from "@acos/db/schema";
import type { ModelRouter, RoutingContext, LlmMessage, LlmUsage } from "@acos/llm";
import type { AgentAction } from "@acos/llm/agent-action";

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

export interface AgentTaskActivityDeps {
  guardedDb: GuardedDb;
  router: ModelRouter;
  /** RoutingContext loader — DB bindings/profiles in prod, fixed in scripted mode. */
  routingFor(ctx: CompanyContext, agentId: string): Promise<RoutingContext>;
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

    /** 08 §8 section order; memory sections land with T45, thread with T33. */
    async buildWorkingSetActivity(input: SessionRef & { stepNo: number }): Promise<WorkingSet> {
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
        `[taskFixture:${String(taskContext.taskFixture ?? "none")}]`,
        `[lastExitCode:${lastObservation?.exitCode ?? 0}]`,
        ...Object.entries(lastObservation?.signal ?? {}).map(([k, v]) => `[signal:${k}=${v}]`),
      ].join(" ");

      // sections 1–10 of 08 §8 (memory 4–6 and thread 7 are placeholders
      // until T45/T33; token budgets enforced with the char/4 heuristic there)
      const system = [
        `You are ${agentRow.name}, ${agentRow.positionTitle} (${agentRow.seniority}, autonomy L${agentRow.autonomyLevel}).`,
        agentRow.persona,
        `Non-negotiable rules: act only via a single AgentAction JSON object; never invent tools.`,
        markers,
      ].join("\n");
      const user = [
        `# Org context\nEscalation chain: ${managers.join(" -> ") || "(top level)"} -> Founder`,
        `# Task TASK-${task.number}: ${task.title}\nObjective: ${task.objective}\nStatus: ${task.status} | Priority: ${task.priority} | Risk: ${task.risk}\nSuccess criteria: ${task.successCriteria.join("; ") || "(none)"}\nBudget remaining cents: ${task.budgetCents === null ? "inherit" : task.budgetCents - task.spentCents}`,
        `# Recent steps\n${recentSteps
          .slice()
          .reverse()
          .map((s) => `${s.stepNo}. ${s.actionKind} -> ${JSON.stringify(s.observation ?? {}).slice(0, 200)}`)
          .join("\n") || "(none yet)"}`,
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
      switch (action.type) {
        case "update_task_status": {
          const updated = await taskState.transition(ctx, action.taskId, action.to, {
            kind: "agent",
            agentId: input.agentId,
          }, { note: action.note });
          return { ok: true, status: updated.status };
        }
        case "request_review": {
          // owner submits: IN_PROGRESS→REVIEW (07 §5); review row + reviewer
          // workflow land with T43/T33
          const updated = await taskState.transition(ctx, action.taskId, "REVIEW", {
            kind: "agent",
            agentId: input.agentId,
          }, { note: action.summary });
          return { ok: true, status: updated.status, reviewRequested: true };
        }
        case "use_tool": {
          // Tool Gateway (T39) + execution queue (T40) replace this stub; the
          // observation shape matches what scripted branches key on
          return { ok: true, tool: action.tool, exitCode: 0, stub: true, input: action.input };
        }
        case "think":
          return { ok: true, thought: true };
        case "complete_task":
          return { ok: true, completed: true };
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
        if (input.costCents > 0) {
          await tx.insert(costEntries).values({
            id: uuidv5("llm-cost", input.stepId),
            companyId: ctx.companyId,
            kind: "llm",
            ref: uuidv5("llm", input.stepId),
            agentId: input.agentId,
            taskId: input.taskId,
            amountCents: input.costCents,
            quantity: String(input.usage.inputTokens + input.usage.outputTokens),
          });
          await tx
            .update(tasks)
            .set({ spentCents: sql`${tasks.spentCents} + ${input.costCents}` })
            .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, input.taskId)));
        }
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
      });
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
