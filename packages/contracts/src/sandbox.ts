// sandbox-manager internal API (28 §2, 27 §11; T37). These schemas define
// the ONLY contract between the execution plane (execution-worker, T40) and
// the Docker-socket owner (S1). The service lives outside the control plane
// and holds zero domain state — so its API schemas live here, not in a
// per-service package. All routes require the shared INTERNAL_API_TOKEN
// bearer (18 §2); there is no session/PAT path.
import { z } from "zod";

export const IsolationLevelSchema = z.enum(["analysis", "coding", "testing"]);
export type IsolationLevelValue = z.infer<typeof IsolationLevelSchema>;

export const WorkspaceMountSchema = z.object({
  source: z.string().min(1),
  target: z.string().min(1),
  readonly: z.boolean().default(false),
  /** Named Docker volumes (worktrees, T38) use "volume"; host paths "bind". */
  type: z.enum(["bind", "volume"]).default("bind"),
});

export const CreateWorkspaceRequestSchema = z.object({
  /** Caller-supplied id (uuid) — idempotent: a live container is returned as-is. */
  workspaceId: z.uuid(),
  isolation: IsolationLevelSchema,
  /** Workspace image; defaults to a minimal base until T38 wires real images. */
  image: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).default({}),
  mounts: z.array(WorkspaceMountSchema).default([]),
  /** Labels stamped on the container for GC and audit (companyId, taskId, …). */
  labels: z.record(z.string(), z.string()).default({}),
});
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;

export const WorkspaceSchema = z.object({
  workspaceId: z.uuid(),
  containerId: z.string(),
  isolation: IsolationLevelSchema,
  status: z.enum(["running", "exited", "destroyed"]),
  createdAt: z.iso.datetime(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const ExecRequestSchema = z.object({
  command: z.array(z.string()).min(1),
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).default({}),
  /** Stream PTY frames to NATS `term.<sessionId>` while executing. */
  sessionId: z.uuid().optional(),
  /** With sessionId: await the result (frames still stream live) instead of
   *  the fire-and-forget 202 ack (T41 — tools want frames AND the result). */
  waitForResult: z.boolean().default(false),
  timeoutMs: z.number().int().min(1).max(3_600_000).default(120_000),
});
export type ExecRequest = z.infer<typeof ExecRequestSchema>;

/** Buffered exec result (non-streaming). Streaming execs return {sessionId}. */
export const ExecResultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().int(),
  /** true when killed by the timeout rather than exiting on its own. */
  timedOut: z.boolean(),
});
export type ExecResult = z.infer<typeof ExecResultSchema>;

export const ExecStreamAckSchema = z.object({
  sessionId: z.uuid(),
  streaming: z.literal(true),
});

/** One PTY frame on `term.<sessionId>` (22 §4 terminal envelope). */
export const TerminalFrameSchema = z.object({
  seq: z.number().int(),
  ts: z.number().int(),
  stream: z.enum(["stdout", "stderr"]),
  /** base64 chunk. */
  data: z.string(),
});
export type SandboxTerminalFrame = z.infer<typeof TerminalFrameSchema>;

/** Ring/log replay for late subscribers (22 §5.2, T41): live ring when the
 *  session is running, log-tail fallback after restarts. */
export const TerminalRingResponseSchema = z.object({
  frames: z.array(TerminalFrameSchema),
  currentSeq: z.number().int(),
  source: z.enum(["ring", "log", "none"]),
});
export type TerminalRingResponse = z.infer<typeof TerminalRingResponseSchema>;

export const WorkspaceListSchema = z.array(WorkspaceSchema);

// ---------------------------------------------------------------------------
// Git model (T38, ADR-010, 15 §3): bare repos + per-task worktree volumes.
// The strict patterns double as shell-safety: every value interpolated into a
// git helper script must match one of these.
// ---------------------------------------------------------------------------

/** `task/<task-number>-<slug>` (15 §3.1, _DECISIONS §13). */
export const TASK_BRANCH_PATTERN = /^task\/[0-9]+-[a-z0-9-]+$/;
/** Worktree volume names: `ws-<task_number>-<uuid prefix>` (15 §3.1 naming
 *  decision + a task-id suffix for cross-tenant uniqueness — recorded T38
 *  deviation). */
export const WORKTREE_VOLUME_PATTERN = /^ws-[0-9]+-[0-9a-f]{8}$/;

export const EnsureRepoRequestSchema = z.object({
  /** Bare repo lives at `/data/repos/<projectId>.git` on the repos volume. */
  projectId: z.uuid(),
});
export type EnsureRepoRequest = z.infer<typeof EnsureRepoRequestSchema>;

export const EnsureRepoResponseSchema = z.object({
  barePath: z.string(),
  /** HEAD of the default branch (`main`) after the (idempotent) init. */
  headCommit: z.string().regex(/^[0-9a-f]{40}$/),
  created: z.boolean(),
});
export type EnsureRepoResponse = z.infer<typeof EnsureRepoResponseSchema>;

export const ProvisionWorktreeRequestSchema = z.object({
  projectId: z.uuid(),
  volumeName: z.string().regex(WORKTREE_VOLUME_PATTERN),
  branch: z.string().regex(TASK_BRANCH_PATTERN),
});
export type ProvisionWorktreeRequest = z.infer<typeof ProvisionWorktreeRequestSchema>;

export const ProvisionWorktreeResponseSchema = z.object({
  volumeName: z.string(),
  /** Commit the worktree was cloned at (branch base). */
  baseCommit: z.string().regex(/^[0-9a-f]{40}$/),
  /** false when the volume already held a worktree (idempotent re-provision). */
  created: z.boolean(),
});
export type ProvisionWorktreeResponse = z.infer<typeof ProvisionWorktreeResponseSchema>;
