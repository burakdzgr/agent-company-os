// MVP tool inventory (17 §3.1 shapes under the 35 §9 T39 names). Every tool
// an agent can invoke in MVP is defined here — the gateway is fail-closed on
// anything not in this registry.
import { z } from "zod";
import type { ToolDefinition } from "./contract.js";

const workspacePath = z.string().min(1).max(1024);
const zeroCost = () => ({ amountCents: 0, confidence: "exact" as const });

/** fs.read — R0 file/dir read inside the task workspace (17 §2.1). */
export const fsRead: ToolDefinition = {
  name: "fs.read",
  version: 1,
  description: "Read a file (or directory listing) inside the task workspace. Read-only.",
  input: z.object({
    path: workspacePath,
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
    maxBytes: z.number().int().positive().max(2_000_000).default(262_144),
    range: z
      .object({ startLine: z.number().int().min(1), endLine: z.number().int().min(1) })
      .optional(),
  }),
  output: z.object({
    kind: z.enum(["file", "dir"]),
    content: z.string(),
    truncated: z.boolean(),
    byteSize: z.number().int(),
    provenance: z.literal("workspace"),
  }),
  risk: "R0",
  scopes: ["fs"],
  sandboxLevel: "analysis",
  sideEffectFree: true,
  estimateCost: zeroCost,
  timeoutMs: 10_000,
};

/** fs.search — R0 ripgrep over the workspace. */
export const fsSearch: ToolDefinition = {
  name: "fs.search",
  version: 1,
  description: "Search file contents in the task workspace (ripgrep). Read-only.",
  input: z.object({
    pattern: z.string().min(1).max(1024),
    glob: z.string().max(256).optional(),
    maxResults: z.number().int().positive().max(500).default(100),
    caseSensitive: z.boolean().default(false),
  }),
  output: z.object({
    matches: z.array(
      z.object({ path: z.string(), line: z.number().int(), text: z.string() }),
    ),
    truncated: z.boolean(),
    provenance: z.literal("workspace"),
  }),
  risk: "R0",
  scopes: ["fs"],
  sandboxLevel: "analysis",
  sideEffectFree: true,
  estimateCost: zeroCost,
  timeoutMs: 30_000,
};

/** fs.write — R1 create/overwrite a file in the worktree (upserts the T38
 *  soft lock at dispatch; overlapping-path warnings come back structured). */
export const fsWrite: ToolDefinition = {
  name: "fs.write",
  version: 1,
  description:
    "Create or overwrite a file inside the task worktree. Returns soft-lock warnings when other tasks touch the same paths.",
  input: z.object({
    path: workspacePath,
    content: z.string().max(2_000_000),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
  }),
  output: z.object({
    byteSize: z.number().int(),
    created: z.boolean(),
    lockConflicts: z.array(
      z.object({ taskId: z.string(), pathPrefix: z.string() }),
    ),
    provenance: z.literal("workspace"),
  }),
  risk: "R1",
  scopes: ["fs"],
  sandboxLevel: "coding",
  sideEffectFree: false,
  estimateCost: zeroCost,
  timeoutMs: 15_000,
};

/** terminal.run — R1 shell command in the workspace container (17 §2.2). */
export const terminalRun: ToolDefinition = {
  name: "terminal.run",
  version: 1,
  description:
    "Run a shell command in the task workspace container. Output streams to the task terminal.",
  input: z.object({
    command: z.string().min(1).max(8192),
    cwd: z.string().max(1024).default("."),
    timeoutSec: z.number().int().min(1).max(1800).default(300),
    // gateway strips keys matching /TOKEN|KEY|SECRET|PASS/i before this parses (S2)
    env: z.record(z.string(), z.string()).default({}),
    stdin: z.string().max(65_536).optional(),
  }),
  output: z.object({
    exitCode: z.number().int(),
    stdoutTail: z.string(),
    stderrTail: z.string(),
    durationMs: z.number(),
    terminalSessionId: z.uuid(),
    provenance: z.literal("workspace"),
  }),
  risk: "R1",
  scopes: ["fs", "git"],
  sandboxLevel: "coding",
  sideEffectFree: false,
  estimateCost: (i: { timeoutSec: number }) => ({
    amountCents: Math.ceil(i.timeoutSec / 60),
    confidence: "estimate",
  }),
  timeoutMs: 1_830_000,
  rateLimit: { perAgentPerMin: 20, perCompanyPerMin: 200 },
};

