// Office Projector (23 §4, §4.1–4.2, §13; T25). All choreography decisions
// are server-side and deterministic: instructions are emitted in domain-event
// seq order with a per-company monotonic choreoSeq, and the projector is a
// single-writer actor per company. HARD invariant: no instruction without a
// causeEventId — sealInstruction throws before anything is published. The
// only timer-driven emissions are dwell/speech endings, and both carry the
// originating event id.
import {
  OfficeInstructionSchema,
  PRESENCE_BADGES,
  type Cell,
  type OfficeInstruction,
  type OfficeLayout,
  type PresenceBadge,
  type PresenceState,
} from "@acos/contracts";
import {
  assignHomeDesk,
  computeAutoLayout,
  deskOf,
  freeDesk,
  gridPath,
  type AgentInput,
  type OrgUnitInput,
} from "./layout.js";

export const DM_DWELL_MS = 12_000; // 23 §4.1 [WRITER-DECISION]
export const SPEECH_MS = 4_000;
export const LAG_SKIP_MS = 30_000; // 23 §13 — skip choreography for stale backlog

const ENTRANCE: Cell = { x: 0, y: 0 };

export interface ProjectorEnvelope {
  id: string;
  companyId: string;
  seq: number;
  type: string;
  occurredAt: string;
  actor: { kind: string; id: string | null };
  subject: { taskId: string | null; projectId: string | null; agentId: string | null };
  payload: unknown;
}

export interface OfficeCompanyData {
  units: OrgUnitInput[];
  agents: AgentInput[];
  /** agentId → managerAgentId (active reports_to edges). */
  reportsTo: Record<string, string>;
  savedLayout: OfficeLayout | null;
}

export interface ProjectorDeps {
  loadCompanyData(companyId: string): Promise<OfficeCompanyData>;
  publish(companyId: string, instruction: OfficeInstruction): void;
  now(): Date;
  /** Injectable timer; returns a cancel function. */
  schedule(delayMs: number, fn: () => void): () => void;
}

interface AgentState {
  name: string;
  cell: Cell;
  badge: PresenceBadge;
  deskId: string | null;
  sessionId: string | null;
}

interface InteractionState {
  id: string;
  kind: "dm" | "review" | "escalation" | "meeting" | "speech";
  agentIds: string[];
  atCell: Cell;
  causeEventId: string;
  /** initiator to return home on end (walks only). */
  walkerAgentId: string | null;
  cancelTimer: (() => void) | null;
}

interface CompanyState {
  layout: OfficeLayout;
  layoutVersion: number;
  snapshotEpoch: number;
  choreoSeq: number;
  agents: Map<string, AgentState>;
  interactions: Map<string, InteractionState>;
  unitsById: Map<string, OrgUnitInput>;
  reportsTo: Record<string, string>;
  interactionCounter: number;
}

type InstructionDraft =
  | (Omit<Extract<OfficeInstruction, { type: "office.avatar.moved" }>, "choreoSeq" | "emittedAt">)
  | (Omit<Extract<OfficeInstruction, { type: "office.interaction.started" }>, "choreoSeq" | "emittedAt">)
  | (Omit<Extract<OfficeInstruction, { type: "office.interaction.ended" }>, "choreoSeq" | "emittedAt">)
  | (Omit<Extract<OfficeInstruction, { type: "office.status.changed" }>, "choreoSeq" | "emittedAt">);

/**
 * Assigns choreoSeq/emittedAt and validates against the contract schema —
 * THROWS on any instruction without a causeEventId (the hard invariant).
 */
export function sealInstruction(
  state: { choreoSeq: number },
  draft: InstructionDraft,
  now: Date,
): OfficeInstruction {
  const sealed = { ...draft, choreoSeq: state.choreoSeq + 1, emittedAt: now.toISOString() };
  const parsed = OfficeInstructionSchema.parse(sealed); // causeEventId required here
  state.choreoSeq += 1;
  return parsed;
}

const BADGE_SET = new Set<string>(PRESENCE_BADGES);

export class OfficeProjector {
  private readonly companies = new Map<string, CompanyState>();

  constructor(private readonly deps: ProjectorDeps) {}

  // ---------- state bootstrap (23 §13 restart semantics) ----------

  private async companyState(companyId: string): Promise<CompanyState> {
    const existing = this.companies.get(companyId);
    if (existing) return existing;
    const data = await this.deps.loadCompanyData(companyId);
    const layout = data.savedLayout ?? computeAutoLayout(data.units, data.agents);
    const state: CompanyState = {
      layout,
      layoutVersion: layout.version,
      snapshotEpoch: 1,
      choreoSeq: 0,
      agents: new Map(),
      interactions: new Map(),
      unitsById: new Map(data.units.map((u) => [u.id, u])),
      reportsTo: data.reportsTo,
      interactionCounter: 0,
    };
    for (const agent of data.agents) {
      if (agent.status !== "active") continue;
      const desk = deskOf(layout, agent.id) ??
        assignHomeDesk(layout, agent.id, agent.orgUnitId, state.unitsById);
      state.agents.set(agent.id, {
        name: agent.name,
        cell: desk?.cell ?? ENTRANCE,
        badge: "IDLE",
        deskId: desk?.id ?? null,
        sessionId: null,
      });
    }
    this.companies.set(companyId, state);
    return state;
  }

