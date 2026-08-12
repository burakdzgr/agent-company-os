// Real ToolDispatchPort (T40; 17 §4 step 7): workspace-level tools execute
// inside the task's hardened workspace container via sandbox-manager's
// internal HTTP API — the T38 WorkspaceService provisions the bare repo +
// worktree volume + container on first use and records everything with
// workspace.* events. The gateway remains the only caller (S3); this module
// is the gateway's dispatch arm, never a bypass.
//
// Tool coverage in T40: fs.read / fs.write (T38 soft lock upserted, warn-
// not-block) / fs.search / terminal.run / git.diff / git.commit (Task:
// trailer injected per 15 §3.4). git.branch/git.merge land with the review
// flow (T43); db.inspect/web.*/task.query/memory.search with T42/T45 — all
// return typed failures that the gateway audits as status=failed.
import {
  companyContext,
  ReviewsService,
  TaskStateService,
  WorkspaceService,
  type CompanyContext,
  type GuardedDb,
  type SandboxPort,
} from "@acos/db";
import { and, eq } from "drizzle-orm";
import { agents, companies, tasks, workspaces as workspacesTable } from "@acos/db/schema";
import type { MergeBranchResponse } from "@acos/contracts";
import type { IsolationLevel } from "@acos/domain";
import type {
  EnsureRepoResponse,
  ExecResult,
  ProvisionWorktreeResponse,
  Workspace,
} from "@acos/contracts";
import type { ToolDispatchPort } from "./gateway.js";

export interface SandboxDispatchOptions {
  guardedDb: GuardedDb;
  sandboxManagerUrl: string;
  internalApiToken: string;
  /** Workspace image when the project carries no override (15 §3.1). */
  defaultImage?: string;
}

class DispatchError extends Error {}

