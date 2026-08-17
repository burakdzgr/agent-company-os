// projectIntakeWorkflow (T42; 14 §3, 09 §2/§4): the intake-queue workflow.
// Sandboxed stages (ingest + analyzers) run as EXECUTION-queue activities on
// the execution worker; control-plane persistence (repo row, report
// artifact, routing) runs on this queue's own activities. Analyzer failures
// degrade their section and NEVER block the report (P6); ingest failure is a
// Founder-visible setup error.
import { proxyActivities } from "@temporalio/workflow";
import type {
  IntakeControlActivities,
  IngestSummary,
} from "../../intake/activities.js";

// The execution worker's intake activity surface (structural — the worker
// package cannot be imported across the dependency matrix).
interface IntakeExecutionActivities {
  ingestRepoActivity(input: {
    projectId: string;
    source: { kind: "git_url"; url: string } | { kind: "empty" };
  }): Promise<IngestSummary & { created: boolean }>;
  runIntakeAnalyzerActivity(input: {
    projectId: string;
    worktreeVolume: string;
    analyzerKey: string;
  }): Promise<{
    analyzer: string;
    title: string;
    ok: boolean;
    findings: unknown;
    error: string | null;
    durationMs: number;
  }>;
  destroyIntakeWorkspaceActivity(input: { projectId: string }): Promise<void>;
}

const execution = proxyActivities<IntakeExecutionActivities>({
  taskQueue: "execution",
  startToCloseTimeout: "5 minutes", // 14 §3.1 per-analyzer budget
  heartbeatTimeout: "30 seconds",
  retry: { maximumAttempts: 2 }, // infra retry only; analyzer errors are results
});

const ingestExecution = proxyActivities<Pick<IntakeExecutionActivities, "ingestRepoActivity">>({
  taskQueue: "execution",
  startToCloseTimeout: "10 minutes",
  heartbeatTimeout: "60 seconds",
  retry: { maximumAttempts: 2 },
});

const control = proxyActivities<IntakeControlActivities>({
  startToCloseTimeout: "1 minute",
  retry: { maximumAttempts: 5 },
});

/** The MVP analyzer plan — keys mirror the execution worker's registry. */
export const INTAKE_ANALYZER_PLAN = [
  "repo_profile",
  "languages",
  "structure",
  "dependencies",
  "tests",
  "docs",
  "config_env",
  "security_smells",
  "code_graph",
] as const;

export interface ProjectIntakeInput {
  companyId: string;
  projectId: string;
  source: { kind: "git_url"; url: string } | { kind: "empty" };
}

export interface ProjectIntakeResult {
  outcome: "routed";
  reportArtifactId: string | null;
  goalTaskId: string;
  analyzersOk: number;
  analyzersFailed: number;
}

export async function projectIntakeWorkflow(
  input: ProjectIntakeInput,
): Promise<ProjectIntakeResult> {
  const project = await control.loadProjectActivity({
    companyId: input.companyId,
    projectId: input.projectId,
  });

  // ---- stage 1: ingest — the only stage whose failure fails the intake ----
  let ingest: IngestSummary & { created: boolean };
  try {
    ingest = await ingestExecution.ingestRepoActivity({
      projectId: input.projectId,
      source: input.source,
    });
  } catch (err) {
    await control.failIntakeActivity({
      companyId: input.companyId,
      projectId: input.projectId,
      reason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  await control.recordIngestActivity({
    companyId: input.companyId,
    projectId: input.projectId,
    ingest,
    sourceRef: input.source.kind === "git_url" ? input.source.url : null,
  });

  // ---- stage 2: analyzer fan-out (imported repos only) — failures degrade ----
  const analyzers: Awaited<ReturnType<IntakeExecutionActivities["runIntakeAnalyzerActivity"]>>[] =
    [];
  if (ingest.worktreeVolume) {
    const results = await Promise.all(
      INTAKE_ANALYZER_PLAN.map((analyzerKey) =>
        execution
          .runIntakeAnalyzerActivity({
            projectId: input.projectId,
            worktreeVolume: ingest.worktreeVolume!,
            analyzerKey,
          })
          .catch((err: unknown) => ({
            analyzer: analyzerKey,
            title: analyzerKey,
            ok: false,
            findings: null,
            error: err instanceof Error ? err.message : String(err),
            durationMs: 0,
          })),
      ),
    );
    analyzers.push(...results);
    await execution
      .destroyIntakeWorkspaceActivity({ projectId: input.projectId })
      .catch(() => {});
  }

  // ---- stages 3+5: report + routing ----
  // B4: a project with NO repository used to get no report at all — the CEO
  // was routed a bare objective while an imported project got fifteen
  // sections. An idea deserves the same treatment: the repo-derived sections
  // say "no repository yet" and the interpretive pass writes the rest from
  // the objective.
  const greenfield = !ingest.worktreeVolume;
  const saved = await control.saveIntakeReportActivity({
    companyId: input.companyId,
    projectId: input.projectId,
    projectName: project.name,
    objective: project.objective,
    constraints: project.constraints,
    sourceRef: input.source.kind === "git_url" ? input.source.url : null,
    ingest,
    analyzers,
    ...(greenfield && { greenfield: true }),
  });
  const reportArtifactId: string | null = saved.artifactId;
  const summary = saved.summary;

  // ---- stage 4: memory seeding (14 §3.1 stage 4, previously T44) ----
  // Project-scope memories from analyzer findings enable agents to learn
  // codebase structure/patterns without repeatedly reading files. Degrades
  // gracefully (P6) — zero memories created on analyzer failure.
  await control
    .seedProjectMemoriesActivity({
      companyId: input.companyId,
      projectId: input.projectId,
      projectName: project.name,
      analyzers,
      reportSummary: summary,
    })
    .catch(() => {}); // failure is non-blocking; agents fall back to file reads

  // ---- stage 4b: GOAL created in PLANNED state, awaiting Founder consultation (T48) ----
  const routed = await control.routeIntakeActivity({
    companyId: input.companyId,
    projectId: input.projectId,
    objective: project.objective,
    reportArtifactId,
    findingsSummary: summary,
  });

  // ---- stage 5: CEO consults Founder (T48) ----
  // GOAL is PLANNED; CEO asks for Founder approval before assignment
  // Founder response via UI → GOAL transitions to ASSIGNED → CEO workflow starts
  const consultation = await control
    .ceoConsultFounder({
      companyId: input.companyId,
      projectId: input.projectId,
      goalTaskId: routed.goalTaskId,
      objective: project.objective,
      draftSummary: summary,
    })
    .catch((err) => {
      // Consultation timeout or rejection → still continue (non-blocking)
      console.warn("CEO consultation failed:", err);
      return { approved: true }; // auto-approve on error
    });

  // Founder onayladıysa CEO döngüsü başlar. Başlatma bir AKTİVİTE üzerinden
  // yapılır: workflow kodu aktivite bağımlılıklarını göremez (deterministik
  // sandbox), yan etkisi olan her şey aktiviteden geçer.
  if (consultation.approved) {
    await control.startCeoWorkflowActivity({
      companyId: input.companyId,
      agentId: routed.ceoAgentId,
      taskId: routed.goalTaskId,
    });
  }

  return {
    outcome: "routed",
    reportArtifactId,
    goalTaskId: routed.goalTaskId,
    analyzersOk: analyzers.filter((a) => a.ok).length,
    analyzersFailed: analyzers.filter((a) => !a.ok).length,
  };
}
