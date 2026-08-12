// memoryConsolidationWorkflow (T44; 12 §5, 09 §2). One execution per trigger
// occurrence — workflow id `memory-consolidation-<company_id>-<trigger_ref>`
// deduplicates. Pure orchestration: the deterministic stages (§5.2 importance,
// §5.3 scope, §5.5 bands, §5.8 confidence) run as pure @acos/domain functions
// inside the workflow; every IO stage is an idempotent activity.
import { proxyActivities } from "@temporalio/workflow";
import {
  IMPORTANCE_DISCARD_THRESHOLD,
  adjustImportance,
  classifySimilarity,
  computeConsolidationConfidence,
  detectMemoryScope,
} from "@acos/domain";
import type { MemoryActivities } from "../../memory/activities.js";

const activities = proxyActivities<MemoryActivities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 3 },
});

export interface MemoryConsolidationInput {
  companyId: string;
  taskId: string;
  /** completed | failed — FAILED is a costly signal (12 §5.2) */
  trigger: "task_completed" | "task_failed";
}

/** Run report (12 §5.10). */
export interface ConsolidationReport {
  extracted: number;
  persisted: number;
  merged: number;
  contradictions: number;
  discarded: number;
  hallucinatedEvidence: number;
}

export async function memoryConsolidationWorkflow(
  input: MemoryConsolidationInput,
): Promise<ConsolidationReport> {
  const report: ConsolidationReport = {
    extracted: 0,
    persisted: 0,
    merged: 0,
    contradictions: 0,
    discarded: 0,
    hallucinatedEvidence: 0,
  };
  const batchId = `task-${input.taskId}`;

  const window = await activities.loadTriggerWindowActivity({
    companyId: input.companyId,
    taskId: input.taskId,
  });
  if (!window.task) return report;

  const candidates = await activities.extractCandidatesActivity({
    companyId: input.companyId,
    window,
  });
  report.extracted = candidates.length;

  for (const candidate of candidates) {
    // §5.2 deterministic importance adjustment + discard threshold
    const entities = candidate.entities as Record<string, unknown>;
    const hasEntities = Object.values(entities).some(
      (v) => Array.isArray(v) && v.length > 0,
    );
    const importance = adjustImportance({
      selfScore: candidate.importance,
      costlyTrigger: input.trigger === "task_failed",
      evidenceRefCount: candidate.evidence_refs.length,
      type: candidate.type,
      hasEntities,
    });
    if (importance < IMPORTANCE_DISCARD_THRESHOLD) {
      report.discarded += 1;
      continue;
    }

    // §5.3 scope rules (LLM tiebreak narrowed to the deterministic default)
    const files = Array.isArray(entities.files) ? entities.files : [];
    const components = Array.isArray(entities.components) ? entities.components : [];
    const scope = detectMemoryScope({
      type: candidate.type,
      suggestedScope: candidate.suggested_scope,
      referencesProjectArtifacts: files.length > 0 || components.length > 0,
      hasProject: window.task.projectId !== null,
    });
    const scopeRef = scope === "project" ? window.task.projectId! : window.task.ownerAgentId;
    if (!scopeRef) {
      report.discarded += 1; // orphan task without owner — nothing to anchor to
      continue;
    }

    // §5.7 evidence analysis (before the embed spend): all-refs-unresolvable
    // ⇒ hallucinated_evidence discard
    const evidence = await activities.resolveEvidenceActivity({
      companyId: input.companyId,
      refs: candidate.evidence_refs,
    });
    if (evidence.allFailed) {
      report.hallucinatedEvidence += 1;
      continue;
    }

    // §5.8 confidence over the RESOLVED evidence
    const confidence = computeConsolidationConfidence(candidate.confidence, evidence.resolved);

    // §5.4 embedding — failure persists with NULL + memory.embedding.failed
    const text = `${candidate.title}\n${candidate.summary}\n${candidate.content}`;
    const embedded = await activities.embedCandidateActivity({
      companyId: input.companyId,
      agentId: window.task.ownerAgentId,
      text,
    });
    if (!embedded.ok) {
      await activities.persistCandidateActivity({
        companyId: input.companyId,
        candidate: {
          scope,
          scopeRef,
          type: candidate.type,
          title: candidate.title,
          content: candidate.content,
          summary: candidate.summary,
          entities,
          importance,
          confidence,
        },
        sourceEventId: window.events[0]?.id ?? null,
        createdByAgentId: window.task.ownerAgentId,
        embedding: null,
        embeddingModel: embedded.model,
        embedFailedError: embedded.error,
        evidence: evidence.resolved,
        relations: [],
      });
      report.persisted += 1;
      continue;
    }

    // §5.5 similarity within the exact scope, same dimension
    const neighbors = await activities.findSimilarActivity({
      companyId: input.companyId,
      scope,
      scopeRef,
      embedding: embedded.embedding,
      dim: embedded.dim,
    });

    const top = neighbors[0];
    if (top && classifySimilarity(top.cosine) === "fast_merge") {
      // near-duplicate fast path: no LLM, evidence appended, done (§5.5)
      await activities.mergeIntoExistingActivity({
        companyId: input.companyId,
        memoryId: top.id,
        evidence: evidence.resolved,
      });
      report.merged += 1;
      continue;
    }

    // §5.6 compare loop over the banded neighbors
    const relations: { toMemoryId: string; kind: "supports" | "contradicts" | "supersedes" }[] = [];
    let mergedAway = false;
    for (const neighbor of neighbors) {
      const band = classifySimilarity(neighbor.cosine);
      if (band === "unrelated" || band === "fast_merge") continue;
      const compared = await activities.compareMemoriesActivity({
        companyId: input.companyId,
        candidate: { type: candidate.type, content: candidate.content },
        neighbor: { id: neighbor.id, type: neighbor.type, content: neighbor.content },
        band,
      });
      if (compared.verdict === "duplicate" && band === "compare_merge") {
        await activities.mergeIntoExistingActivity({
          companyId: input.companyId,
          memoryId: neighbor.id,
          evidence: evidence.resolved,
        });
        report.merged += 1;
        mergedAway = true;
        break;
      }
      if (compared.verdict === "refinement") relations.push({ toMemoryId: neighbor.id, kind: "supports" });
      if (compared.verdict === "contradiction") relations.push({ toMemoryId: neighbor.id, kind: "contradicts" });
    }
    if (mergedAway) continue;

    // §5.9 persist (contradiction cap applied inside the one service impl)
    await activities.persistCandidateActivity({
      companyId: input.companyId,
      candidate: {
        scope,
        scopeRef,
        type: candidate.type,
        title: candidate.title,
        content: candidate.content,
        summary: candidate.summary,
        entities,
        importance,
        confidence,
      },
      sourceEventId: window.events[0]?.id ?? null,
      createdByAgentId: window.task.ownerAgentId,
      embedding: embedded.embedding,
      embeddingModel: embedded.model,
      evidence: evidence.resolved,
      relations,
    });
    report.persisted += 1;
    report.contradictions += relations.filter((r) => r.kind === "contradicts").length;
  }

  await activities.completeConsolidationActivity({
    companyId: input.companyId,
    batchId,
    taskId: input.taskId,
    extracted: report.extracted,
    persisted: report.persisted,
    merged: report.merged,
    discarded: report.discarded + report.hallucinatedEvidence,
  });

  // 12 §6.2 (T46): promotion evaluation fires immediately after any run that
  // added or merged evidence — thresholds may have just been crossed
  if (report.persisted + report.merged > 0) {
    await activities.evaluatePromotionsActivity({ companyId: input.companyId });
  }
  return report;
}