/** git.diff — R0 read-only plumbing over the worktree/bare repo. */
export const gitDiff: ToolDefinition = {
  name: "git.diff",
  version: 1,
  description: "Show the diff of the task branch (against main or a given ref). Read-only.",
  input: z.object({
    against: z.string().max(256).default("main"),
    paths: z.array(workspacePath).max(64).default([]),
    stat: z.boolean().default(false),
  }),
  output: z.object({
    diff: z.string(),
    filesChanged: z.number().int(),
    truncated: z.boolean(),
    provenance: z.literal("workspace"),
  }),
  risk: "R0",
  scopes: ["git"],
  sandboxLevel: "analysis",
  sideEffectFree: true,
  estimateCost: zeroCost,
  timeoutMs: 30_000,
};

/** git.commit — R1 commit to the task branch only (Task: trailer enforced
 *  at dispatch; a commit can never reference a different task, 15 §3.4). */
export const gitCommit: ToolDefinition = {
  name: "git.commit",
  version: 1,
  description:
    "Commit staged worktree changes to the task branch. The Task: trailer is injected/validated automatically.",
  input: z.object({
    message: z.string().min(1).max(4096),
    paths: z.array(workspacePath).max(256).default([]),
    allowEmpty: z.boolean().default(false),
  }),
  output: z.object({
    commitSha: z.string().regex(/^[0-9a-f]{40}$/),
    filesCommitted: z.number().int(),
    branch: z.string(),
    provenance: z.literal("workspace"),
  }),
  risk: "R1",
  scopes: ["git"],
  sandboxLevel: "coding",
  sideEffectFree: false,
  estimateCost: zeroCost,
  timeoutMs: 30_000,
};

/** git.branch — R1 push the task branch to the server bare repo only. */
export const gitBranch: ToolDefinition = {
  name: "git.branch",
  version: 1,
  description:
    "Push the task branch to the project's bare repository (origin). Only task/* branches can be pushed.",
  input: z.object({
    /** Defaults to the task workspace's own branch at dispatch. */
    branch: z.string().min(1).max(256).optional(),
    force: z.boolean().default(false), // allowed ONLY on task/* (rebase flow, 15 §3.7)
  }),
  output: z.object({
    pushed: z.boolean(),
    remoteHead: z.string(),
    provenance: z.literal("workspace"),
  }),
  risk: "R1",
  scopes: ["git"],
  sandboxLevel: "coding",
  sideEffectFree: false,
  estimateCost: zeroCost,
  timeoutMs: 60_000,
};

/** git.merge — R2 lead-agent squash/ff merge into main in the bare repo,
 *  server-side and PR-entity gated (15 §3.6). */
export const gitMerge: ToolDefinition = {
  name: "git.merge",
  version: 1,
  description:
    "Merge an approved task branch into main in the bare repository. Requires approved reviews + green CI gates.",
  input: z.object({
    taskId: z.uuid(),
    /** Defaults to the task workspace's own branch at dispatch. */
    branch: z.string().min(1).max(256).optional(),
    strategy: z.enum(["squash", "ff-only", "merge-commit"]).default("squash"),
    /** Optimistic concurrency when provided; dispatch resolves the head. */
    expectedHeadSha: z.string().regex(/^[0-9a-f]{40}$/).optional(),
  }),
  output: z.object({
    merged: z.boolean(),
    mergeCommitSha: z.string(),
    conflict: z
      .object({ files: z.array(z.string()) })
      .nullable(),
    provenance: z.literal("workspace"),
  }),
  risk: "R2",
  scopes: ["git"],
  sandboxLevel: "none",
  sideEffectFree: false,
  estimateCost: zeroCost,
  timeoutMs: 120_000,
  rateLimit: { perAgentPerMin: 3, perCompanyPerMin: 15 },
};

/** db.inspect — R0 READ-ONLY SQL against project databases; non-SELECT is
 *  rejected and a statement_timeout is enforced at dispatch. */
export const dbInspect: ToolDefinition = {
  name: "db.inspect",
  version: 1,
  description:
    "Run a READ-ONLY SQL query (SELECT only) against a project database, or introspect its schema.",
  input: z.object({
    query: z
      .string()
      .min(1)
      .max(16_384)
      .refine((q) => /^\s*(select|with|show|explain)\b/i.test(q), {
        message: "db.inspect accepts read-only statements only",
      }),
    environment: z.string().max(64).default("local"),
    maxRows: z.number().int().positive().max(1000).default(100),
  }),
  output: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.array(z.unknown())),
    rowCount: z.number().int(),
    truncated: z.boolean(),
    provenance: z.literal("workspace"),
  }),
  risk: "R0",
  scopes: ["db"],
  sandboxLevel: "none",
  sideEffectFree: true,
  estimateCost: zeroCost,
  timeoutMs: 30_000,
};