  async snapshot(companyId: string): Promise<PresenceState> {
    const state = await this.companyState(companyId);
    return {
      layoutVersion: state.layoutVersion,
      snapshotEpoch: state.snapshotEpoch,
      agents: [...state.agents.entries()].map(([agentId, agent]) => ({
        agentId,
        name: agent.name,
        cell: agent.cell,
        badge: agent.badge,
        deskId: agent.deskId,
        sessionId: agent.sessionId,
      })),
      interactions: [...state.interactions.values()].map((i) => ({
        id: i.id,
        kind: i.kind,
        agentIds: i.agentIds,
        atCell: i.atCell,
        causeEventId: i.causeEventId,
      })),
    };
  }

  async layoutFor(companyId: string): Promise<OfficeLayout> {
    return (await this.companyState(companyId)).layout;
  }

  // ---------- event intake (single-writer per company) ----------

  async handleEvent(envelope: ProjectorEnvelope): Promise<OfficeInstruction[]> {
    const state = await this.companyState(envelope.companyId);
    const emitted: OfficeInstruction[] = [];
    const emit = (draft: InstructionDraft) => {
      const instruction = sealInstruction(state, draft, this.deps.now());
      emitted.push(instruction);
      this.deps.publish(envelope.companyId, instruction);
      return instruction;
    };
    const cause = { causeEventId: envelope.id, causeSeq: envelope.seq };

    // consumer-lag rule (23 §13): stale backlog keeps badges truthful, no walks
    const stale =
      this.deps.now().getTime() - new Date(envelope.occurredAt).getTime() > LAG_SKIP_MS;

    // a sender's next non-message activity ends its open walk interactions early
    const actorAgent = envelope.subject.agentId;
    if (actorAgent && envelope.type !== "agent.message.sent") {
      this.endWalksOf(state, actorAgent, envelope);
    }

    const payload = (envelope.payload ?? {}) as Record<string, unknown>;
    switch (envelope.type) {
      case "agent.hired": {
        const agentId = (payload.agentId as string) ?? actorAgent;
        if (!agentId) break;
        const desk = assignHomeDesk(state.layout, agentId, null, state.unitsById);
        state.agents.set(agentId, {
          name: (payload.name as string) ?? "Agent",
          cell: desk?.cell ?? ENTRANCE,
          badge: "IDLE",
          deskId: desk?.id ?? null,
          sessionId: null,
        });
        if (desk && !stale) {
          emit({
            type: "office.avatar.moved",
            agentId,
            fromCell: ENTRANCE,
            toCell: desk.cell,
            path: gridPath(ENTRANCE, desk.cell),
            reason: "desk_assign",
            ...cause,
          });
        }
        emit({ type: "office.status.changed", agentId, badge: "IDLE", ...cause });
        break;
      }
      case "agent.started":
      case "agent.resumed": {
        const agentId = actorAgent ?? (payload.agentId as string | undefined);
        if (agentId && this.setBadge(state, agentId, "IDLE"))
          emit({ type: "office.status.changed", agentId, badge: "IDLE", ...cause });
        break;
      }
      case "agent.paused": {
        if (!actorAgent) break;
        this.endInteractionsOf(state, actorAgent, envelope);
        if (this.setBadge(state, actorAgent, "OFFLINE"))
          emit({ type: "office.status.changed", agentId: actorAgent, badge: "OFFLINE", ...cause });
        break;
      }
      case "agent.offboarded": {
        if (!actorAgent) break;
        this.endInteractionsOf(state, actorAgent, envelope);
        emit({ type: "office.status.changed", agentId: actorAgent, badge: "OFFLINE", ...cause });
        freeDesk(state.layout, actorAgent);
        state.agents.delete(actorAgent);
        break;
      }
      case "agent.status.changed": {
        const badge = String(payload.to ?? "").toUpperCase();
        if (actorAgent && BADGE_SET.has(badge) && this.setBadge(state, actorAgent, badge as PresenceBadge))
          emit({
            type: "office.status.changed",
            agentId: actorAgent,
            badge: badge as PresenceBadge,
            ...cause,
          });
        break;
      }
      case "agent.task.started": {
        const agentId = (payload.agentId as string) ?? actorAgent;
        if (agentId && this.setBadge(state, agentId, "WORKING"))
          emit({ type: "office.status.changed", agentId, badge: "WORKING", ...cause });
        break;
      }
      case "task.status.changed": {
        const byActor = payload.byActor as { kind?: string; id?: string | null } | undefined;
        const ownerId = byActor?.kind === "agent" ? (byActor.id ?? undefined) : undefined;
        if (payload.to === "IN_PROGRESS" && ownerId && this.setBadge(state, ownerId, "WORKING"))
          emit({ type: "office.status.changed", agentId: ownerId, badge: "WORKING", ...cause });
        break;
      }
      case "agent.message.sent": {
        if (stale) break;
        const sender = (payload.senderAgentId as string) ?? actorAgent;
        if (!sender || !state.agents.has(sender)) break;
        const kind = String(payload.kind ?? "message");
        const mentions = Array.isArray(payload.mentions) ? (payload.mentions as string[]) : [];
        const target = mentions.find((m) => state.agents.has(m) && m !== sender) ?? null;

        if (kind === "dm" && target) {
          this.walkAndInteract(state, envelope, emit, {
            walker: sender,
            target,
            reason: "dm",
            interactionKind: "dm",
            dwellMs: DM_DWELL_MS,
          });
        } else if (kind === "review_request" && target) {
          this.walkAndInteract(state, envelope, emit, {
            walker: sender,
            target,
            reason: "review",
            interactionKind: "review",
            dwellMs: DM_DWELL_MS,
          });
        } else if (kind === "escalation") {
          this.escalate(state, envelope, emit, sender);
        } else {
          // channel message: speech indicator at the sender's desk for 4 s
          this.startInteraction(state, envelope, emit, {
            kind: "speech",
            agentIds: [sender],
            atCell: state.agents.get(sender)!.cell,
            walkerAgentId: null,
            timeoutMs: SPEECH_MS,
            endedBy: "speech_timeout",
          });
          if (this.setBadge(state, sender, "COMMUNICATING"))
            emit({ type: "office.status.changed", agentId: sender, badge: "COMMUNICATING", ...cause });
        }
        break;
      }
      case "review.requested": {
        if (stale) break;
        const requester = actorAgent;
        const reviewer = payload.reviewerAgentId as string | undefined;
        if (requester && reviewer && state.agents.has(requester) && state.agents.has(reviewer)) {
          this.walkAndInteract(state, envelope, emit, {
            walker: requester,
            target: reviewer,
            reason: "review",
            interactionKind: "review",
            dwellMs: DM_DWELL_MS,
          });
        }
        break;
      }
      case "review.started": {
        const reviewer = (payload.reviewerAgentId as string) ?? actorAgent;
        if (reviewer && this.setBadge(state, reviewer, "REVIEWING"))
          emit({ type: "office.status.changed", agentId: reviewer, badge: "REVIEWING", ...cause });
        break;
      }
      case "agent.escalated": {
        if (!actorAgent || !state.agents.has(actorAgent)) break;
        this.escalate(state, envelope, emit, actorAgent);
        break;
      }
      case "company.settings.updated": {
        // layout edits: version bump + fresh snapshot epoch (clients rebuild)
        const diff = payload.diff as Record<string, unknown> | undefined;
        if (diff && "officeLayout" in diff) {
          state.layoutVersion += 1;
          state.snapshotEpoch += 1;
        }
        break;
      }
      default:
        break;
    }
    return emitted;
  }

