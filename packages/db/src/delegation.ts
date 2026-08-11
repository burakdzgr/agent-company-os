// Delegation engine core — moved to @acos/db (T34): the worker's
// create_task/delegate_task action dispatch shares this implementation.
import { and, eq, isNull, sql } from "drizzle-orm";
import { parseEventPayload } from "@acos/events";
import { appendEvents, type NewEventInput, type Tx } from "./outbox.js";
import type { CompanyContext } from "./context.js";
import type { GuardedDb } from "./tenant.js";
import { agents, budgets, orgEdges, positions, tasks } from "./schema/index.js";
import {
  TaskEngineError,
  TasksService,
  TaskStateService,
  type TaskRow,
} from "./task-engine.js";

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

/** 07 §6.1 [WRITER-DECISION] defaults by position role (schema keeps the
 *  canonical 20 §4 columns — no wip_limit column, so limits are role-derived
 *  and configurable later via settings). */
export const WIP_LIMIT_BY_ROLE: Record<string, number> = {
  member: 2,
  reviewer: 2,
  lead: 3,
  manager: 5,
  executive: 8,
};
export const ASSIGNED_QUEUE_CAP = 5;
export const TEAM_WIP_MULTIPLIER = 2;
const ACTIVE_WIP_STATUSES = ["IN_PROGRESS", "REVIEW", "CHANGES_REQUESTED", "QA_FAILED", "REJECTED"];

export type DelegationResult =
  | { ok: true; task: TaskRow }
  | {
      ok: false;
      reason: "WIP_LIMIT" | "QUEUE_CAP" | "TEAM_WIP_LIMIT";
      candidates: Array<{ agentId: string; name: string; activeWip: number; assignedQueue: number }>;
    };

export class DelegationService {
  constructor(
    private readonly db: GuardedDb,
    private readonly tasksService: TasksService,
    private readonly taskState: TaskStateService,
  ) {}

  /** create_task action semantics: hierarchy + depth via TasksService; the
   *  effort weight (1–13 fibonacci) rides in context for the budget split. */
  async createChildTask(
    ctx: CompanyContext,
    managerAgentId: string,
    input: {
      parentTaskId: string;
      kind: string;
      title: string;
      objective: string;
      priority?: string | undefined;
      estimatedEffort?: number | undefined;
      successCriteria?: string[] | undefined;
      risk?: string | undefined;
      orgUnitId?: string | undefined;
      projectId?: string | undefined;
    },
  ): Promise<TaskRow> {
    return this.tasksService.create(
      ctx,
      {
        parentId: input.parentTaskId,
        kind: input.kind,
        title: input.title,
        objective: input.objective,
        priority: input.priority,
        successCriteria: input.successCriteria,
        risk: input.risk,
        orgUnitId: input.orgUnitId,
        projectId: input.projectId,
        context: { estimatedEffort: input.estimatedEffort ?? 1 },
      },
      { kind: "agent", agentId: managerAgentId },
    );
  }

