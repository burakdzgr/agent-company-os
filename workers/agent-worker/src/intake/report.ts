// Intake Report renderer (T42; 14 §3.2): the 16 canonical sections with
// FIXED headings — consumers depend on them. Deterministic template over the
// analyzer JSON (14 §3.1 stage 3's interpretive LLM pass lands with the live
// synthesis polish; recorded scope: deterministic synthesis keeps CI and the
// degraded path P6-safe — an unavailable analyzer never blocks the report).
// All repo-derived text is UNTRUSTED (P3): report consumers (working sets)
// wrap artifact content in provenance fences before prompting.

export interface ReportAnalyzerResult {
  analyzer: string;
  title: string;
  ok: boolean;
  findings: unknown;
  error: string | null;
}

export interface ReportInput {
  projectName: string;
  objective: string;
  constraints: string | null;
  sourceRef: string | null;
  ingest: {
    defaultBranch: string;
    headCommit: string;
    branches: string[];
    sizeKb: number;
  };
  analyzers: ReportAnalyzerResult[];
}

const UNAVAILABLE = "_analysis unavailable_";

function fence(value: unknown): string {
  return "```json\n" + JSON.stringify(value, null, 2).slice(0, 6000) + "\n```";
}

function section(results: ReportAnalyzerResult[], key: string): string {
  const hit = results.find((r) => r.analyzer === key);
  if (!hit) return UNAVAILABLE;
  if (!hit.ok) return `${UNAVAILABLE}\n\n> analyzer error: ${hit.error ?? "unknown"}`;
  return fence(hit.findings);
}

/** The 16 canonical headings of 14 §3.2, verbatim and in order. */
export const INTAKE_REPORT_SECTIONS = [
  "Executive summary",
  "Repository profile",
  "Technology stack",
  "Architecture assessment",
  "Dependency health",
  "Data layer",
  "API surface",
  "Test & CI status",
  "Configuration & environments",
  "Documentation state",
  "Security findings",
  "Technical debt register",
  "Quality metrics",
  "Product/market signals",
  "Recommended plan",
  "Open questions for the organization",
] as const;

export function buildIntakeReport(input: ReportInput): string {
  const ok = input.analyzers.filter((a) => a.ok).length;
  const failed = input.analyzers.length - ok;
  const languages = input.analyzers.find((a) => a.analyzer === "languages" && a.ok);
  const langLine = languages
    ? Object.entries(
        (languages.findings as { fileCountsByExtension?: Record<string, number> })
          .fileCountsByExtension ?? {},
      )
        .slice(0, 5)
        .map(([ext, n]) => `${ext} (${n})`)
        .join(", ")
    : "unknown stack";

  const body: Record<(typeof INTAKE_REPORT_SECTIONS)[number], string> = {
    "Executive summary": [
      `**${input.projectName}** — imported ${input.sourceRef ? `from \`${input.sourceRef}\`` : "as a new codebase"}.`,
      ``,
      `Business objective: ${input.objective}`,
      input.constraints ? `\nConstraints: ${input.constraints}` : "",
      ``,
      `Intake ran ${input.analyzers.length} analyzers (${ok} ok, ${failed} degraded). ` +
        `Dominant file types: ${langLine}. Default branch \`${input.ingest.defaultBranch}\` at \`${input.ingest.headCommit.slice(0, 12)}\`, ` +
        `${input.ingest.branches.length} branch(es), ~${Math.round(input.ingest.sizeKb / 1024)} MB bare.`,
    ]
      .filter(Boolean)
      .join("\n"),
    "Repository profile": section(input.analyzers, "repo_profile"),
    "Technology stack": section(input.analyzers, "languages"),
    "Architecture assessment": section(input.analyzers, "structure"),
    "Dependency health": section(input.analyzers, "dependencies"),
    "Data layer": UNAVAILABLE + "\n\n> db-schema analyzer lands with the engineering deep-dive",
    "API surface": UNAVAILABLE + "\n\n> api-surface analyzer lands with the engineering deep-dive",
    "Test & CI status": section(input.analyzers, "tests"),
    "Configuration & environments": section(input.analyzers, "config_env"),
    "Documentation state": section(input.analyzers, "docs"),
    "Security findings": section(input.analyzers, "security_smells"),
    "Technical debt register": UNAVAILABLE + "\n\n> ranked debt register lands with quality metrics",
    "Quality metrics": UNAVAILABLE + "\n\n> complexity/churn metrics land with quality tooling",
    "Product/market signals": UNAVAILABLE,
    "Recommended plan": [
      `1. CEO frames the GOAL from the business objective (attached to the routed task).`,
      `2. CTO runs the technical assessment over sections 2–13.`,
      `3. Leads review their areas; the Architect proposes the target design.`,
      `4. Decomposition into EPICs/TASKs through the standard delegation engine.`,
    ].join("\n"),
    "Open questions for the organization": [
      `- Which areas of the codebase does the objective touch first?`,
      `- Are the degraded analyzer sections (${failed}) worth a manual deep-dive?`,
      `- Does the dependency surface need an upgrade pass before feature work?`,
    ].join("\n"),
  };

  const lines: string[] = [`# Project Intake Report — ${input.projectName}`, ``];
  INTAKE_REPORT_SECTIONS.forEach((heading, i) => {
    lines.push(`## ${i + 1}. ${heading}`, ``, body[heading], ``);
  });
  return lines.join("\n");
}

/** One-line summary for `project.analysis.completed` (10 §10). */
export function findingsSummary(input: ReportInput): string {
  const ok = input.analyzers.filter((a) => a.ok).length;
  const security = input.analyzers.find((a) => a.analyzer === "security_smells" && a.ok);
  const hits = security
    ? ((security.findings as { findings?: unknown[] }).findings?.length ?? 0)
    : 0;
  return (
    `${ok}/${input.analyzers.length} analyzers ok; ` +
    `${input.ingest.branches.length} branches; ${hits} security finding(s)`
  );
}