  // ---------- choreography helpers ----------

  private setBadge(state: CompanyState, agentId: string, badge: PresenceBadge): boolean {
    const agent = state.agents.get(agentId);
    if (!agent || agent.badge === badge) return false;
    agent.badge = badge;
    return true;
  }

  private walkAndInteract(
    state: CompanyState,
    envelope: ProjectorEnvelope,
    emit: (draft: InstructionDraft) => OfficeInstruction,
    opts: {
      walker: string;
      target: string;
      reason: "dm" | "review" | "escalation";
      interactionKind: "dm" | "review" | "escalation";
      dwellMs: number;
    },
  ): void {
    const walker = state.agents.get(opts.walker);
    const target = state.agents.get(opts.target);
    if (!walker || !target) return;
    const cause = { causeEventId: envelope.id, causeSeq: envelope.seq };
    emit({
      type: "office.avatar.moved",
      agentId: opts.walker,
      fromCell: walker.cell,
      toCell: target.cell,
      path: gridPath(walker.cell, target.cell),
      reason: opts.reason,
      ...cause,
    });
    walker.cell = target.cell;
    this.startInteraction(state, envelope, emit, {
      kind: opts.interactionKind,
      agentIds: [opts.walker, opts.target],
      atCell: target.cell,
      walkerAgentId: opts.walker,
      timeoutMs: opts.dwellMs,
      endedBy: "dwell_timeout",
    });
    const badge: PresenceBadge = opts.interactionKind === "escalation" ? "ESCALATING" : "COMMUNICATING";
    if (this.setBadge(state, opts.walker, badge))
      emit({ type: "office.status.changed", agentId: opts.walker, badge, ...cause });
  }

