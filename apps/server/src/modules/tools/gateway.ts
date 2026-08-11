// Tool Gateway (T39; 17 §4 normative path, _DECISIONS §12, 18 §4). The
// single choke point between agent intent and real-world effect (S3): every
// step is fail-closed, every decision leaves a `tool_invocations` audit row
// (identity failures, which have no valid agent FK, land in `audit_log`),
// and the decision itself comes from the ONE canonical domain authorize()
// (06 §2) — the gateway only computes its inputs.
//
// Recorded deviations, bounded by the canonical schema (20 §12):
// - rate limiting reuses the T11 `rate_limits` UNLOGGED token-bucket table
//   (17 §6's sketched `tool_rate_counters` table does not exist canonically).
// - `tool_invocations` has no idempotency column — replay dedupe uses the
//   canonical `idempotency_keys` table (20 §2.7) under endpoint "tools.invoke".
// - approval CREATION on `require_approval` stays with the caller's escalate
//   machinery (19 §7, wired in T40); the gateway returns approver + records
//   `awaiting_approval`.
import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import {
  authorize,
  type Decision,
  type EscalationTarget,
  type ScopeRelation,
} from "@acos/domain/policies";
import type { AutonomyLevel, RiskClass } from "@acos/domain";
import {
  elevateRisk,
  getTool,
  matchesToolPattern,
  rateLimitFor,
  scrubSecretEnv,
  type ToolDefinition,
} from "@acos/tools";
import {
  appendEvents,
  beginIdempotent,
  completeIdempotent,
  CostService,
  type CompanyContext,
  type GuardedDb,
  type NewEventInput,
  type Tx,
} from "@acos/db";
import { parseEventPayload } from "@acos/events";
import {
  agents,
  auditLog,
  budgets,
  costEntries,
  orgEdges,
  policies,
  rateLimits,
  tasks,
  toolInvocations,
  toolPermissions,
} from "@acos/db/schema";

async function emitDomainEvent(tx: Tx, ctx: CompanyContext, input: NewEventInput) {
  const payload = parseEventPayload(input.type, input.version ?? 1, input.payload ?? {});
  const [appended] = await appendEvents(tx, ctx, [{ ...input, payload }]);
  return appended!;
}

export interface ToolInvokeRequest {
  agentId: string;
  toolName: string;
  input: unknown;
  taskId?: string | undefined;
  agentSessionId?: string | undefined;
  workspaceId?: string | undefined;
  /** S5 taint bit: arguments derive from external content (17 §7.4). */
  tainted?: boolean | undefined;
  /** Relation between the agent and the touched resource (06 §1). */
  scopeRelation?: ScopeRelation | undefined;
  /** Temporal activity attempt key — replays return the recorded result. */
  idempotencyKey?: string | undefined;
}

export interface ToolInvokeResponse {
  invocationId: string | null;
  decision: "allow" | "deny" | "require_approval";
  status: "denied" | "awaiting_approval" | "dispatched" | "succeeded" | "failed";
  reason: string | null;
  approver?: EscalationTarget;
  riskClass: RiskClass;
  elevatedFrom?: RiskClass;
  output?: unknown;
  error?: string;
  costCents?: number;
  retryAfterSec?: number;
  replayed?: boolean;
}

/** Execution seam per sandboxLevel/scopes — implemented in T40 (sandbox-
 *  manager / egress proxy / adapters); tests inject fakes. */
export interface ToolDispatchPort {
  dispatch(req: {
    ctx: CompanyContext;
    tool: ToolDefinition;
    input: unknown;
    agentId: string;
    taskId: string | null;
    workspaceId: string | null;
    /** Resolved server-side at dispatch time only — S2. */
    credentials: Record<string, string>;
  }): Promise<{ output: unknown; costCents?: number; resultSummary?: string }>;
}

export type CredentialResolver = (
  ctx: CompanyContext,
  name: string,
) => Promise<string | null>;

export interface ToolGatewayDeps {
  db: GuardedDb;
  dispatch?: ToolDispatchPort;
  resolveCredential?: CredentialResolver;
  now?: () => Date;
}

const NOT_WIRED: ToolDispatchPort = {
  dispatch: () => Promise.reject(new Error("tool dispatch not wired (lands with T40)")),
};

