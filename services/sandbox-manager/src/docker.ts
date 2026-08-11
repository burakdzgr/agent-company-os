// DockerSandbox — the container lifecycle (S1: the ONLY Docker-socket owner).
// dockerode create/exec/destroy per isolation level with the hardened
// HostConfig from @acos/tools (S8). Buffered exec for tool calls; PTY exec
// streams frames into a TerminalSession (NATS + ring + log). Every container
// carries acos labels so the GC and `list` can find orphans deterministically.
import { PassThrough } from "node:stream";
import Docker from "dockerode";
import {
  hardenedHostConfig,
  isIsolationLevel,
  workspaceEnv,
  type IsolationLevel,
} from "@acos/tools";
import type {
  CreateWorkspaceRequest,
  ExecRequest,
  ExecResult,
  Workspace,
} from "@acos/contracts";
import { TerminalSession, type TerminalLogSink, type TerminalTransport } from "./terminal.js";

const LABEL_MANAGED = "acos.sandbox";
const LABEL_WORKSPACE = "acos.workspace_id";
const LABEL_ISOLATION = "acos.isolation";
const LABEL_CREATED = "acos.created_at";

/** Keeps the container alive so tools can exec into it; runs from the image's
 *  read-only rootfs (the tmpfs /tmp is noexec, S8). */
const KEEPALIVE = ["/bin/sh", "-c", "while true; do sleep 3600; done"];
const DEFAULT_IMAGE = "alpine:3.20"; // real workspace images land with T38

export class SandboxError extends Error {
  constructor(
    public readonly code: "NOT_FOUND" | "IMAGE_PULL_FAILED" | "DOCKER_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

export interface DockerSandboxDeps {
  docker: Docker;
  transport: TerminalTransport;
  logSink: TerminalLogSink;
  nowMs: () => number;
  /** Fixed clock injection stays deterministic in tests. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export class DockerSandbox {
  private readonly docker: Docker;
  private readonly pulled = new Set<string>();
  /** Live terminal sessions — ring source for late WS subscribers (22 §5.2). */
  private readonly terminals = new Map<string, TerminalSession>();
  private static readonly MAX_TRACKED_TERMINALS = 200;

  constructor(private readonly deps: DockerSandboxDeps) {
    this.docker = deps.docker;
  }

  /** create → start; idempotent on workspaceId (a live container is reused). */
  async createWorkspace(req: CreateWorkspaceRequest): Promise<Workspace> {
    const existing = await this.findContainer(req.workspaceId);
    if (existing) {
      const info = await existing.inspect();
      if (info.State.Running) return this.toWorkspace(info);
    }

    const level: IsolationLevel = req.isolation;
    const image = req.image ?? DEFAULT_IMAGE;
    await this.ensureImage(image);

    const env = { ...workspaceEnv(level), ...req.env };
    const hostConfig = hardenedHostConfig(
      level,
      req.mounts.map((m) => ({
        source: m.source,
        target: m.target,
        readonly: m.readonly,
        type: m.type,
      })),
    );

    let container: Docker.Container;
    try {
      // WorkingDir only when a mount provides it — on a read-only rootfs
      // Docker cannot create a missing WorkingDir, so default to "/". The
      // worktree volume mounts rw at /work (15 §3.1, T38).
      const workMount = req.mounts.find((m) => m.target === "/work");
      container = await this.docker.createContainer({
        name: `acos-ws-${req.workspaceId}`,
        Image: image,
        Cmd: KEEPALIVE,
        Tty: false,
        ...(workMount && { WorkingDir: "/work" }),
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        Labels: {
          [LABEL_MANAGED]: "true",
          [LABEL_WORKSPACE]: req.workspaceId,
          [LABEL_ISOLATION]: level,
          [LABEL_CREATED]: String(this.deps.nowMs()),
          ...req.labels,
        },
        HostConfig: hostConfig as unknown as Docker.ContainerCreateOptions["HostConfig"],
      });
      await container.start();
    } catch (err) {
      // TOCTOU on the idempotency check: concurrent creates for the same
      // workspaceId race past findContainer — the 409 loser adopts the winner
      if ((err as { statusCode?: number }).statusCode === 409) {
        const winner = await this.findContainer(req.workspaceId);
        if (winner) {
          const info = await winner.inspect();
          if (!info.State.Running) await winner.start().catch(() => {});
          return this.toWorkspace(await winner.inspect());
        }
      }
      throw new SandboxError("DOCKER_ERROR", `create/start failed: ${String(err)}`);
    }
    const info = await container.inspect();
    this.deps.log?.("workspace created", { workspaceId: req.workspaceId, isolation: level });
    return this.toWorkspace(info);
  }

  /**
   * Buffered exec (tool calls) or PTY-streamed exec (terminals). Timeout is
   * enforced inside the container with busybox `timeout -s KILL` so a runaway
   * command dies at the wall clock, not just client-side.
   */
  async exec(
    workspaceId: string,
    req: ExecRequest,
    session?: TerminalSession,
  ): Promise<ExecResult> {
    const container = await this.requireContainer(workspaceId);
    const timeoutSec = Math.max(1, Math.ceil(req.timeoutMs / 1000));
    const cmd = ["timeout", "-s", "KILL", String(timeoutSec), ...req.command];
    const tty = session !== undefined;

    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
      Tty: tty,
      ...(req.cwd && { WorkingDir: req.cwd }),
      Env: Object.entries(req.env).map(([k, v]) => `${k}=${v}`),
    });

    const started = this.deps.nowMs();
    const stream = await exec.start({ Tty: tty, hijack: true });

    let stdout = "";
    let stderr = "";
    if (tty) {
      // PTY: one merged stream → frames on `term.<sessionId>` AND the
      // buffered result (waitForResult callers need both, T41)
      stream.on("data", (chunk: Buffer) => {
        session!.emit("stdout", chunk);
        stdout += chunk.toString("utf8");
      });
    } else {
      const outS = new PassThrough();
      const errS = new PassThrough();
      outS.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      errS.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      this.docker.modem.demuxStream(stream, outS, errS);
    }

    await new Promise<void>((resolve, reject) => {
      stream.on("end", resolve);
      stream.on("error", reject);
    });

    const inspect = await exec.inspect();
    const exitCode = inspect.ExitCode ?? -1;
    // busybox `timeout -s KILL` → 137 (128+SIGKILL); coreutils → 124
    const timedOut = exitCode === 137 || exitCode === 124;
    return {
      exitCode,
      stdout,
      stderr,
      durationMs: this.deps.nowMs() - started,
      timedOut,
    };
  }