  private escalate(
    state: CompanyState,
    envelope: ProjectorEnvelope,
    emit: (draft: InstructionDraft) => OfficeInstruction,
    agentId: string,
  ): void {
    const cause = { causeEventId: envelope.id, causeSeq: envelope.seq };
    const managerId = state.reportsTo[agentId];
    if (managerId && state.agents.has(managerId)) {
      this.walkAndInteract(state, envelope, emit, {
        walker: agentId,
        target: managerId,
        reason: "escalation",
        interactionKind: "escalation",
        dwellMs: DM_DWELL_MS,
      });
    } else if (this.setBadge(state, agentId, "ESCALATING")) {
      // Founder-level escalation: no walk — Approval Center handles it
      emit({ type: "office.status.changed", agentId, badge: "ESCALATING", ...cause });
    }
  }

  private startInteraction(
    state: CompanyState,
    envelope: ProjectorEnvelope,
    emit: (draft: InstructionDraft) => OfficeInstruction,
    opts: {
      kind: InteractionState["kind"];
      agentIds: string[];
      atCell: Cell;
      walkerAgentId: string | null;
      timeoutMs: number;
      endedBy: "dwell_timeout" | "speech_timeout";
    },
  ): void {
    state.interactionCounter += 1;
    const interactionId = `i_${envelope.companyId.slice(-6)}_${state.interactionCounter}`;
    const cause = { causeEventId: envelope.id, causeSeq: envelope.seq };
    emit({
      type: "office.interaction.started",
      interactionId,
      kind: opts.kind,
      agentIds: opts.agentIds,
      atCell: opts.atCell,
      ...cause,
    });
    const interaction: InteractionState = {
      id: interactionId,
      kind: opts.kind,
      agentIds: opts.agentIds,
      atCell: opts.atCell,
      causeEventId: envelope.id,
      walkerAgentId: opts.walkerAgentId,
      cancelTimer: null,
    };
    // timer-driven ending carries the ORIGINATING event id (hard invariant)
    interaction.cancelTimer = this.deps.schedule(opts.timeoutMs, () => {
      this.finishInteraction(state, envelope.companyId, interaction, envelope, opts.endedBy);
    });
    state.interactions.set(interactionId, interaction);
  }

  private finishInteraction(
    state: CompanyState,
    companyId: string,
    interaction: InteractionState,
    causeEnvelope: ProjectorEnvelope,
    endedBy: "event" | "dwell_timeout" | "speech_timeout",
  ): void {
    if (!state.interactions.has(interaction.id)) return;
    state.interactions.delete(interaction.id);
    interaction.cancelTimer?.();
    const publish = (draft: InstructionDraft) =>
      this.deps.publish(companyId, sealInstruction(state, draft, this.deps.now()));
    const cause = { causeEventId: causeEnvelope.id, causeSeq: causeEnvelope.seq };
    publish({ type: "office.interaction.ended", interactionId: interaction.id, endedBy, ...cause });
    if (interaction.walkerAgentId) {
      const walker = state.agents.get(interaction.walkerAgentId);
      const homeDesk = deskOf(state.layout, interaction.walkerAgentId);
      if (walker && homeDesk && (walker.cell.x !== homeDesk.cell.x || walker.cell.y !== homeDesk.cell.y)) {
        publish({
          type: "office.avatar.moved",
          agentId: interaction.walkerAgentId,
          fromCell: walker.cell,
          toCell: homeDesk.cell,
          path: gridPath(walker.cell, homeDesk.cell),
          reason: "return_home",
          ...cause,
        });
        walker.cell = homeDesk.cell;
      }
    }
  }

  /** Ends the walk-interactions a sender initiated (their next activity event). */
  private endWalksOf(state: CompanyState, agentId: string, envelope: ProjectorEnvelope): void {
    for (const interaction of [...state.interactions.values()]) {
      if (interaction.walkerAgentId === agentId) {
        this.finishInteraction(state, envelope.companyId, interaction, envelope, "event");
      }
    }
  }

  private endInteractionsOf(
    state: CompanyState,
    agentId: string,
    envelope: ProjectorEnvelope,
  ): void {
    for (const interaction of [...state.interactions.values()]) {
      if (interaction.agentIds.includes(agentId)) {
        this.finishInteraction(state, envelope.companyId, interaction, envelope, "event");
      }
    }
  }

  /** Drops in-memory state (tests / nightly reconciliation). */
  reset(companyId?: string): void {
    if (companyId) this.companies.delete(companyId);
    else this.companies.clear();
  }
}
