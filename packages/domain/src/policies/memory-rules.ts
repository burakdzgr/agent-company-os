// Memory retrieval scoring + promotion rules (_DECISIONS.md §10).
import { DomainError } from "../errors.js";

export const RETRIEVAL_WEIGHTS = {
  cosine: 0.55,
  importance: 0.2,
  recency: 0.15,
  confidence: 0.1,
} as const;

export interface RetrievalSignals {
  readonly cosine: number;
  readonly importance: number;
  readonly recencyDecay: number;
  readonly confidence: number;
}

/** score = 0.55·cosine + 0.2·importance + 0.15·recency_decay + 0.1·confidence */
export function scoreMemoryRetrieval(signals: RetrievalSignals): number {
  for (const [name, value] of Object.entries(signals)) {
    if (typeof value !== "number" || Number.isNaN(value) || value < 0 || value > 1) {
      throw new DomainError(`retrieval signal ${name} must be within [0,1], got ${value}`);
    }
  }
  return (
    RETRIEVAL_WEIGHTS.cosine * signals.cosine +
    RETRIEVAL_WEIGHTS.importance * signals.importance +
    RETRIEVAL_WEIGHTS.recency * signals.recencyDecay +
    RETRIEVAL_WEIGHTS.confidence * signals.confidence
  );
}

/** failure memory: ≥3 supporting evidence rows across ≥2 distinct tasks → propose project-scope copy. */
export const AGENT_TO_PROJECT_RULE = { minEvidence: 3, minDistinctTasks: 2 } as const;

export function canProposeProjectPromotion(input: {
  evidenceCount: number;
  distinctTaskCount: number;
}): boolean {
  return (
    input.evidenceCount >= AGENT_TO_PROJECT_RULE.minEvidence &&
    input.distinctTaskCount >= AGENT_TO_PROJECT_RULE.minDistinctTasks
  );
}

/** project → company requires ≥2 projects + manager-agent approval. */
export const PROJECT_TO_COMPANY_RULE = { minDistinctProjects: 2 } as const;

export function canPromoteToCompany(input: {
  distinctProjectCount: number;
  managerApproved: boolean;
}): boolean {
  return (
    input.distinctProjectCount >= PROJECT_TO_COMPANY_RULE.minDistinctProjects &&
    input.managerApproved
  );
}

/**
 * Overlearning prevention: a single event can never directly create a
 * company-scope memory — only the promotion pipeline can (03 §3.4).
 */
export function canCreateCompanyScopeMemory(origin: "event" | "promotion"): boolean {
  return origin === "promotion";
}

// ---------------------------------------------------------------------------
// Consolidation pipeline rules (12 §5) — deterministic stages of
// memoryConsolidationWorkflow. Pure functions so the Temporal workflow can
// call them directly and the thresholds stay unit-testable.

/** Adjusted importance below this is dropped before persisting (12 §5.2). */
export const IMPORTANCE_DISCARD_THRESHOLD = 0.3;
/** Persist boundary: ≥ 0.45 → status `active`, else `candidate` (12 §5.9). */
export const IMPORTANCE_ACTIVE_THRESHOLD = 0.45;
/** Contradicting candidates persist with confidence capped here (12 §5.6). */
export const CONTRADICTION_CONFIDENCE_CAP = 0.6;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export interface ImportanceSignals {
  readonly selfScore: number; // the LLM's 0–1 self-assessment
  /** costly signals bump importance: escalation trigger or FAILED terminal task */
  readonly costlyTrigger: boolean;
  readonly evidenceRefCount: number;
  readonly type: string;
  readonly hasEntities: boolean;
}

/** 12 §5.2: +0.1 costly trigger, +0.05 ≥2 evidence refs, −0.1 entity-less episodic. */
export function adjustImportance(signals: ImportanceSignals): number {
  let score = signals.selfScore;
  if (signals.costlyTrigger) score += 0.1;
  if (signals.evidenceRefCount >= 2) score += 0.05;
  if (signals.type === "episodic" && !signals.hasEntities) score -= 0.1;
  return clamp01(score);
}

export interface ScopeSignals {
  readonly type: string;
  readonly suggestedScope: "agent" | "project";
  /** entities.files / entities.components non-empty (rule 1) */
  readonly referencesProjectArtifacts: boolean;
  /** the trigger task carries a project (rule 4 guards the org-task case) */
  readonly hasProject: boolean;
}

/**
 * 12 §5.3 rules 1–5, deterministic. Company scope is unreachable by
 * construction; ties resolve to `project` (contained blast radius).
 */
export function detectMemoryScope(signals: ScopeSignals): MemoryScopeDecision {
  if (signals.type === "relationship") return "agent"; // rule 3: perspectives, not facts
  if (!signals.hasProject) return "agent"; // rule 4: org-level task
  if (signals.referencesProjectArtifacts) return "project"; // rule 1
  if (signals.suggestedScope === "agent") return "agent"; // rule 2 proxy
  return "project"; // rule 5 tiebreak default
}
export type MemoryScopeDecision = "agent" | "project";

export interface ConfidenceEvidence {
  readonly kind: "event" | "artifact" | "review" | "metric" | "statement" | "incident";
}

/**
 * 12 §5.8: confidence = clamp01( base(cap 0.6) + 0.15·count(event∨review)
 * (max +0.30) + 0.25·has(metric) − 0.20·only-statement ).
 */
export function computeConsolidationConfidence(
  base: number,
  evidence: readonly ConfidenceEvidence[],
): number {
  const corroborating = evidence.filter((e) => e.kind === "event" || e.kind === "review").length;
  const hasMetric = evidence.some((e) => e.kind === "metric");
  const onlyStatements = evidence.length > 0 && evidence.every((e) => e.kind === "statement");
  return clamp01(
    Math.min(base, 0.6) +
      Math.min(0.15 * corroborating, 0.3) +
      (hasMetric ? 0.25 : 0) -
      (onlyStatements ? 0.2 : 0),
  );
}

/** Similarity bands of 12 §5.5 (cosine thresholds are WRITER-DECISIONs). */
export const SIMILARITY_BANDS = {
  fastMerge: 0.95,
  compareMerge: 0.86,
  compareNoMerge: 0.7,
} as const;

export type SimilarityBand = "fast_merge" | "compare_merge" | "compare_no_merge" | "unrelated";

export function classifySimilarity(cosine: number): SimilarityBand {
  if (cosine >= SIMILARITY_BANDS.fastMerge) return "fast_merge";
  if (cosine >= SIMILARITY_BANDS.compareMerge) return "compare_merge";
  if (cosine >= SIMILARITY_BANDS.compareNoMerge) return "compare_no_merge";
  return "unrelated";
}