  async destroyWorkspace(workspaceId: string): Promise<void> {
    const container = await this.findContainer(workspaceId);
    if (!container) return; // idempotent
    try {
      await container.remove({ force: true });
    } catch (err) {
      throw new SandboxError("DOCKER_ERROR", `destroy failed: ${String(err)}`);
    }
    this.deps.log?.("workspace destroyed", { workspaceId });
  }

  async list(): Promise<Workspace[]> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_MANAGED}=true`] },
    });
    return containers
      .filter((c) => c.Labels[LABEL_WORKSPACE] && isIsolationLevel(c.Labels[LABEL_ISOLATION] ?? ""))
      .map((c) => ({
        workspaceId: c.Labels[LABEL_WORKSPACE]!,
        containerId: c.Id,
        isolation: c.Labels[LABEL_ISOLATION] as IsolationLevel,
        status: c.State === "running" ? ("running" as const) : ("exited" as const),
        createdAt: new Date(c.Created * 1000).toISOString(),
      }));
  }

  /**
   * GC (27 §11): remove exited containers and any live workspace older than
   * `maxAgeMs` (orphans whose owning task/workflow is long gone). Returns the
   * ids reaped. Runs on an interval from main.ts.
   */
  async gc(maxAgeMs: number): Promise<string[]> {
    const now = this.deps.nowMs();
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_MANAGED}=true`] },
    });
    const reaped: string[] = [];
    for (const c of containers) {
      const workspaceId = c.Labels[LABEL_WORKSPACE];
      if (!workspaceId) continue;
      const createdMs = Number(c.Labels[LABEL_CREATED] ?? c.Created * 1000);
      const exited = c.State !== "running";
      if (exited || now - createdMs > maxAgeMs) {
        try {
          await this.docker.getContainer(c.Id).remove({ force: true });
          reaped.push(workspaceId);
        } catch {
          /* another GC pass or destroy raced us — fine */
        }
      }
    }
    if (reaped.length > 0) this.deps.log?.("gc reaped workspaces", { count: reaped.length });
    return reaped;
  }

  newTerminalSession(sessionId: string): TerminalSession {
    const existing = this.terminals.get(sessionId);
    if (existing) return existing; // resumed exec keeps the seq monotonic
    const session = new TerminalSession(
      sessionId,
      this.deps.transport,
      this.deps.logSink,
      this.deps.nowMs,
    );
    this.terminals.set(sessionId, session);
    // bounded registry — evict oldest finished sessions (their scrollback
    // stays in the rolling log)
    if (this.terminals.size > DockerSandbox.MAX_TRACKED_TERMINALS) {
      const oldest = this.terminals.keys().next().value;
      if (oldest !== undefined) this.terminals.delete(oldest);
    }
    return session;
  }

  terminalSession(sessionId: string): TerminalSession | undefined {
    return this.terminals.get(sessionId);
  }

  // ---------- helpers ----------

  private async ensureImage(image: string): Promise<void> {
    if (this.pulled.has(image)) return;
    try {
      await this.docker.getImage(image).inspect();
      this.pulled.add(image);
      return;
    } catch {
      /* not present — pull below */
    }
    try {
      const stream = await this.docker.pull(image);
      await new Promise<void>((resolve, reject) => {
        this.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
      });
      this.pulled.add(image);
    } catch (err) {
      throw new SandboxError("IMAGE_PULL_FAILED", `pull ${image} failed: ${String(err)}`);
    }
  }

  private async findContainer(workspaceId: string): Promise<Docker.Container | null> {
    const matches = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_WORKSPACE}=${workspaceId}`] },
    });
    const first = matches[0];
    return first ? this.docker.getContainer(first.Id) : null;
  }

  private async requireContainer(workspaceId: string): Promise<Docker.Container> {
    const container = await this.findContainer(workspaceId);
    if (!container) throw new SandboxError("NOT_FOUND", `workspace ${workspaceId} not found`);
    return container;
  }

  private toWorkspace(info: Docker.ContainerInspectInfo): Workspace {
    return {
      workspaceId: info.Config.Labels[LABEL_WORKSPACE]!,
      containerId: info.Id,
      isolation: info.Config.Labels[LABEL_ISOLATION] as IsolationLevel,
      status: info.State.Running ? "running" : "exited",
      createdAt: info.Created,
    };
  }
}
