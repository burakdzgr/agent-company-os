// Agents module (05 §1–4, §7; _DECISIONS §6): hire in ONE transaction
// (04 §6.1), lifecycle via the canonical state machine, model bindings as the
// ONLY agent↔model linkage (sacred invariant), sessions read API.
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { agentMachine, formatEmployeeNumber } from "@acos/domain";
import {
  nextSequenceValue,
  type CompanyContext,
  type GuardedDb,
} from "@acos/db";
import {
  agentModelBindings,
  agentSessions,
  agents,
  modelProfiles,
  orgEdges,
} from "@acos/db/schema";
import { OrgService, orgLockInTx } from "../org/service.js";
import { emitDomainEvent } from "../events/emit.js";

export type AgentRow = typeof agents.$inferSelect;
export type BindingRow = typeof agentModelBindings.$inferSelect;
export type AgentStatus = "draft" | "active" | "paused" | "offboarded";
export type BindingPurpose = "primary" | "fast" | "embedding";

export class AgentLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLifecycleError";
  }
}

/** model_profiles purposes → binding purposes (05 §7 resolution order). */
const PROFILE_TO_BINDING: Record<string, BindingPurpose> = {
  reasoning: "primary",
  fast: "fast",
  embedding: "embedding",
};

export class AgentsService {
  constructor(
    private readonly db: GuardedDb,
    private readonly org: OrgService,
  ) {}

  /**
   * 04 §6.1: allocate employee_number → insert agent → member_of +
   * reports_to (+ inverse manages) edges → seed bindings from company
   * profiles → agent.hired (+ org.edge.created ×N) — all one transaction.
   */
  async hire(
    ctx: CompanyContext,
    input: {
      name: string;
      positionId: string;
      orgUnitId: string;
      seniority: string;
      autonomyLevel: number;
      persona: string;
      avatarUrl?: string | null | undefined;
      managerAgentId?: string | null | undefined;
      leadsUnit?: boolean | undefined;
      activate?: boolean | undefined;
    },
  ): Promise<AgentRow> {
    return this.db.transaction(async (tx) => {
      await orgLockInTx(tx, ctx);
      const employeeNumber = await nextSequenceValue(tx, ctx, "employee_number");
      const [agent] = await tx
        .insert(agents)
        .values({
          companyId: ctx.companyId,
          employeeNumber,
          name: input.name,
          avatarUrl: input.avatarUrl ?? null,
          status: input.activate ? "active" : "draft",
          positionId: input.positionId,
          orgUnitId: input.orgUnitId,
          seniority: input.seniority,
          autonomyLevel: input.autonomyLevel,
          persona: input.persona,
          employment: { hired_at: new Date().toISOString() },
        })
        .returning();

      await this.org.createEdgeInTx(tx, ctx, {
        fromAgentId: agent!.id,
        kind: "member_of",
        toUnitId: input.orgUnitId,
      });
      if (input.managerAgentId) {
        await this.org.createEdgeInTx(tx, ctx, {
          fromAgentId: agent!.id,
          kind: "reports_to",
          toAgentId: input.managerAgentId,
        });
      }
      if (input.leadsUnit) {
        await this.org.createEdgeInTx(tx, ctx, {
          fromAgentId: agent!.id,
          kind: "leads",
          toUnitId: input.orgUnitId,
        });
      }

      // Seed bindings from the company's default model profiles (04 §6.1).
      const profiles = await tx
        .select()
        .from(modelProfiles)
        .where(and(eq(modelProfiles.companyId, ctx.companyId), eq(modelProfiles.enabled, true)))
        .orderBy(asc(modelProfiles.priority));
      const seeded = new Set<BindingPurpose>();
      for (const profile of profiles) {
        const purpose = PROFILE_TO_BINDING[profile.purpose];
        if (!purpose || seeded.has(purpose)) continue;
        seeded.add(purpose);
        await tx.insert(agentModelBindings).values({
          companyId: ctx.companyId,
          agentId: agent!.id,
          purpose,
          providerId: profile.providerId,
          model: profile.model,
          params: profile.params ?? {},
        });
      }

      await emitDomainEvent(tx, ctx, {
        type: "agent.hired",
        actor: { kind: "founder", id: null },
        agentId: agent!.id,
        payload: {
          agentId: agent!.id,
          employeeNumber,
          name: agent!.name,
          positionId: agent!.positionId,
          orgUnitId: agent!.orgUnitId,
          seniority: agent!.seniority as never,
        },
      });
      if (input.activate) {
        await emitDomainEvent(tx, ctx, {
          type: "agent.started",
          actor: { kind: "founder", id: null },
          agentId: agent!.id,
          payload: { agentId: agent!.id },
        });
      }
      return agent!;
    });
  }