  /**
   * delegate_task action semantics (07 §6): reporting-line check → capacity
   * check (same tx as the assignment) → pro-rata budget materialization →
   * PLANNED→ASSIGNED via the single status writer. On the reassignment-limit
   * trip a P1 manager-intervention task is auto-created (07 §8).
   */
  async delegateTask(
    ctx: CompanyContext,
    managerAgentId: string,
    taskId: string,
    toAgentId: string,
    opts: { budgetOverrideCents?: number | undefined; force?: boolean | undefined } = {},
  ): Promise<DelegationResult> {
    const allowed = await this.mayDelegate(ctx, managerAgentId, toAgentId);
    if (!allowed.ok) {
      throw new TaskEngineError("TASK_TRANSITION_INVALID", allowed.reason);
    }

    const capacity = await this.capacityCheck(ctx, toAgentId);
    if (!capacity.ok) return capacity;

    // a freshly decomposed child is DRAFT — the delegating manager grooms it
    // through the single status writer (DRAFT→BACKLOG→PLANNED, both moves
    // creator/manager-permitted per 07 §5) so the assign lands on PLANNED
    // and the owner's workflow can start (T36)
    const [current] = await this.db
      .select({ status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
    if (!current) throw new TaskEngineError("TASK_NOT_FOUND", "task not found");
    let status = current.status;
    if (status === "DRAFT") {
      await this.taskState.transition(ctx, taskId, "BACKLOG", { kind: "agent", agentId: managerAgentId }, { note: "delegation grooming" });
      status = "BACKLOG";
    }
    if (status === "BACKLOG") {
      await this.taskState.transition(ctx, taskId, "PLANNED", { kind: "agent", agentId: managerAgentId }, { note: "delegation grooming" });
    }

    try {
      const task = await this.taskState.assign(
        ctx,
        taskId,
        { agentId: toAgentId, reason: "delegated" },
        { kind: "agent", agentId: managerAgentId },
        { force: opts.force ?? false },
      );
      await this.allocateBudget(ctx, task, opts.budgetOverrideCents);
      const [fresh] = await this.db
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
      return { ok: true, task: fresh! };
    } catch (err) {
      if (err instanceof TaskEngineError && err.code === "TASK_REASSIGNMENT_LIMIT") {
        await this.flagManagerIntervention(ctx, taskId, managerAgentId);
      }
      throw err;
    }
  }

  // ---------- context-sentinel resolution (T36) ----------

  /**
   * "The next task to hand off": the oldest open, unowned child of the
   * delegator's current task — each delegation consumes one child FIFO.
   */
  async resolveNextChildTask(ctx: CompanyContext, parentTaskId: string): Promise<TaskRow | null> {
    const [child] = await this.db
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, ctx.companyId),
          eq(tasks.parentId, parentTaskId),
          isNull(tasks.ownerAgentId),
          sql`${tasks.status} IN ('DRAFT','BACKLOG','PLANNED')`,
        ),
      )
      .orderBy(tasks.number)
      .limit(1);
    return child ?? null;
  }

  /**
   * "An eligible report": an explicit `@Name` mention wins; otherwise the
   * least-loaded ACTIVE direct report (manages edge) the reporting-line rule
   * permits, tie-broken by employee number. Deterministic, so scripted and
   * live runs agree.
   */
  async resolveDelegateTarget(
    ctx: CompanyContext,
    managerAgentId: string,
    note: string,
  ): Promise<string | null> {
    if (note.includes("@")) {
      const active = await this.db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.status, "active")));
      const named = active
        .filter((a) => note.includes(`@${a.name}`))
        .sort((a, b) => b.name.length - a.name.length)[0];
      if (named) return named.id;
    }
    const reports = await this.db.execute(sql`
      SELECT a.id, a.employee_number,
        (SELECT count(*)::int FROM tasks t
          WHERE t.company_id = ${ctx.companyId} AND t.owner_agent_id = a.id
            AND t.status IN ('IN_PROGRESS','REVIEW','CHANGES_REQUESTED','QA_FAILED','REJECTED','ASSIGNED')) AS load
      FROM org_edges e
      JOIN agents a ON a.id = e.to_agent_id AND a.company_id = e.company_id
      WHERE e.company_id = ${ctx.companyId} AND e.from_agent_id = ${managerAgentId}
        AND e.kind = 'manages' AND e.ended_at IS NULL AND a.status = 'active'
      ORDER BY load ASC, a.employee_number ASC
    `);
    for (const row of reports.rows as Array<{ id: string }>) {
      const allowed = await this.mayDelegate(ctx, managerAgentId, row.id);
      if (allowed.ok) return row.id;
    }
    return null;
  }

  // ---------- reporting-line rule (07 §6) ----------

  private async mayDelegate(
    ctx: CompanyContext,
    managerAgentId: string,
    toAgentId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (managerAgentId === toAgentId) return { ok: true }; // self-assignment of own subtask
    const [managerRow] = await this.db
      .select({ defaultRole: positions.defaultRole })
      .from(agents)
      .innerJoin(positions, eq(agents.positionId, positions.id))
      .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, managerAgentId)));
    const [targetRow] = await this.db
      .select({ defaultRole: positions.defaultRole })
      .from(agents)
      .innerJoin(positions, eq(agents.positionId, positions.id))
      .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, toAgentId)));
    if (!managerRow || !targetRow) return { ok: false, reason: "agent not found" };

    if (managerRow.defaultRole === "executive") {
      // CEO-level (top of the forest) delegates to executives/managers/leads,
      // never to individual contributors (07 §6 policy rule)
      const [reportsUp] = await this.db
        .select({ id: orgEdges.id })
        .from(orgEdges)
        .where(
          and(
            eq(orgEdges.companyId, ctx.companyId),
            eq(orgEdges.fromAgentId, managerAgentId),
            eq(orgEdges.kind, "reports_to"),
            isNull(orgEdges.endedAt),
          ),
        );
      const isTop = !reportsUp;
      if (isTop && !["executive", "manager", "lead"].includes(targetRow.defaultRole)) {
        return { ok: false, reason: "CEO-level agents delegate to executives, never to ICs" };
      }
      return { ok: true }; // executives hold cross_team_delegation
    }

    // transitive manages/leads closure downward from the manager
    const closure = await this.db.execute(sql`
      WITH RECURSIVE down AS (
        SELECT e.to_agent_id FROM org_edges e
        WHERE e.company_id = ${ctx.companyId} AND e.from_agent_id = ${managerAgentId}
          AND e.kind = 'manages' AND e.ended_at IS NULL
        UNION
        SELECT e.to_agent_id FROM org_edges e
        JOIN down ON e.from_agent_id = down.to_agent_id
        WHERE e.company_id = ${ctx.companyId} AND e.kind = 'manages' AND e.ended_at IS NULL
      )
      SELECT 1 FROM down WHERE to_agent_id = ${toAgentId} LIMIT 1
    `);
    if (closure.rows.length === 0) {
      return {
        ok: false,
        reason: "delegation follows reporting lines: target is outside the manages/leads closure",
      };
    }
    return { ok: true };
  }

  // ---------- capacity model (07 §6.1) ----------

  async capacityCheck(ctx: CompanyContext, toAgentId: string): Promise<DelegationResult> {
    const [target] = await this.db
      .select({
        id: agents.id,
        orgUnitId: agents.orgUnitId,
        defaultRole: positions.defaultRole,
      })
      .from(agents)
      .innerJoin(positions, eq(agents.positionId, positions.id))
      .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, toAgentId)));
    if (!target) throw new TaskEngineError("TASK_NOT_FOUND", "target agent not found");

    const load = async (agentId: string) => {
      const result = await this.db.execute(sql`
        SELECT
          count(*) FILTER (WHERE status IN ('IN_PROGRESS','REVIEW','CHANGES_REQUESTED','QA_FAILED','REJECTED'))::int AS active,
          count(*) FILTER (WHERE status = 'ASSIGNED')::int AS queued
        FROM tasks WHERE company_id = ${ctx.companyId} AND owner_agent_id = ${agentId}
      `);
      const row = result.rows[0] as { active: number; queued: number };
      return { active: Number(row.active), queued: Number(row.queued) };
    };

    const wipLimit = WIP_LIMIT_BY_ROLE[target.defaultRole] ?? 2;
    const targetLoad = await load(toAgentId);

    const candidates = async () => {
      const team = await this.db
        .select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(
          and(
            eq(agents.companyId, ctx.companyId),
            eq(agents.orgUnitId, target.orgUnitId),
            eq(agents.status, "active"),
          ),
        );
      const withLoad = [];
      for (const member of team) {
        if (member.id === toAgentId) continue;
        const memberLoad = await load(member.id);
        withLoad.push({
          agentId: member.id,
          name: member.name,
          activeWip: memberLoad.active,
          assignedQueue: memberLoad.queued,
        });
      }
      return withLoad.sort((a, b) => a.activeWip - b.activeWip);
    };

    if (targetLoad.active >= wipLimit) {
      return { ok: false, reason: "WIP_LIMIT", candidates: await candidates() };
    }
    if (targetLoad.queued >= ASSIGNED_QUEUE_CAP) {
      return { ok: false, reason: "QUEUE_CAP", candidates: await candidates() };
    }

    // team umbrella: 2 × active member count (07 §6.1)
    const teamResult = await this.db.execute(sql`
      SELECT
        (SELECT count(*)::int FROM agents
          WHERE company_id = ${ctx.companyId} AND org_unit_id = ${target.orgUnitId}
            AND status = 'active') AS members,
        (SELECT count(*)::int FROM tasks t
          JOIN agents a ON a.id = t.owner_agent_id AND a.company_id = t.company_id
          WHERE t.company_id = ${ctx.companyId} AND a.org_unit_id = ${target.orgUnitId}
            AND t.status IN ('IN_PROGRESS','REVIEW','CHANGES_REQUESTED','QA_FAILED','REJECTED')) AS team_wip
    `);
    const team = teamResult.rows[0] as { members: number; team_wip: number };
    if (Number(team.team_wip) >= TEAM_WIP_MULTIPLIER * Number(team.members)) {
      return { ok: false, reason: "TEAM_WIP_LIMIT", candidates: await candidates() };
    }
    return { ok: true, task: undefined as never };
  }

  // ---------- pro-rata budget inheritance (07 §9, 26 §4) ----------

  /**
   * floor(B × 0.8 × wi / Σw) with 20% reserved at the parent; later children
   * draw from the remaining 80%-pool. Materialized as a budgets row
   * (scope=task, period=total, mode=hard) so guards never walk the tree.
   */
  private async allocateBudget(
    ctx: CompanyContext,
    task: TaskRow,
    overrideCents?: number,
  ): Promise<void> {
    if (task.budgetCents !== null) return; // explicit budget — nothing to inherit
    if (!task.parentId) return;
    await this.db.transaction(async (tx) => {
      const [parent] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, task.parentId!)))
        .for("update");
      if (!parent || parent.budgetCents === null) return;

      const siblings = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.parentId, parent.id)));
      const allocated = siblings
        .filter((s) => s.id !== task.id && s.budgetCents !== null)
        .reduce((sum, s) => sum + (s.budgetCents ?? 0), 0);
      const pool = Math.floor(parent.budgetCents * 0.8) - allocated;
      if (pool <= 0) return;

      const effortOf = (t: TaskRow) =>
        Number((t.context as Record<string, unknown>).estimatedEffort ?? 1) || 1;
      // Σw runs over ALL open children (07 §9): the decompose batch shares
      // one denominator, so shares stay stable as siblings get delegated
      const openChildren = siblings.filter(
        (s) => !["DONE", "FAILED", "CANCELLED"].includes(s.status),
      );
      const totalWeight = openChildren.reduce((sum, s) => sum + effortOf(s), 0) || 1;
      const share = Math.min(
        pool,
        overrideCents ?? Math.floor((parent.budgetCents * 0.8 * effortOf(task)) / totalWeight),
      );
      if (share <= 0) return;

      await tx
        .update(tasks)
        .set({ budgetCents: share })
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, task.id)));
      const [budgetRow] = await tx
        .insert(budgets)
        .values({
          companyId: ctx.companyId,
          scopeKind: "task",
          scopeRef: task.id,
          period: "total",
          limitCents: share,
          kind: "hard",
        })
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "budget.created",
        actor: { kind: "system", id: null },
        taskId: task.id,
        payload: { budgetId: budgetRow!.id, scope: "task", limitCents: share },
      });
    });
  }

  // ---------- forced manager intervention (07 §8) ----------

  private async flagManagerIntervention(
    ctx: CompanyContext,
    taskId: string,
    managerAgentId: string,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const [task] = await tx
        .select()
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)))
        .for("update");
      if (!task) return;
      const context = task.context as Record<string, unknown>;
      if (context.needsManagerIntervention) return; // already flagged once
      await tx
        .update(tasks)
        .set({ context: { ...context, needsManagerIntervention: true } })
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
    });
    const [task] = await this.db
      .select()
      .from(tasks)
      .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
    if (!task || !(task.context as Record<string, unknown>).needsManagerIntervention) return;
    const existing = await this.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.companyId, ctx.companyId),
          sql`${tasks.context}->>'interventionFor' = ${taskId}`,
        ),
      );
    if (existing.length > 0) return;
    await this.tasksService.create(
      ctx,
      {
        kind: "task",
        title: `Reassignment limit reached: TASK-${task.number}`,
        objective:
          "The task hit the 3-reassignment limit (hot-potato guard). Review, then move it with an explicit force_reassign override.",
        priority: "P1",
        context: { interventionFor: taskId, forManagerAgentId: managerAgentId },
      },
      { kind: "agent", agentId: managerAgentId },
    );
  }
}

export { ACTIVE_WIP_STATUSES };
