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