/** web.fetch — R0 through the egress allowlist proxy; response is wrapped
 *  with provenance markers (S5) before it can enter a Working Set. */
export const webFetch: ToolDefinition = {
  name: "web.fetch",
  version: 1,
  description:
    "Fetch a URL through the egress allowlist proxy. Response content is provenance-wrapped external content.",
  input: z.object({
    url: z.url().max(2048),
    method: z.enum(["GET", "HEAD"]).default("GET"),
    maxBytes: z.number().int().positive().max(5_000_000).default(1_048_576),
  }),
  output: z.object({
    status: z.number().int(),
    contentType: z.string(),
    body: z.string(),
    truncated: z.boolean(),
    provenance: z.literal("web"),
  }),
  risk: "R0",
  scopes: ["network"],
  sandboxLevel: "none",
  sideEffectFree: true,
  estimateCost: zeroCost,
  timeoutMs: 30_000,
};

/** web.search — R0 configured search API adapter. */
export const webSearch: ToolDefinition = {
  name: "web.search",
  version: 1,
  description: "Search the web via the configured search API. Results are external content.",
  input: z.object({
    query: z.string().min(1).max(512),
    maxResults: z.number().int().positive().max(20).default(8),
  }),
  output: z.object({
    results: z.array(
      z.object({ title: z.string(), url: z.string(), snippet: z.string() }),
    ),
    provenance: z.literal("web"),
  }),
  risk: "R0",
  scopes: ["network"],
  sandboxLevel: "none",
  sideEffectFree: true,
  estimateCost: () => ({ amountCents: 1, confidence: "estimate" }),
  timeoutMs: 20_000,
  credentialRefs: ["search.api_key"],
};

/** task.query — R0 read the company's own task board (platform data). */
export const taskQuery: ToolDefinition = {
  name: "task.query",
  version: 1,
  description:
    "Query tasks in this company (status, owner, project filters). Read-only platform data.",
  input: z.object({
    status: z.array(z.string().max(32)).max(16).default([]),
    ownerAgentId: z.uuid().optional(),
    projectId: z.uuid().optional(),
    search: z.string().max(256).optional(),
    limit: z.number().int().positive().max(100).default(25),
  }),
  output: z.object({
    tasks: z.array(
      z.object({
        id: z.string(),
        number: z.number().int(),
        title: z.string(),
        status: z.string(),
        ownerAgentId: z.string().nullable(),
      }),
    ),
    total: z.number().int(),
    provenance: z.literal("platform"),
  }),
  risk: "R0",
  scopes: ["db"],
  sandboxLevel: "none",
  sideEffectFree: true,
  estimateCost: zeroCost,
  timeoutMs: 10_000,
};

/** memory.search — R0 scoped memory retrieval (12 §retrieval; wired T45). */
export const memorySearch: ToolDefinition = {
  name: "memory.search",
  version: 1,
  description:
    "Search organizational memory (own scope + project + company). Read-only.",
  input: z.object({
    query: z.string().min(1).max(1024),
    scopes: z.array(z.enum(["agent", "project", "company"])).max(3).default([]),
    limit: z.number().int().positive().max(50).default(10),
  }),
  output: z.object({
    memories: z.array(
      z.object({
        id: z.string(),
        title: z.string(),
        summary: z.string(),
        scope: z.string(),
        score: z.number(),
      }),
    ),
    provenance: z.literal("platform"),
  }),
  risk: "R0",
  scopes: ["db"],
  sandboxLevel: "none",
  sideEffectFree: true,
  estimateCost: zeroCost,
  timeoutMs: 10_000,
};

/** The 13 MVP tools (35 §9 T39 list, verbatim). */
export const MVP_TOOLS: readonly ToolDefinition[] = [
  fsRead,
  fsWrite,
  fsSearch,
  gitCommit,
  gitBranch,
  gitDiff,
  gitMerge,
  terminalRun,
  dbInspect,
  webFetch,
  webSearch,
  taskQuery,
  memorySearch,
];