/** Minimal typed client for sandbox-manager's internal API (T37/T38). */
class SandboxHttp {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new DispatchError(`sandbox-manager ${method} ${path} → ${res.status}: ${text}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  ensureRepo(projectId: string) {
    return this.request<EnsureRepoResponse>("POST", "/internal/v1/repos", { projectId });
  }
  provisionWorktree(input: { projectId: string; volumeName: string; branch: string }) {
    return this.request<ProvisionWorktreeResponse>("POST", "/internal/v1/worktrees", input);
  }
  createWorkspace(input: {
    workspaceId: string;
    isolation: string;
    image: string;
    mounts: { source: string; target: string; readonly: boolean; type: "bind" | "volume" }[];
  }) {
    return this.request<Workspace>("POST", "/internal/v1/workspaces", input);
  }
  destroyWorkspace(workspaceId: string) {
    return this.request<void>("DELETE", `/internal/v1/workspaces/${workspaceId}`);
  }
  removeWorktree(volumeName: string) {
    return this.request<void>("DELETE", `/internal/v1/worktrees/${volumeName}`);
  }
  mergeBranch(input: {
    projectId: string;
    branch: string;
    message: string;
    authorName: string;
    authorEmail: string;
    reviewedBy: string;
  }) {
    return this.request<MergeBranchResponse>("POST", "/internal/v1/repos/merge", input);
  }
  pushBranch(input: { projectId: string; volumeName: string; branch: string; force?: boolean }) {
    return this.request<{ pushed: true; remoteHead: string }>(
      "POST",
      "/internal/v1/worktrees/push",
      input,
    );
  }
  exec(
    workspaceId: string,
    input: {
      command: string[];
      env?: Record<string, string>;
      timeoutMs: number;
      cwd?: string;
      /** Stream PTY frames to NATS `term.<sessionId>` while awaiting (T41). */
      sessionId?: string;
    },
  ) {
    return this.request<ExecResult>("POST", `/internal/v1/workspaces/${workspaceId}/exec`, {
      env: {},
      ...(input.sessionId && { waitForResult: true }),
      ...input,
    });
  }
}

const TAIL_BYTES = 32 * 1024;
const tail = (s: string) => (s.length > TAIL_BYTES ? s.slice(-TAIL_BYTES) : s);

/** Workspace-relative path guard: no escapes, no absolute paths, quotable. */
function safeRelPath(path: string): string {
  if (path.startsWith("/") || path.split("/").includes("..") || path.includes("\0")) {
    throw new DispatchError(`unsafe workspace path: ${path}`);
  }
  return path;
}

const shq = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

export function createSandboxDispatchPort(options: SandboxDispatchOptions): ToolDispatchPort {
  const db = options.guardedDb;
  const http = new SandboxHttp(options.sandboxManagerUrl, options.internalApiToken);
  const workspaces = new WorkspaceService(db);
  const reviewsService = new ReviewsService(db);
  const taskState = new TaskStateService(db);
  const defaultImage = options.defaultImage ?? "acos/workspace-node";

  // T38 seam: DB records + events stay in WorkspaceService; the container/git
  // legwork happens in sandbox-manager behind this port.
  function provisioningPort(image: string, isolation: IsolationLevel): SandboxPort {
    return {
      ensureRepo: (projectId) => http.ensureRepo(projectId),
      provisionWorktree: (input) => http.provisionWorktree(input),
      createContainer: async ({ workspaceId, volumeName }) => {
        const ws = await http.createWorkspace({
          workspaceId,
          isolation,
          image,
          mounts: [{ source: volumeName, target: "/work", readonly: false, type: "volume" }],
        });
        return { containerId: ws.containerId };
      },
      destroyContainer: (workspaceId) => http.destroyWorkspace(workspaceId),
      removeWorktree: (volumeName) => http.removeWorktree(volumeName),
    };
  }

  /** Get-or-provision the task's live workspace at the tool's level. */
  async function workspaceFor(
    ctx: CompanyContext,
    agentId: string,
    taskId: string,
    level: IsolationLevel,
  ) {
    const { workspace } = await workspaces.provision(
      ctx,
      { taskId, agentId, isolationLevel: level, image: defaultImage },
      provisioningPort(defaultImage, level),
    );
    if (!["ready", "in_use", "idle"].includes(workspace.status)) {
      throw new DispatchError(`workspace ${workspace.id} unusable (status=${workspace.status})`);
    }
    if (workspace.status === "ready" || workspace.status === "idle") {
      await workspaces.transition(ctx, workspace.id, "in_use", {
        actor: { kind: "agent", id: agentId },
      });
    }
    return workspace;
  }

  async function execScript(
    workspaceId: string,
    script: string,
    opts: { timeoutMs: number; env?: Record<string, string>; sessionId?: string } = {
      timeoutMs: 60_000,
    },
  ): Promise<ExecResult> {
    return http.exec(workspaceId, {
      command: ["/bin/sh", "-lc", script],
      cwd: "/work",
      timeoutMs: opts.timeoutMs,
      ...(opts.env && { env: opts.env }),
      ...(opts.sessionId && { sessionId: opts.sessionId }),
    });
  }

  return {
    // first-touch provisioning (bare repo + worktree clone + image pull +
    // container) happens here, OUTSIDE the tool's execution timeout window
    async prepare({ ctx: rawCtx, tool, agentId, taskId }) {
      const needsWorkspace = ["analysis", "coding", "testing"].includes(tool.sandboxLevel);
      if (!needsWorkspace || !taskId) return;
      await workspaceFor(
        companyContext(rawCtx.companyId),
        agentId,
        taskId,
        tool.sandboxLevel as IsolationLevel,
      );
    },

    async dispatch({ ctx: rawCtx, tool, input, agentId, taskId }) {
      const ctx = companyContext(rawCtx.companyId);
      const args = input as Record<string, unknown>;

      // git.merge is SERVER-SIDE in the bare repo (15 §3.6) — no workspace
      if (tool.name === "git.merge") {
        if (!taskId) throw new DispatchError("git.merge needs a task context");
        const eligibility = await reviewsService.mergeEligibility(ctx, taskId);
        if (!eligibility.eligible) {
          throw new DispatchError(
            `merge blocked — reviews not approved (${eligibility.missing.join(", ") || "none requested"})`,
          );
        }
        const [task] = await db
          .select()
          .from(tasks)
          .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
        if (!task?.projectId) throw new DispatchError("git.merge needs a project task");
        const [workspaceRow] = await db
          .select()
          .from(workspacesTable)
          .where(
            and(eq(workspacesTable.companyId, ctx.companyId), eq(workspacesTable.taskId, taskId)),
          );
        const branch = (args.branch as string) || workspaceRow?.branch || "";
        if (!branch) throw new DispatchError("git.merge: no task branch found");
        const [agent] = await db
          .select({ name: agents.name, employeeNumber: agents.employeeNumber })
          .from(agents)
          .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)));
        const [company] = await db
          .select({ slug: companies.slug })
          .from(companies)
          .where(eq(companies.id, ctx.companyId));
        const approvedReviewers = (await reviewsService.listForTask(ctx, taskId))
          .filter((r) => r.status === "approved" && r.reviewerAgentId)
          .map((r) => `agent-${r.reviewerAgentId!.slice(-8)}`)
          .join(", ");
        const result = await http.mergeBranch({
          projectId: task.projectId,
          branch,
          message: `merge(${branch}): TASK-${task.number} ${task.title}`.slice(0, 200),
          authorName: agent?.name ?? "ACOS Lead",
          authorEmail: `agent-${String(agent?.employeeNumber ?? 0).padStart(3, "0")}@${company?.slug ?? "acos"}.acos`,
          reviewedBy: approvedReviewers || "review-chain",
        });
        if (!result.merged) {
          return {
            output: {
              merged: false,
              mergeCommitSha: "",
              conflict: { files: result.conflictFiles },
              provenance: "workspace",
            },
            resultSummary: `conflict in ${result.conflictFiles.length} file(s) — rebase in the owner workspace (15 §3.7)`,
          };
        }
        // merged: workspace → merged (locks release), reviews stamped, task → DONE
        if (workspaceRow) {
          if (workspaceRow.status === "ready") {
            await workspaces.transition(ctx, workspaceRow.id, "in_use", {
              actor: { kind: "agent", id: agentId },
            });
          }
          await workspaces
            .transition(ctx, workspaceRow.id, "merged", {
              actor: { kind: "agent", id: agentId },
              mergeCommit: result.mergeCommit,
            })
            .catch(() => {}); // already merged on a replay — fine
        }
        await reviewsService.recordMerge(ctx, taskId, result.mergeCommit);
        await taskState
          .transition(ctx, taskId, "DONE", { kind: "system" })
          .catch(() => {}); // task not in QA (e.g. approval-gated) — the engine decides
        return {
          output: {
            merged: true,
            mergeCommitSha: result.mergeCommit,
            conflict: null,
            provenance: "workspace",
          },
          resultSummary: `squash-merged ${branch} → main @ ${result.mergeCommit.slice(0, 8)}`,
        };
      }

      const needsWorkspace = ["analysis", "coding", "testing"].includes(tool.sandboxLevel);
      if (!needsWorkspace) {
        throw new DispatchError(`${tool.name} dispatch lands with a later task (T42/T43/T45)`);
      }
      if (!taskId) {
        throw new DispatchError(`${tool.name} needs a task context (workspace tools are per-task)`);
      }
      const level = tool.sandboxLevel as IsolationLevel;
      // fast path after prepare(): the live in_use row is returned as-is
      const ws = await workspaceFor(ctx, agentId, taskId, level);

      switch (tool.name) {
        case "terminal.run": {
          const timeoutSec = args.timeoutSec as number;
          // terminal session record (T38) — frames go live with T41's PTY path
          const session = await workspaces.openTerminal(ctx, {
            workspaceId: ws.id,
            agentId,
            title: String(args.command).slice(0, 120),
            actor: { kind: "agent", id: agentId },
          });
          try {
            const result = await execScript(ws.id, String(args.command), {
              timeoutMs: timeoutSec * 1000,
              // live PTY frames on term.<sessionId> while we await (T41)
              sessionId: session.id,
              env: {
                // hardened rootfs is read-only — point every writer at /tmp
                HOME: "/tmp",
                npm_config_cache: "/tmp/.npm",
                ...(args.env as Record<string, string>),
              },
            });
            return {
              output: {
                exitCode: result.exitCode,
                stdoutTail: tail(result.stdout),
                stderrTail: tail(result.stderr),
                durationMs: result.durationMs,
                terminalSessionId: session.id,
                provenance: "workspace",
              },
              costCents: Math.max(1, Math.ceil(result.durationMs / 60_000)),
              resultSummary: `exit=${result.exitCode} in ${result.durationMs}ms`,
            };
          } finally {
            await workspaces
              .closeTerminal(ctx, session.id, { kind: "agent", id: agentId })
              .catch(() => {});
          }
        }

        case "fs.read": {
          const path = safeRelPath(String(args.path));
          const maxBytes = args.maxBytes as number;
          const result = await execScript(
            ws.id,
            `if [ -d ${shq(path)} ]; then echo DIR; ls -la ${shq(path)}; else echo FILE; head -c ${maxBytes + 1} ${shq(path)}; fi`,
          );
          if (result.exitCode !== 0) {
            throw new DispatchError(`fs.read failed: ${result.stderr.trim()}`);
          }
          const newline = result.stdout.indexOf("\n");
          const kind = result.stdout.slice(0, newline) === "DIR" ? "dir" : "file";
          let content = result.stdout.slice(newline + 1);
          const truncated = kind === "file" && content.length > maxBytes;
          if (truncated) content = content.slice(0, maxBytes);
          return {
            output: {
              kind,
              content,
              truncated,
              byteSize: Buffer.byteLength(content),
              provenance: "workspace",
            },
          };
        }

        case "fs.write": {
          const path = safeRelPath(String(args.path));
          const content = String(args.content);
          const encoded =
            args.encoding === "base64"
              ? content
              : Buffer.from(content, "utf8").toString("base64");
          const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
          const result = await execScript(
            ws.id,
            `mkdir -p ${shq(dir)} && [ -e ${shq(path)} ] && existed=1 || existed=0; printf '%s' ${shq(encoded)} | base64 -d > ${shq(path)} && echo "existed=$existed"`,
          );
          if (result.exitCode !== 0) {
            throw new DispatchError(`fs.write failed: ${result.stderr.trim()}`);
          }
          // T38 soft lock on the touched path — warn-not-block (15 §3.8)
          const lock = await workspaces.acquireLock(ctx, {
            workspaceId: ws.id,
            pathPrefix: path,
            actor: { kind: "agent", id: agentId },
          });
          return {
            output: {
              byteSize: Buffer.from(encoded, "base64").length,
              created: result.stdout.includes("existed=0"),
              lockConflicts: lock.conflicts.map((c) => ({
                taskId: c.taskId ?? "",
                pathPrefix: c.pathPrefix,
              })),
              provenance: "workspace",
            },
          };
        }

        case "fs.search": {
          const pattern = String(args.pattern);
          const maxResults = args.maxResults as number;
          const flags = args.caseSensitive ? "-rn" : "-rni";
          const result = await execScript(
            ws.id,
            `grep ${flags} --exclude-dir=.git -e ${shq(pattern)} . | head -n ${maxResults + 1}`,
          );
          // grep exit 1 = no matches — a result, not a failure
          if (result.exitCode > 1) {
            throw new DispatchError(`fs.search failed: ${result.stderr.trim()}`);
          }
          const lines = result.stdout.split("\n").filter(Boolean);
          const truncated = lines.length > maxResults;
          const matches = lines.slice(0, maxResults).map((line) => {
            const m = /^\.\/(.*?):(\d+):(.*)$/.exec(line);
            return m
              ? { path: m[1]!, line: Number(m[2]), text: m[3]! }
              : { path: "", line: 0, text: line };
          });
          return { output: { matches, truncated, provenance: "workspace" } };
        }

        case "git.diff": {
          const against = String(args.against ?? "main");
          if (!/^[\w./-]+$/.test(against)) throw new DispatchError(`bad ref: ${against}`);
          const paths = (args.paths as string[]).map((p) => shq(safeRelPath(p))).join(" ");
          const mode = args.stat ? "--stat" : "";
          const result = await execScript(
            ws.id,
            `git diff ${mode} ${shq(against)} -- ${paths} 2>/dev/null || git diff ${mode} -- ${paths}`,
          );
          const body = tail(result.stdout);
          const filesChanged = new Set(
            result.stdout.split("\n").filter((l) => l.startsWith("diff --git")),
          ).size;
          return {
            output: {
              diff: body,
              filesChanged,
              truncated: body.length < result.stdout.length,
              provenance: "workspace",
            },
          };
        }

        case "git.commit": {
          // Task: trailer is derived server-side and cannot reference a
          // different task (15 §3.4); author = agent identity, never a model
          const [task] = await db
            .select({ number: tasks.number })
            .from(tasks)
            .where(and(eq(tasks.companyId, ctx.companyId), eq(tasks.id, taskId)));
          const [agent] = await db
            .select({ name: agents.name, employeeNumber: agents.employeeNumber })
            .from(agents)
            .where(and(eq(agents.companyId, ctx.companyId), eq(agents.id, agentId)));
          const [company] = await db
            .select({ slug: companies.slug })
            .from(companies)
            .where(eq(companies.id, ctx.companyId));
          const message = String(args.message).replace(/^Task:.*$/gm, "").trimEnd();
          const trailer = `Task: TASK-${task!.number}`;
          const author = `${agent!.name} <agent-${String(agent!.employeeNumber).padStart(3, "0")}@${company!.slug}.acos>`;
          const paths = (args.paths as string[]).map((p) => shq(safeRelPath(p)));
          const addCmd = paths.length > 0 ? `git add -- ${paths.join(" ")}` : "git add -A";
          const empty = args.allowEmpty ? "--allow-empty" : "";
          const result = await execScript(
            ws.id,
            [
              `export GIT_AUTHOR_NAME=${shq(agent!.name)} GIT_AUTHOR_EMAIL=${shq(author.slice(author.indexOf("<") + 1, -1))}`,
              `export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"`,
              addCmd,
              `git commit ${empty} -m ${shq(`${message}\n\n${trailer}`)}`,
              `git rev-parse HEAD`,
              `git diff-tree --no-commit-id --name-only -r HEAD | wc -l`,
              `git rev-parse --abbrev-ref HEAD`,
            ].join(" && "),
          );
          if (result.exitCode !== 0) {
            throw new DispatchError(`git.commit failed: ${tail(result.stderr).trim()}`);
          }
          const lines = result.stdout.trim().split("\n");
          return {
            output: {
              commitSha: lines.at(-3)?.trim() ?? "",
              filesCommitted: Number(lines.at(-2)?.trim() ?? 0),
              branch: lines.at(-1)?.trim() ?? "",
              provenance: "workspace",
            },
            resultSummary: `commit ${lines.at(-3)?.slice(0, 8)} on ${lines.at(-1)}`,
          };
        }

        case "git.branch": {
          // push the task branch worktree → bare repo (T43, 15 §3.1); force
          // only ever reaches task/* (sandbox-manager re-enforces the guard)
          const branch = (args.branch as string) || ws.branch || "";
          if (!ws.volumePath) throw new DispatchError("workspace has no worktree volume");
          const pushed = await http.pushBranch({
            projectId: ws.projectId,
            volumeName: ws.volumePath,
            branch,
            force: args.force === true,
          });
          return {
            output: { pushed: true, remoteHead: pushed.remoteHead, provenance: "workspace" },
            resultSummary: `pushed ${branch} @ ${pushed.remoteHead.slice(0, 8)}`,
          };
        }

        default:
          throw new DispatchError(`${tool.name} dispatch lands with a later task (T43/T45)`);
      }
    },
  };
}