interface GrantConstraints {
  pathPrefixes?: string[];
  repoAllowlist?: string[];
  branchPatterns: string[];
  domainAllowlist?: string[];
  spendCapCents?: number;
  monthlySpendCapCents?: number;
  maxTimeoutSec?: number;
  onCapExceeded: "deny" | "escalate";
}

type ConstraintOutcome =
  | { ok: true }
  | { ok: false; detail: string; escalate: boolean };

interface PolicyRule {
  actionPattern?: string;
  subject?: { kind: "agent" | "position" | "org_unit"; id: string };
  condition?: { maxCostCents?: number; riskAtMost?: RiskClass; requiresTaint?: boolean };
  approver?: EscalationTarget;
}

const RISK_ORDER: RiskClass[] = ["R0", "R1", "R2", "R3"];

export class ToolGateway {
  private readonly db: GuardedDb;
  private readonly dispatchPort: ToolDispatchPort;
  private readonly resolveCredential: CredentialResolver;
  private readonly now: () => Date;
  private readonly costs: CostService;

  constructor(deps: ToolGatewayDeps) {
    this.db = deps.db;
    this.dispatchPort = deps.dispatch ?? NOT_WIRED;
    this.resolveCredential = deps.resolveCredential ?? (() => Promise.resolve(null));
    this.now = deps.now ?? (() => new Date());
    this.costs = new CostService(this.db, this.now);
  }