  // ---------- lifecycle (05 §1, §3) ----------

  private async transition(
    ctx: CompanyContext,
    agentId: string,
    to: AgentStatus,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<AgentRow> {
    return this.db.transaction(async (tx) => {
      const [agent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)))
        .for("update");
      if (!agent) throw new AgentLifecycleError("AGENT_NOT_FOUND");
      if (!agentMachine.canTransition(agent.status as AgentStatus, to)) {
        throw new AgentLifecycleError(`illegal transition ${agent.status} → ${to}`);
      }
      const [updated] = await tx
        .update(agents)
        .set({ status: to })
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)))
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: eventType,
        actor: { kind: "founder", id: null },
        agentId,
        payload,
      });
      return updated!;
    });
  }

  /** 05 §3.1: requires resolvable primary model + reporting line (or explicit top level). */
  async activate(ctx: CompanyContext, agentId: string, topLevel = false): Promise<AgentRow> {
    const [binding] = await this.db
      .select()
      .from(agentModelBindings)
      .where(
        and(
          eq(agentModelBindings.companyId, ctx.companyId),
          eq(agentModelBindings.agentId, agentId),
          eq(agentModelBindings.purpose, "primary"),
        ),
      );
    if (!binding) {
      const [profile] = await this.db
        .select()
        .from(modelProfiles)
        .where(
          and(
            eq(modelProfiles.companyId, ctx.companyId),
            eq(modelProfiles.purpose, "reasoning"),
            eq(modelProfiles.enabled, true),
          ),
        );
      if (!profile) throw new AgentLifecycleError("MODEL_UNRESOLVABLE: no primary binding or company reasoning profile");
    }
    if (!topLevel) {
      const [edge] = await this.db
        .select()
        .from(orgEdges)
        .where(
          and(
            eq(orgEdges.companyId, ctx.companyId),
            eq(orgEdges.fromAgentId, agentId),
            eq(orgEdges.kind, "reports_to"),
            isNull(orgEdges.endedAt),
          ),
        );
      if (!edge) throw new AgentLifecycleError("NO_REPORTING_LINE: set a manager or activate as top-level");
    }
    return this.transition(ctx, agentId, "active", "agent.started", { agentId });
  }

  async pause(ctx: CompanyContext, agentId: string, reason?: string): Promise<AgentRow> {
    return this.transition(ctx, agentId, "paused", "agent.paused", { reason });
  }

  async resume(ctx: CompanyContext, agentId: string, reason?: string): Promise<AgentRow> {
    return this.transition(ctx, agentId, "active", "agent.resumed", { reason });
  }

  /** 05 §3.3 (v1): end all edges, re-point direct reports, retain memory/history. */
  async offboard(ctx: CompanyContext, agentId: string, reason?: string): Promise<AgentRow> {
    return this.db.transaction(async (tx) => {
      await orgLockInTx(tx, ctx);
      const [agent] = await tx
        .select()
        .from(agents)
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)))
        .for("update");
      if (!agent) throw new AgentLifecycleError("AGENT_NOT_FOUND");
      if (!agentMachine.canTransition(agent.status as AgentStatus, "offboarded")) {
        throw new AgentLifecycleError(`illegal transition ${agent.status} → offboarded`);
      }

      // former manager (for re-pointing direct reports)
      const [managerEdge] = await tx
        .select()
        .from(orgEdges)
        .where(
          and(
            eq(orgEdges.companyId, ctx.companyId),
            eq(orgEdges.fromAgentId, agentId),
            eq(orgEdges.kind, "reports_to"),
            isNull(orgEdges.endedAt),
          ),
        );
      const formerManagerId = managerEdge?.toAgentId ?? null;

      const reports = await tx
        .select()
        .from(orgEdges)
        .where(
          and(
            eq(orgEdges.companyId, ctx.companyId),
            eq(orgEdges.toAgentId, agentId),
            eq(orgEdges.kind, "reports_to"),
            isNull(orgEdges.endedAt),
          ),
        );

      // end ALL active edges touching the agent
      const ended = await tx
        .update(orgEdges)
        .set({ endedAt: sql`now()` })
        .where(
          and(
            eq(orgEdges.companyId, ctx.companyId),
            isNull(orgEdges.endedAt),
            or(eq(orgEdges.fromAgentId, agentId), eq(orgEdges.toAgentId, agentId)),
          ),
        )
        .returning({ id: orgEdges.id, endedAt: orgEdges.endedAt });
      for (const edge of ended) {
        await emitDomainEvent(tx, ctx, {
          type: "org.edge.ended",
          actor: { kind: "founder", id: null },
          agentId,
          payload: { edgeId: edge.id, endedAt: edge.endedAt?.toISOString(), reason: "offboarding" },
        });
      }

      // re-point direct reports to the former manager (explicit new edges)
      if (formerManagerId) {
        for (const report of reports) {
          await this.org.createEdgeInTx(tx, ctx, {
            fromAgentId: report.fromAgentId,
            kind: "reports_to",
            toAgentId: formerManagerId,
          });
        }
      }

      const employment = {
        ...(agent.employment as Record<string, unknown>),
        offboarded_at: new Date().toISOString(),
      };
      const [updated] = await tx
        .update(agents)
        .set({ status: "offboarded", employment })
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)))
        .returning();
      await emitDomainEvent(tx, ctx, {
        type: "agent.offboarded",
        actor: { kind: "founder", id: null },
        agentId,
        payload: { reason, memoryDisposition: "retained" },
      });
      return updated!;
    });
  }

  async update(
    ctx: CompanyContext,
    agentId: string,
    patch: {
      persona?: string | undefined;
      avatarUrl?: string | null | undefined;
      autonomyLevel?: number | undefined;
    },
  ): Promise<AgentRow | undefined> {
    const cleaned = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    if (Object.keys(cleaned).length === 0) return this.get(ctx, agentId);
    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(agents)
        .set(cleaned)
        .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)))
        .returning();
      if (!updated) return undefined;
      await emitDomainEvent(tx, ctx, {
        type: "agent.updated",
        actor: { kind: "founder", id: null },
        agentId,
        payload: { diff: cleaned },
      });
      return updated;
    });
  }

  async get(ctx: CompanyContext, agentId: string): Promise<AgentRow | undefined> {
    const [row] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)));
    return row;
  }

  async list(ctx: CompanyContext): Promise<AgentRow[]> {
    return this.db
      .select()
      .from(agents)
      .where(eq(agents.companyId, ctx.companyId))
      .orderBy(asc(agents.employeeNumber));
  }

  // ---------- model bindings (05 §7 — hot-swap, identity untouched) ----------

  async setBinding(
    ctx: CompanyContext,
    agentId: string,
    input: {
      purpose: BindingPurpose;
      providerId: string;
      model: string;
      params?: Record<string, unknown> | undefined;
      priority?: number | undefined;
    },
  ): Promise<BindingRow> {
    return this.db.transaction(async (tx) => {
      const priority = input.priority ?? 0;
      const [existing] = await tx
        .select()
        .from(agentModelBindings)
        .where(
          and(
            eq(agentModelBindings.companyId, ctx.companyId),
            eq(agentModelBindings.agentId, agentId),
            eq(agentModelBindings.purpose, input.purpose),
            eq(agentModelBindings.priority, priority),
          ),
        );
      const values = {
        providerId: input.providerId,
        model: input.model,
        params: input.params ?? {},
      };
      const [binding] = existing
        ? await tx
            .update(agentModelBindings)
            .set(values)
            .where(eq(agentModelBindings.id, existing.id))
            .returning()
        : await tx
            .insert(agentModelBindings)
            .values({
              companyId: ctx.companyId,
              agentId,
              purpose: input.purpose,
              priority,
              ...values,
            })
            .returning();
      await emitDomainEvent(tx, ctx, {
        type: "agent.model.binding.changed",
        actor: { kind: "founder", id: null },
        agentId,
        payload: { agentId, diff: { purpose: input.purpose, model: input.model, priority } },
      });
      return binding!;
    });
  }

  async listBindings(ctx: CompanyContext, agentId: string): Promise<BindingRow[]> {
    return this.db
      .select()
      .from(agentModelBindings)
      .where(
        and(eq(agentModelBindings.companyId, ctx.companyId), eq(agentModelBindings.agentId, agentId)),
      )
      .orderBy(asc(agentModelBindings.purpose), asc(agentModelBindings.priority));
  }

  // ---------- sessions read API (rows appear with T31) ----------

  async listSessions(ctx: CompanyContext, agentId: string) {
    return this.db
      .select()
      .from(agentSessions)
      .where(and(eq(agentSessions.companyId, ctx.companyId), eq(agentSessions.agentId, agentId)))
      .orderBy(desc(agentSessions.startedAt))
      .limit(50);
  }
}

export { formatEmployeeNumber };
