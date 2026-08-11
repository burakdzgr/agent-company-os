// Intake orchestration activities (T42; 14 §3.1 stages 1' bookkeeping, 3, 5).
// Control-plane IO for projectIntakeWorkflow — persisting through the ONE
// ProjectsService implementation (@acos/db). The sandboxed stages (ingest,
// analyzers) live in the execution worker (14 §3.1's queue assignment).
import { appendEvents, ProjectsService, companyContext, type GuardedDb } from "@acos/db";
import {
  buildIntakeReport,
  findingsSummary,
  type ReportAnalyzerResult,
} from "./report.js";

export interface IntakeControlActivityDeps {
  guardedDb: GuardedDb;
  /** Assignment → CEO agentTaskWorkflow start (09 §4; same port as T36). */
  startAgentWorkflow?:
    | ((input: { companyId: string; agentId: string; taskId: string }) => Promise<void>)
    | undefined;
}

export interface IngestSummary {
  barePath: string;
  headCommit: string;
  defaultBranch: string;
  branches: string[];
  sizeKb: number;
  worktreeVolume: string | null;
}

export function createIntakeControlActivities(deps: IntakeControlActivityDeps) {
  const projectsService = new ProjectsService(deps.guardedDb);

  return {
    /** Project facts the workflow needs (objective, name, source). */
    async loadProjectActivity(input: { companyId: string; projectId: string }) {
      const ctx = companyContext(input.companyId);
      const project = await projectsService.get(ctx, input.projectId);
      return {
        name: project.name,
        objective: project.objectiveMd,
        constraints: project.constraintsMd,
        status: project.status,
      };
    },

    async recordIngestActivity(input: {
      companyId: string;
      projectId: string;
      ingest: IngestSummary;
      sourceRef: string | null;
    }): Promise<void> {
      const ctx = companyContext(input.companyId);
      await projectsService.recordIngest(ctx, input.projectId, {
        barePath: input.ingest.barePath,
        defaultBranch: input.ingest.defaultBranch,
        sourceRef: input.sourceRef,
      });
    },

    /** Stage 3+P6: exactly one report artifact, even for degraded runs. */
    async saveIntakeReportActivity(input: {
      companyId: string;
      projectId: string;
      projectName: string;
      objective: string;
      constraints: string | null;
      sourceRef: string | null;
      ingest: IngestSummary;
      analyzers: ReportAnalyzerResult[];
    }): Promise<{ artifactId: string; summary: string }> {
      const ctx = companyContext(input.companyId);
      const reportInput = {
        projectName: input.projectName,
        objective: input.objective,
        constraints: input.constraints,
        sourceRef: input.sourceRef,
        ingest: input.ingest,
        analyzers: input.analyzers,
      };
      const markdown = buildIntakeReport(reportInput);
      const artifact = await projectsService.saveIntakeReport(ctx, input.projectId, {
        title: `Intake Report — ${input.projectName}`,
        markdown,
        meta: {
          analyzers: input.analyzers.map((a) => ({ key: a.analyzer, ok: a.ok })),
          headCommit: input.ingest.headCommit,
        },
      });
      return { artifactId: artifact.id, summary: findingsSummary(reportInput) };
    },

    /** Stage 5: GOAL → top executive; cascade runs as normal agent loops. */
    async routeIntakeActivity(input: {
      companyId: string;
      projectId: string;
      objective: string;
      reportArtifactId: string | null;
      findingsSummary: string;
    }): Promise<{ goalTaskId: string; ceoAgentId: string }> {
      const ctx = companyContext(input.companyId);
      const routed = await projectsService.routeIntake(ctx, input.projectId, {
        objective: input.objective,
        reportArtifactId: input.reportArtifactId,
        findingsSummary: input.findingsSummary,
      });
      if (routed.created && deps.startAgentWorkflow) {
        await deps
          .startAgentWorkflow({
            companyId: input.companyId,
            agentId: routed.ceoAgentId,
            taskId: routed.goalTaskId,
          })
          .catch(() => {}); // duplicate start = no-op (REJECT_DUPLICATE)
      }
      return { goalTaskId: routed.goalTaskId, ceoAgentId: routed.ceoAgentId };
    },

    /**
     * Ingest failure: a Founder-visible setup error, not an escalation
     * (14 §3.1). The canonical machine has no intake→proposed edge (T10), so
     * the project STAYS in `intake` and the failure is surfaced on the
     * timeline; the Founder retries by re-importing — recorded T42 deviation.
     */
    async failIntakeActivity(input: {
      companyId: string;
      projectId: string;
      reason: string;
    }): Promise<void> {
      const ctx = companyContext(input.companyId);
      await deps.guardedDb.transaction(async (tx) => {
        await appendEvents(tx, ctx, [
          {
            type: "project.intake.started",
            actor: { kind: "system", id: null },
            projectId: input.projectId,
            payload: {
              projectId: input.projectId,
              analysisPlan: [`FAILED: ${input.reason.slice(0, 200)}`],
            },
          },
        ]);
      });
    },
  };
}

export type IntakeControlActivities = ReturnType<typeof createIntakeControlActivities>;