  async invoke(ctx: CompanyContext, req: ToolInvokeRequest): Promise<ToolInvokeResponse> {
    // ---- 1. identity: agent exists, is active, belongs to this company ----
    const [agent] = await this.db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, req.agentId)))
      .limit(1);
    if (!agent || agent.status !== "active") {
      // no valid agent FK ⇒ the always-written audit row lands in audit_log
      await this.db.transaction(async (tx) => {
        await tx.insert(auditLog).values({
          companyId: ctx.companyId,
          actorKind: "system",
          action: "tool.invoke.identity_denied",
          targetKind: "agent",
          targetId: agent?.id ?? null,
          meta: { toolName: req.toolName, agentId: req.agentId, status: agent?.status ?? "missing" },
        });
      });
      return {
        invocationId: null,
        decision: "deny",
        status: "denied",
        reason: "IDENTITY_INVALID",
        riskClass: "R0",
      };
    }

    // ---- 2. registry + schema (fail-closed; S2 scrubbing BEFORE parse) ----
    const def = getTool(req.toolName);
    if (!def) {
      return this.finalizeDenied(ctx, req, agent.id, "R0", "TOOL_NOT_REGISTERED", req.input);
    }
    let rawInput = req.input;
    if (rawInput && typeof rawInput === "object" && "env" in rawInput) {
      const env = (rawInput as { env?: unknown }).env;
      if (env && typeof env === "object") {
        const { env: clean } = scrubSecretEnv(env as Record<string, string>);
        rawInput = { ...(rawInput as object), env: clean };
      }
    }
    const parsed = def.input.safeParse(rawInput);
    if (!parsed.success) {
      const detail = (parsed.error.issues as { path: (string | number)[]; message: string }[])
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return this.finalizeDenied(
        ctx,
        req,
        agent.id,
        def.risk,
        `INVALID_INPUT: ${detail}`.slice(0, 500),
        rawInput,
      );
    }
    const input = parsed.data as Record<string, unknown>;

    // ---- idempotent replay (Temporal activity retries, 17 §7.2) ----
    const requestHash = createHash("sha256")
      .update(JSON.stringify({ tool: req.toolName, agent: req.agentId, input }))
      .digest("hex");
    if (req.idempotencyKey) {
      const start = await this.db.transaction((tx) =>
        beginIdempotent(tx, ctx, {
          key: req.idempotencyKey!,
          endpoint: "tools.invoke",
          requestHash,
        }),
      );
      if (start.kind === "replay") {
        return { ...(start.responseBody as ToolInvokeResponse), replayed: true };
      }
      if (start.kind === "mismatch") {
        return this.finalizeDenied(
          ctx, req, agent.id, def.risk, "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_INPUT", input,
        );
      }
      // fresh | in_flight → proceed (in_flight: the crashed first attempt
      // never recorded a result; this attempt takes over the key)
    }

    // ---- 3. grant lookup: agent > position > org_unit (17 §4.1) ----
    const unitRows = await this.db
      .select({ unitId: orgEdges.toUnitId })
      .from(orgEdges)
      .where(
        and(
          eq(orgEdges.companyId, ctx.companyId),
          eq(orgEdges.fromAgentId, agent.id),
          eq(orgEdges.kind, "member_of"),
          isNull(orgEdges.endedAt),
        ),
      );
    const unitIds = unitRows.map((r) => r.unitId).filter((u): u is string => !!u);
    const subjectFilters = [
      and(eq(toolPermissions.subjectKind, "agent"), eq(toolPermissions.subjectId, agent.id)),
      eq(toolPermissions.subjectId, agent.positionId), // subject_kind check below
    ];
    const grantRows = await this.db
      .select()
      .from(toolPermissions)
      .where(
        and(
          eq(toolPermissions.companyId, ctx.companyId),
          isNull(toolPermissions.revokedAt),
          or(isNull(toolPermissions.expiresAt), gt(toolPermissions.expiresAt, this.now())),
          or(
            subjectFilters[0],
            and(
              eq(toolPermissions.subjectKind, "position"),
              eq(toolPermissions.subjectId, agent.positionId),
            ),
            unitIds.length > 0
              ? and(
                  eq(toolPermissions.subjectKind, "org_unit"),
                  inArray(toolPermissions.subjectId, unitIds),
                )
              : sql`false`,
          ),
        ),
      );
    const applicable = grantRows.filter((g) => matchesToolPattern(g.toolName, def.name));
    // most specific subject kind wins; within it, constraints merge by
    // INTERSECTION (least privilege, 17 §4.1)
    const byKind = (kind: string) => applicable.filter((g) => g.subjectKind === kind);
    const winning =
      byKind("agent").length > 0
        ? byKind("agent")
        : byKind("position").length > 0
          ? byKind("position")
          : byKind("org_unit");
    const permissionGranted = winning.length > 0;
    const constraints = mergeConstraints(winning.map((g) => g.constraints as object));

    // ---- 4. constraint evaluation (17 §4.2) ----
    let constraintOutcome: ConstraintOutcome = { ok: true };
    let estCostCents = def.estimateCost(input).amountCents;
    if (permissionGranted) {
      // maxTimeoutSec CLAMPS rather than denies
      if (
        constraints.maxTimeoutSec !== undefined &&
        typeof input.timeoutSec === "number" &&
        input.timeoutSec > constraints.maxTimeoutSec
      ) {
        input.timeoutSec = constraints.maxTimeoutSec;
        estCostCents = def.estimateCost(input).amountCents;
      }
      constraintOutcome = await this.evaluateConstraints(ctx, def, input, constraints, {
        agentId: agent.id,
        estCostCents,
      });
    }

    // ---- 5. policy rows: deny → require_approval → allow bands (18 §4.2) ----
    const effectiveRisk = req.tainted ? elevateRisk(def.risk) : def.risk;
    const elevatedFrom = req.tainted && effectiveRisk !== def.risk ? def.risk : undefined;
    const policyRows = await this.db
      .select()
      .from(policies)
      .where(
        and(
          eq(policies.companyId, ctx.companyId),
          eq(policies.enabled, true),
          inArray(policies.kind, ["tool", "standing_approval"]),
        ),
      );
    const matching = policyRows
      .filter((p) => {
        const rule = (p.rule ?? {}) as PolicyRule;
        if (!matchesToolPattern(rule.actionPattern ?? "*", def.name)) return false;
        if (rule.subject) {
          if (rule.subject.kind === "agent" && rule.subject.id !== agent.id) return false;
          if (rule.subject.kind === "position" && rule.subject.id !== agent.positionId)
            return false;
          if (rule.subject.kind === "org_unit" && !unitIds.includes(rule.subject.id))
            return false;
        }
        const cond = rule.condition ?? {};
        if (cond.maxCostCents !== undefined && estCostCents > cond.maxCostCents) return false;
        if (
          cond.riskAtMost !== undefined &&
          RISK_ORDER.indexOf(effectiveRisk) > RISK_ORDER.indexOf(cond.riskAtMost)
        )
          return false;
        if (cond.requiresTaint === false && req.tainted) return false;
        return true;
      })
      .sort((a, b) => a.priority - b.priority);
    const denyRule = matching.find((p) => p.effect === "deny");
    const approvalRule = matching.find((p) => p.effect === "require_approval");
    const allowRule = matching.find((p) => p.effect === "allow");

    // ---- 6. budget: tightest applicable scope (26 §1) ----
    const budget = await this.tightestBudget(ctx, req.taskId ?? null);

    // ---- 7. THE decision — canonical domain authorize() (06 §2) ----
    let decision: Decision;
    if (!constraintOutcome.ok && constraintOutcome.escalate) {
      // 17 §4.2 example 2: cap exceeded + onCapExceeded=escalate degrades
      // the standing delegation into a Founder/manager brief, not a deny
      decision = { verdict: "require_approval", approver: "manager", briefRequired: true };
    } else {
      decision = authorize({
        autonomyLevel: agent.autonomyLevel as AutonomyLevel,
        riskClass: effectiveRisk,
        scopeRelation: req.scopeRelation ?? "own_team",
        founderOnlyCategory: def.founderCategory !== undefined,
        hasStandingGrant: allowRule !== undefined,
        permissionGranted,
        constraintsSatisfied: constraintOutcome.ok,
        policyDeny: denyRule !== undefined,
        ...(denyRule && { policyDenyReason: `POLICY_DENY:${denyRule.name}` }),
        estCostCents,
        budgetRemainingCents: budget.remainingCents,
        budgetHard: budget.hard,
        externallyInfluenced: req.tainted ?? false,
      });
      if (decision.verdict === "allow" && approvalRule) {
        const rule = (approvalRule.rule ?? {}) as PolicyRule;
        decision = {
          verdict: "require_approval",
          approver: rule.approver ?? "founder",
          briefRequired: true,
        };
      }
    }

    // ---- rate limit (17 §6) — only would-be-dispatched calls consume ----
    let retryAfterSec: number | undefined;
    if (decision.verdict === "allow") {
      const limit = rateLimitFor(def);
      const agentTake = await this.takeToken(
        `tool:${ctx.companyId}:${agent.id}:${def.name}`,
        limit.perAgentPerMin,
      );
      const companyTake = agentTake.ok
        ? await this.takeToken(`tool:${ctx.companyId}:*:${def.name}`, limit.perCompanyPerMin)
        : agentTake;
      if (!agentTake.ok || !companyTake.ok) {
        retryAfterSec = Math.max(agentTake.retryAfterSec ?? 0, companyTake.retryAfterSec ?? 0);
        decision = { verdict: "deny", reason: "RATE_LIMITED" };
      }
    }

    // ---- audit row — ALWAYS — + events, one tx (17 §4 step 6) ----
    const detailReason =
      decision.verdict === "deny"
        ? decision.reason +
          (!constraintOutcome.ok && !constraintOutcome.escalate
            ? `:${constraintOutcome.detail}`
            : "")
        : decision.verdict === "require_approval"
          ? `approver=${decision.approver}` +
            (!constraintOutcome.ok ? `:${constraintOutcome.detail}` : "")
          : "authorized";
    const status =
      decision.verdict === "deny"
        ? "denied"
        : decision.verdict === "require_approval"
          ? "awaiting_approval"
          : "dispatched";
    const actor = { kind: "agent" as const, id: agent.id };
    const refs = {
      taskId: req.taskId ?? null,
      agentId: agent.id,
    };
    const invocationId = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(toolInvocations)
        .values({
          companyId: ctx.companyId,
          agentId: agent.id,
          taskId: req.taskId ?? null,
          agentSessionId: req.agentSessionId ?? null,
          toolName: def.name,
          riskClass: effectiveRisk,
          input: { ...input, ...(elevatedFrom && { __elevatedFrom: elevatedFrom }) },
          decision: decision.verdict,
          decisionReason: detailReason.slice(0, 1000),
          status,
          workspaceId: req.workspaceId ?? null,
          costCents: 0,
        })
        .returning({ id: toolInvocations.id });
      await emitDomainEvent(tx, ctx, {
        type: "tool.invocation.requested",
        actor,
        ...refs,
        payload: { invocationId: row!.id, toolName: def.name, riskClass: effectiveRisk },
      });
      if (decision.verdict === "deny") {
        await emitDomainEvent(tx, ctx, {
          type: "tool.invocation.denied",
          actor,
          ...refs,
          payload: { toolName: def.name, riskClass: effectiveRisk, reason: detailReason },
        });
        if (detailReason.startsWith("RATE_LIMITED")) {
          await emitDomainEvent(tx, ctx, {
            type: "tool.rate.throttled",
            actor,
            ...refs,
            payload: { agentId: agent.id, toolName: def.name, count: 1 },
          });
        }
      }
      // R2+ decisions mirror into audit_log (S7, 17 §4.3)
      if (RISK_ORDER.indexOf(effectiveRisk) >= RISK_ORDER.indexOf("R2")) {
        await tx.insert(auditLog).values({
          companyId: ctx.companyId,
          actorKind: "agent",
          actorId: agent.id,
          action: `tool.invoke.${decision.verdict}`,
          targetKind: "tool_invocation",
          targetId: row!.id,
          meta: { toolName: def.name, riskClass: effectiveRisk, reason: detailReason },
        });
      }
      return row!.id;
    });

    const base: ToolInvokeResponse = {
      invocationId,
      decision: decision.verdict,
      status,
      reason: decision.verdict === "allow" ? null : detailReason,
      riskClass: effectiveRisk,
      ...(elevatedFrom && { elevatedFrom }),
      ...(decision.verdict === "require_approval" && { approver: decision.approver }),
      ...(retryAfterSec !== undefined && { retryAfterSec }),
    };
    if (decision.verdict !== "allow") {
      await this.recordIdempotent(ctx, req, requestHash, base);
      return base;
    }

    // ---- 7b. dispatch (S2 credentials resolved HERE, never earlier) ----
    const credentials: Record<string, string> = {};
    for (const ref of def.credentialRefs ?? []) {
      const value = await this.resolveCredential(ctx, ref);
      if (value !== null) credentials[ref] = value;
    }
    const started = this.now().getTime();
    let result: { output: unknown; costCents?: number; resultSummary?: string };
    try {
      result = await withTimeout(
        this.dispatchPort.dispatch({
          ctx,
          tool: def,
          input,
          agentId: agent.id,
          taskId: req.taskId ?? null,
          workspaceId: req.workspaceId ?? null,
          credentials,
        }),
        def.timeoutMs,
      );
      const outParsed = def.output.safeParse(result.output);
      if (!outParsed.success) {
        throw new Error(`output schema mismatch: ${outParsed.error.issues[0]?.message}`);
      }
      result.output = outParsed.data;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const failed: ToolInvokeResponse = {
        ...base,
        status: "failed",
        error: message.slice(0, 1000),
      };
      await this.db.transaction(async (tx) => {
        await tx
          .update(toolInvocations)
          .set({
            status: "failed",
            error: message.slice(0, 2000),
            durationMs: this.now().getTime() - started,
            finishedAt: this.now(),
          })
          .where(
            and(eq(toolInvocations.companyId, ctx.companyId), eq(toolInvocations.id, invocationId)),
          );
      });
      await this.recordIdempotent(ctx, req, requestHash, failed);
      return failed;
    }

    const actualCost = result.costCents ?? estCostCents;
    const durationMs = this.now().getTime() - started;
    await this.db.transaction(async (tx) => {
      await tx
        .update(toolInvocations)
        .set({
          status: "succeeded",
          costCents: actualCost,
          durationMs,
          finishedAt: this.now(),
          resultSummary: (result.resultSummary ?? "").slice(0, 2000) || null,
        })
        .where(
          and(eq(toolInvocations.companyId, ctx.companyId), eq(toolInvocations.id, invocationId)),
        );
      await emitDomainEvent(tx, ctx, {
        type: "tool.invocation.completed",
        actor,
        ...refs,
        payload: {
          toolName: def.name,
          riskClass: effectiveRisk,
          costCents: actualCost,
          resultDigest: (result.resultSummary ?? "").slice(0, 200),
        },
      });
    });
    if (actualCost > 0) {
      await this.costs.recordCost(ctx, {
        id: invocationId, // exactly-once even on replays
        kind: "tool",
        ref: def.name,
        agentId: agent.id,
        taskId: req.taskId ?? undefined,
        amountCents: actualCost,
      });
    }
    const success: ToolInvokeResponse = {
      ...base,
      status: "succeeded",
      output: result.output,
      costCents: actualCost,
    };
    await this.recordIdempotent(ctx, req, requestHash, success);
    return success;
  }

  // ---------- helpers ----------

  /** Deny before an agent-attributable invocation exists is still audited. */
  private async finalizeDenied(
    ctx: CompanyContext,
    req: ToolInvokeRequest,
    agentId: string,
    risk: RiskClass,
    reason: string,
    input: unknown,
  ): Promise<ToolInvokeResponse> {
    const invocationId = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(toolInvocations)
        .values({
          companyId: ctx.companyId,
          agentId,
          taskId: req.taskId ?? null,
          agentSessionId: req.agentSessionId ?? null,
          toolName: req.toolName,
          riskClass: risk,
          input: (input ?? {}) as object,
          decision: "deny",
          decisionReason: reason.slice(0, 1000),
          status: "denied",
          workspaceId: req.workspaceId ?? null,
        })
        .returning({ id: toolInvocations.id });
      await emitDomainEvent(tx, ctx, {
        type: "tool.invocation.denied",
        actor: { kind: "agent", id: agentId },
        agentId,
        taskId: req.taskId ?? null,
        payload: { toolName: req.toolName, riskClass: risk, reason: reason.slice(0, 500) },
      });
      return row!.id;
    });
    return {
      invocationId,
      decision: "deny",
      status: "denied",
      reason,
      riskClass: risk,
    };
  }

  private async evaluateConstraints(
    ctx: CompanyContext,
    def: ToolDefinition,
    input: Record<string, unknown>,
    c: GrantConstraints,
    meta: { agentId: string; estCostCents: number },
  ): Promise<ConstraintOutcome> {
    // fs: every path in the input must sit under an allowed prefix
    if (c.pathPrefixes && def.scopes.includes("fs")) {
      const paths = [
        ...(typeof input.path === "string" ? [input.path] : []),
        ...(Array.isArray(input.paths) ? (input.paths as string[]) : []),
      ];
      for (const p of paths) {
        if (!c.pathPrefixes.some((prefix) => p.startsWith(prefix))) {
          return { ok: false, detail: `path_not_in_prefixes:${p}`, escalate: false };
        }
      }
    }
    // git: repo allowlist + branch pattern(s) — ALL patterns must match
    if (c.repoAllowlist && typeof input.repo === "string") {
      if (!c.repoAllowlist.includes(input.repo)) {
        return { ok: false, detail: `repo_not_allowed:${input.repo}`, escalate: false };
      }
    }
    if (c.branchPatterns.length > 0 && typeof input.branch === "string") {
      for (const pattern of c.branchPatterns) {
        if (!new RegExp(pattern).test(input.branch)) {
          return { ok: false, detail: `branch_not_allowed:${input.branch}`, escalate: false };
        }
      }
    }
    // network: URL host must be inside the grant's narrowed allowlist
    if (c.domainAllowlist && typeof input.url === "string") {
      const host = new URL(input.url).hostname;
      const allowed = c.domainAllowlist.some(
        (d) => host === d || host.endsWith(d.startsWith(".") ? d : `.${d}`),
      );
      if (!allowed) {
        return { ok: false, detail: `domain_not_allowed:${host}`, escalate: false };
      }
    }
    // spend caps: per-invocation + rolling 30-day (17 §4.2 example 2)
    const escalate = c.onCapExceeded === "escalate";
    if (c.spendCapCents !== undefined && meta.estCostCents > c.spendCapCents) {
      return { ok: false, detail: "spend_cap_exceeded", escalate };
    }
    if (c.monthlySpendCapCents !== undefined) {
      const since = new Date(this.now().getTime() - 30 * 24 * 60 * 60 * 1000);
      const [row] = await this.db
        .select({ total: sql<string>`coalesce(sum(${costEntries.amountCents}), 0)` })
        .from(costEntries)
        .where(
          and(
            eq(costEntries.companyId, ctx.companyId),
            eq(costEntries.kind, "tool"),
            eq(costEntries.ref, def.name),
            eq(costEntries.agentId, meta.agentId),
            gt(costEntries.occurredAt, since),
          ),
        );
      const spent = Number(row?.total ?? 0);
      if (spent + meta.estCostCents > c.monthlySpendCapCents) {
        return { ok: false, detail: "monthly_spend_cap_exceeded", escalate };
      }
    }
    return { ok: true };
  }

  /** Tightest applicable budget: task total (hard, T28) else company daily. */
  private async tightestBudget(
    ctx: CompanyContext,
    taskId: string | null,
  ): Promise<{ remainingCents: number; hard: boolean }> {
    if (taskId) {
      const [task] = await this.db
        .select({ budget: tasks.budgetCents, spent: tasks.spentCents })
        .from(tasks)
        .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)))
        .limit(1);
      if (task?.budget != null) {
        return { remainingCents: Math.max(0, task.budget - task.spent), hard: true };
      }
    }
    const [companyDaily] = await this.db
      .select()
      .from(budgets)
      .where(
        and(
          eq(budgets.companyId, ctx.companyId),
          eq(budgets.scopeKind, "company"),
          eq(budgets.period, "daily"),
          eq(budgets.enabled, true),
        ),
      )
      .limit(1);
    if (companyDaily) {
      const dayStart = new Date(this.now());
      dayStart.setUTCHours(0, 0, 0, 0);
      const [row] = await this.db
        .select({ total: sql<string>`coalesce(sum(${costEntries.amountCents}), 0)` })
        .from(costEntries)
        .where(
          and(eq(costEntries.companyId, ctx.companyId), gt(costEntries.occurredAt, dayStart)),
        );
      return {
        remainingCents: Math.max(0, companyDaily.limitCents - Number(row?.total ?? 0)),
        hard: companyDaily.kind === "hard",
      };
    }
    return { remainingCents: Number.MAX_SAFE_INTEGER, hard: false };
  }

  /** Token bucket on the T11 UNLOGGED rate_limits table (no Redis, 17 §6). */
  private async takeToken(
    key: string,
    perMin: number,
  ): Promise<{ ok: boolean; retryAfterSec?: number }> {
    const refillPerSec = perMin / 60;
    const nowTs = this.now();
    return this.db.transaction(async (tx) => {
      await tx
        .insert(rateLimits)
        .values({ key, tokens: perMin, refilledAt: nowTs })
        .onConflictDoNothing();
      const [row] = await tx
        .select()
        .from(rateLimits)
        .where(eq(rateLimits.key, key))
        .for("update");
      const elapsedSec = Math.max(0, (nowTs.getTime() - row!.refilledAt.getTime()) / 1000);
      const tokens = Math.min(perMin, row!.tokens + elapsedSec * refillPerSec);
      if (tokens < 1) {
        const retryAfterSec = Math.ceil((1 - tokens) / refillPerSec);
        await tx
          .update(rateLimits)
          .set({ tokens, refilledAt: nowTs })
          .where(eq(rateLimits.key, key));
        return { ok: false, retryAfterSec };
      }
      await tx
        .update(rateLimits)
        .set({ tokens: tokens - 1, refilledAt: nowTs })
        .where(eq(rateLimits.key, key));
      return { ok: true };
    });
  }

  private async recordIdempotent(
    ctx: CompanyContext,
    req: ToolInvokeRequest,
    _requestHash: string,
    response: ToolInvokeResponse,
  ): Promise<void> {
    if (!req.idempotencyKey) return;
    await this.db.transaction((tx) =>
      completeIdempotent(
        tx,
        ctx,
        { key: req.idempotencyKey!, endpoint: "tools.invoke" },
        200,
        response,
      ),
    );
  }
}

function mergeConstraints(raw: object[]): GrantConstraints {
  const merged: GrantConstraints = { branchPatterns: [], onCapExceeded: "deny" };
  let sawEscalate = raw.length > 0;
  for (const entry of raw) {
    const c = entry as Record<string, unknown>;
    for (const key of ["pathPrefixes", "repoAllowlist", "domainAllowlist"] as const) {
      const list = c[key];
      if (Array.isArray(list)) {
        merged[key] =
          merged[key] === undefined
            ? [...(list as string[])]
            : merged[key]!.filter((v) => (list as string[]).includes(v)); // intersection
      }
    }
    if (typeof c.branchPattern === "string") merged.branchPatterns.push(c.branchPattern);
    for (const key of ["spendCapCents", "monthlySpendCapCents", "maxTimeoutSec"] as const) {
      const value = c[key];
      if (typeof value === "number") {
        merged[key] = merged[key] === undefined ? value : Math.min(merged[key]!, value); // min
      }
    }
    if (c.onCapExceeded !== "escalate") sawEscalate = false; // every grant must opt in
  }
  if (sawEscalate) merged.onCapExceeded = "escalate";
  return merged;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tool timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
