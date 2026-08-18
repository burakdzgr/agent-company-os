// Git model (T38, ADR-010, 15 Â§3.1): per-project BARE repos on a named
// Docker volume + per-task worktree volumes cloned from them on branch
// `task/<task-number>-<slug>`. All git plumbing runs in short-lived helper
// containers (image pinned below) with NO network â€” sandbox-manager itself
// carries no git binary and the bare repo is NEVER mounted into a workspace
// (15 Â§3.1); workspaces only ever see their own worktree volume.
//
// Shell safety: every interpolated value is validated against the strict
// contracts patterns (uuid / task-branch / worktree-volume) before it may
// enter a script.
import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import {
  TASK_BRANCH_PATTERN,
  WORKTREE_VOLUME_PATTERN,
  type EnsureRepoResponse,
  type IngestRepoRequest,
  type IngestRepoResponse,
  type ProvisionWorktreeResponse,
} from "@acos/contracts";

/** Pinned git helper image â€” the only image git plumbing ever runs in. */
export const GIT_HELPER_IMAGE = "alpine/git:v2.45.2";
/** Named volume holding every bare repo, mounted at /data/repos in helpers
 *  so `bare_path` matches the canonical `/data/repos/<project_id>.git`. */
export const REPOS_VOLUME = "acos-repos";
export const REPOS_MOUNT = "/data/repos";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export class GitError extends Error {
  constructor(
    public readonly code: "INVALID_INPUT" | "REPO_NOT_FOUND" | "GIT_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface GitRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitBind {
  volume: string;
  target: string;
  readonly?: boolean;
}

export interface GitRunOptions {
  /**
   * Helper network. Default "none" â€” local-path git needs nothing. Ingest
   * clones (T42) run on "bridge": the clone itself executes no repo code,
   * the container stays unprivileged and short-lived, and the URL is
   * Founder-supplied operator input (recorded softening of 27 Â§12 for this
   * single system operation; agent workloads never get this mode).
   */
  network?: "none" | "bridge";
}

/** The container-running seam â€” faked in unit tests, dockerode in prod. */
export interface GitRunner {
  run(script: string, binds: readonly GitBind[], opts?: GitRunOptions): Promise<GitRunResult>;
  ensureVolume(name: string): Promise<void>;
  removeVolume(name: string): Promise<void>;
}

export interface DockerGitRunnerDeps {
  docker: Docker;
  image?: string;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export class DockerGitRunner implements GitRunner {
  private readonly image: string;
  private imageReady = false;

  constructor(private readonly deps: DockerGitRunnerDeps) {
    this.image = deps.image ?? GIT_HELPER_IMAGE;
  }

  async run(
    script: string,
    binds: readonly GitBind[],
    opts: GitRunOptions = {},
  ): Promise<GitRunResult> {
    await this.ensureImage();
    const network = opts.network ?? "none";
    const container = await this.deps.docker.createContainer({
      Image: this.image,
      Entrypoint: ["/bin/sh", "-c"],
      Cmd: [script],
      Tty: false,
      Labels: { "acos.sandbox": "true", "acos.git_helper": "true" },
      HostConfig: {
        NetworkMode: network,
        // host-gateway alias so tests can serve fixture repos from the host
        ...(network === "bridge" && { ExtraHosts: ["host.docker.internal:host-gateway"] }),
        Binds: binds.map(
          (b) => `${b.volume}:${b.target}${b.readonly ? ":ro" : ""}`,
        ),
        AutoRemove: false,
      },
    });
    let stdout = "";
    let stderr = "";
    try {
      const attached = await container.attach({ stream: true, stdout: true, stderr: true });
      const outS = new PassThrough();
      const errS = new PassThrough();
      outS.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      errS.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      this.deps.docker.modem.demuxStream(attached, outS, errS);
      await container.start();
      const waited = (await container.wait()) as { StatusCode: number };
      // give the demuxer a tick to flush trailing chunks
      await new Promise((resolve) => setImmediate(resolve));
      return { exitCode: waited.StatusCode, stdout, stderr };
    } finally {
      await container.remove({ force: true }).catch(() => {});
    }
  }

  async ensureVolume(name: string): Promise<void> {
    try {
      await this.deps.docker.getVolume(name).inspect();
      return;
    } catch {
      /* not present â€” create below */
    }
    await this.deps.docker.createVolume({
      Name: name,
      Labels: { "acos.sandbox": "true" },
    });
    this.deps.log?.("volume created", { name });
  }

  async removeVolume(name: string): Promise<void> {
    try {
      await this.deps.docker.getVolume(name).remove({ force: true });
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404) return; // idempotent
      throw new GitError("GIT_FAILED", `volume remove failed: ${String(err)}`);
    }
  }

  private async ensureImage(): Promise<void> {
    if (this.imageReady) return;
    try {
      await this.deps.docker.getImage(this.image).inspect();
      this.imageReady = true;
      return;
    } catch {
      /* pull below */
    }
    const stream = await this.deps.docker.pull(this.image);
    await new Promise<void>((resolve, reject) => {
      this.deps.docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve()));
    });
    this.imageReady = true;
  }
}

export interface GitWorkspacesOptions {
  /** Overridable for tests so suites never touch the real repos volume. */
  reposVolume?: string;
}

export class GitWorkspaces {
  private readonly reposVolume: string;

  constructor(
    private readonly runner: GitRunner,
    opts: GitWorkspacesOptions = {},
  ) {
    this.reposVolume = opts.reposVolume ?? REPOS_VOLUME;
  }

  bareRepoPath(projectId: string): string {
    return `${REPOS_MOUNT}/${projectId}.git`;
  }

  /**
   * Idempotent bare-repo init at `/data/repos/<projectId>.git` with a seeded
   * empty root commit on `main` (a bare repo without one cannot be cloned
   * onto a branch).
   */
  async ensureBareRepo(projectId: string): Promise<EnsureRepoResponse> {
    if (!UUID_PATTERN.test(projectId)) {
      throw new GitError("INVALID_INPUT", `projectId is not a uuid: ${projectId}`);
    }
    await this.runner.ensureVolume(this.reposVolume);
    const repo = this.bareRepoPath(projectId);
    const script = [
      "set -e",
      // root helper inspecting uid-1000 worktrees (chown) needs the exception
      "git config --global --add safe.directory '*'",
      `R="${repo}"`,
      'if [ -d "$R" ]; then',
      "  echo EXISTS",
      "else",
      '  git init -q --bare --initial-branch=main "$R"',
      "  T=$(mktemp -d)",
      '  git -C "$T" init -q --initial-branch=main',
      '  git -C "$T" -c user.name="ACOS System" -c user.email="system@acos.local" commit -q --allow-empty -m "chore: initialize repository"',
      '  git -C "$T" push -q "$R" main',
      "  echo CREATED",
      "fi",
      'git --git-dir="$R" rev-parse main',
    ].join("\n");
    const result = await this.runner.run(script, [
      { volume: this.reposVolume, target: REPOS_MOUNT },
    ]);
    if (result.exitCode !== 0) {
      throw new GitError("GIT_FAILED", `bare repo init failed: ${result.stderr.trim()}`);
    }
    const lines = result.stdout.trim().split("\n");
    const headCommit = lines.at(-1)?.trim() ?? "";
    if (!COMMIT_PATTERN.test(headCommit)) {
      throw new GitError("GIT_FAILED", `unexpected init output: ${result.stdout}`);
    }
    return { barePath: repo, headCommit, created: lines[0]?.trim() === "CREATED" };
  }

  /**
   * Idempotent worktree provisioning (15 Â§3.1): fresh clone of the bare repo
   * into the named volume, checked out to a NEW `task/<n>-<slug>` branch.
   * The bare repo is mounted read-only â€” provisioning can never write it.
   */
  async provisionWorktree(input: {
    projectId: string;
    volumeName: string;
    branch: string;
  }): Promise<ProvisionWorktreeResponse> {
    if (!UUID_PATTERN.test(input.projectId)) {
      throw new GitError("INVALID_INPUT", `projectId is not a uuid: ${input.projectId}`);
    }
    if (!WORKTREE_VOLUME_PATTERN.test(input.volumeName)) {
      throw new GitError("INVALID_INPUT", `bad worktree volume name: ${input.volumeName}`);
    }
    if (!TASK_BRANCH_PATTERN.test(input.branch)) {
      throw new GitError("INVALID_INPUT", `bad task branch: ${input.branch}`);
    }
    await this.runner.ensureVolume(input.volumeName);
    const repo = this.bareRepoPath(input.projectId);
    const script = [
      "set -e",
      // root helper inspecting uid-1000 worktrees (chown) needs the exception
      "git config --global --add safe.directory '*'",
      `R="${repo}"`,
      '[ -d "$R" ] || { echo "bare repo missing" >&2; exit 44; }',
      "if [ -d /work/.git ]; then",
      "  echo EXISTS",
      "else",
      '  git clone -q "$R" /work',
      `  git -C /work checkout -q -b "${input.branch}"`,
      "  echo CREATED",
      "fi",
      // the workspace image runs unprivileged (uid 1000, S8) â€” hand the
      // worktree over so writes and commits work inside the container
      "chown -R 1000:1000 /work",
      "chmod -R go+rwX /work",
      "git -C /work rev-parse HEAD",
    ].join("\n");
    const result = await this.runner.run(script, [
      { volume: this.reposVolume, target: REPOS_MOUNT, readonly: true },
      { volume: input.volumeName, target: "/work" },
    ]);
    if (result.exitCode === 44) {
      throw new GitError("REPO_NOT_FOUND", `no bare repo for project ${input.projectId}`);
    }
    if (result.exitCode !== 0) {
      throw new GitError("GIT_FAILED", `worktree provisioning failed: ${result.stderr.trim()}`);
    }
    const lines = result.stdout.trim().split("\n");
    const baseCommit = lines.at(-1)?.trim() ?? "";
    if (!COMMIT_PATTERN.test(baseCommit)) {
      throw new GitError("GIT_FAILED", `unexpected provisioning output: ${result.stdout}`);
    }
    return {
      volumeName: input.volumeName,
      baseCommit,
      created: lines[0]?.trim() === "CREATED",
    };
  }

  /** Remove a worktree volume (workspace cleanup). Idempotent; the strict
   *  name pattern structurally protects the repos volume. */
  async removeWorktree(volumeName: string): Promise<void> {
    if (!WORKTREE_VOLUME_PATTERN.test(volumeName)) {
      throw new GitError("INVALID_INPUT", `bad worktree volume name: ${volumeName}`);
    }
    await this.runner.removeVolume(volumeName);
  }

  /** Intake worktree volume: task number 0 is reserved for the RO analysis
   *  worktree (T42) â€” the name still fits WORKTREE_VOLUME_PATTERN. Last 8
   *  hex = uuidv7 random bits (the first 8 are shared timestamp bits). */
  intakeWorktreeName(projectId: string): string {
    return `ws-0-${projectId.replace(/-/g, "").slice(-8)}`;
  }

  /**
   * Project intake ingest (14 Â§3.1 stage 1): copy the source into the bare
   * repo â€” the platform's own origin (P1: path derived from the id, never
   * user-supplied) â€” then materialize a read-only intake worktree volume for
   * the analysis containers. Idempotent on the bare repo.
   */
  async ingestRepo(input: IngestRepoRequest): Promise<IngestRepoResponse> {
    if (!UUID_PATTERN.test(input.projectId)) {
      throw new GitError("INVALID_INPUT", `projectId is not a uuid: ${input.projectId}`);
    }
    await this.runner.ensureVolume(this.reposVolume);
    const repo = this.bareRepoPath(input.projectId);

    if (input.source.kind === "empty") {
      const seeded = await this.ensureBareRepo(input.projectId);
      return {
        barePath: seeded.barePath,
        headCommit: seeded.headCommit,
        defaultBranch: "main",
        branches: ["main"],
        sizeKb: 0,
        created: seeded.created,
        worktreeVolume: null,
      };
    }

    // url is schema-validated to exclude quotes/backslashes/whitespace
    const url = input.source.url;
    if (!/^https?:\/\/[^\s'"\\]+$/.test(url)) {
      throw new GitError("INVALID_INPUT", `bad ingest url`);
    }
    const script = [
      "set -e",
      // root helper inspecting uid-1000 worktrees (chown) needs the exception
      "git config --global --add safe.directory '*'",
      `R="${repo}"`,
      'if [ -d "$R" ]; then',
      "  echo '::created::0'",
      "else",
      `  git clone --bare '${url}' "$R"`,
      "  echo '::created::1'",
      "fi",
      `DB=$(git --git-dir="$R" symbolic-ref --short HEAD 2>/dev/null || echo main)`,
      'echo "::branch::$DB"',
      'echo "::head::$(git --git-dir="$R" rev-parse HEAD)"',
      'echo "::size::$(du -sk "$R" | cut -f1)"',
      `git --git-dir="$R" for-each-ref --format='::ref::%(refname:short)' refs/heads`,
    ].join("\n");
    const result = await this.runner.run(
      script,
      [{ volume: this.reposVolume, target: REPOS_MOUNT }],
      { network: "bridge" },
    );
    if (result.exitCode !== 0) {
      throw new GitError("GIT_FAILED", `ingest clone failed: ${result.stderr.trim().slice(-500)}`);
    }
    const get = (key: string) =>
      result.stdout
        .split("\n")
        .find((l) => l.startsWith(`::${key}::`))
        ?.slice(key.length + 4)
        .trim();
    const headCommit = get("head") ?? "";
    if (!COMMIT_PATTERN.test(headCommit)) {
      throw new GitError("GIT_FAILED", `unexpected ingest output: ${result.stdout.slice(0, 300)}`);
    }
    const worktree = await this.provisionIntakeWorktree(input.projectId);
    return {
      barePath: repo,
      headCommit,
      defaultBranch: get("branch") ?? "main",
      branches: result.stdout
        .split("\n")
        .filter((l) => l.startsWith("::ref::"))
        .map((l) => l.slice(7).trim())
        .slice(0, 100),
      sizeKb: Number(get("size") ?? 0),
      created: get("created") === "1",
      worktreeVolume: worktree,
    };
  }

  /**
   * Push the task branch from its worktree volume to the bare repo (T43;
   * 15 Â§3.1: git.branch pushes to the server bare repo ONLY). Force is
   * permitted on task/* branches exclusively (rebase flow, 15 Â§3.7) â€” main
   * can never be addressed here (branch pattern guard).
   */
  async pushTaskBranch(input: {
    projectId: string;
    volumeName: string;
    branch: string;
    force?: boolean;
  }): Promise<{ pushed: true; remoteHead: string }> {
    if (!UUID_PATTERN.test(input.projectId)) {
      throw new GitError("INVALID_INPUT", `projectId is not a uuid: ${input.projectId}`);
    }
    if (!WORKTREE_VOLUME_PATTERN.test(input.volumeName)) {
      throw new GitError("INVALID_INPUT", `bad worktree volume name: ${input.volumeName}`);
    }
    if (!TASK_BRANCH_PATTERN.test(input.branch)) {
      throw new GitError("INVALID_INPUT", `bad task branch: ${input.branch}`);
    }
    const repo = this.bareRepoPath(input.projectId);
    const force = input.force ? "--force" : "";
    const script = [
      "set -e",
      // root helper inspecting uid-1000 worktrees (chown) needs the exception
      "git config --global --add safe.directory '*'",
      `R="${repo}"`,
      '[ -d "$R" ] || { echo "bare repo missing" >&2; exit 44; }',
      `git -C /work push -q ${force} "$R" "HEAD:refs/heads/${input.branch}"`,
      `echo "::head::$(git --git-dir="$R" rev-parse "refs/heads/${input.branch}")"`,
    ].join("\n");
    const result = await this.runner.run(script, [
      { volume: this.reposVolume, target: REPOS_MOUNT },
      { volume: input.volumeName, target: "/work" },
    ]);
    if (result.exitCode === 44) {
      throw new GitError("REPO_NOT_FOUND", `no bare repo for project ${input.projectId}`);
    }
    if (result.exitCode !== 0) {
      throw new GitError("GIT_FAILED", `push failed: ${result.stderr.trim().slice(-500)}`);
    }
    const head = result.stdout
      .split("\n")
      .find((l) => l.startsWith("::head::"))
      ?.slice(8)
      .trim();
    if (!head || !COMMIT_PATTERN.test(head)) {
      throw new GitError("GIT_FAILED", `unexpected push output: ${result.stdout.slice(0, 300)}`);
    }
    return { pushed: true, remoteHead: head };
  }

  /**
   * Lead squash-merge into main IN THE BARE REPO (T43; 15 Â§3.6, ADR-010):
   * clone â†’ squash-merge the task branch â†’ commit with the Reviewed-by
   * trailer â†’ push main. Conflicts return typed `conflict` with the file
   * list (the owner rebases in their own workspace, 15 Â§3.7) â€” never a
   * partial write. Force-push protection: only `main` moves, fast-forward
   * of the squash commit.
   */
  /**
   * GitHub yansıması (2026-08-18): iç bare repo'yu dış remote'a iter.
   * Kimlik http.extraheader ile gider — token URL'e gömülmez, git'in hata
   * çıktısı URL'i basarsa bile sır sızmaz. --force: iç repo tek gerçek
   * kaynak (ADR-010), yansı her yayında birebir eşitlenir.
   */
  async publishToRemote(input: {
    projectId: string;
    remoteUrl: string;
    /** base64("x-access-token:<PAT>") — sunucu üretir, log'a düşmez. */
    authB64: string;
  }): Promise<{ published: true }> {
    if (!UUID_PATTERN.test(input.projectId)) {
      throw new GitError("INVALID_INPUT", `projectId is not a uuid: ${input.projectId}`);
    }
    if (!/^https:\/\/[^\s'"\\@]+$/.test(input.remoteUrl)) {
      throw new GitError("INVALID_INPUT", "bad remote url");
    }
    if (!/^[A-Za-z0-9+/=]+$/.test(input.authB64)) {
      throw new GitError("INVALID_INPUT", "bad auth blob");
    }
    const repo = this.bareRepoPath(input.projectId);
    const script = [
      "set -e",
      "git config --global --add safe.directory '*'",
      `R="${repo}"`,
      '[ -d "$R" ] || { echo "bare repo missing" >&2; exit 44; }',
      `git --git-dir="$R" -c http.extraheader="AUTHORIZATION: basic ${input.authB64}" push --force "${input.remoteUrl}" 'refs/heads/*:refs/heads/*'`,
      "echo '::published::1'",
    ].join("\n");
    const result = await this.runner.run(
      script,
      [{ volume: this.reposVolume, target: REPOS_MOUNT }],
      { network: "bridge" },
    );
    if (result.exitCode === 44) {
      throw new GitError("REPO_NOT_FOUND", `no bare repo for project ${input.projectId}`);
    }
    if (result.exitCode !== 0) {
      // stderr'i kırparken auth başlığı zaten çıktıya girmez (extraheader)
      throw new GitError("GIT_FAILED", `publish failed: ${result.stderr.trim().slice(-500)}`);
    }
    return { published: true };
  }

  async mergeTaskBranch(input: {
    projectId: string;
    branch: string;
    message: string;
    authorName: string;
    authorEmail: string;
    reviewedBy: string;
  }): Promise<
    | { merged: true; mergeCommit: string }
    | { merged: false; conflictFiles: string[] }
  > {
    if (!UUID_PATTERN.test(input.projectId)) {
      throw new GitError("INVALID_INPUT", `projectId is not a uuid: ${input.projectId}`);
    }
    if (!TASK_BRANCH_PATTERN.test(input.branch)) {
      throw new GitError("INVALID_INPUT", `bad task branch: ${input.branch}`);
    }
    for (const value of [input.message, input.authorName, input.authorEmail, input.reviewedBy]) {
      if (value.includes("'")) {
        throw new GitError("INVALID_INPUT", "single quotes are not allowed in merge metadata");
      }
    }
    const repo = this.bareRepoPath(input.projectId);
    const subject = input.message.replaceAll("\n", " ").slice(0, 200);
    const script = [
      "set -e",
      // root helper inspecting uid-1000 worktrees (chown) needs the exception
      "git config --global --add safe.directory '*'",
      `R="${repo}"`,
      '[ -d "$R" ] || { echo "bare repo missing" >&2; exit 44; }',
      'T=$(mktemp -d)',
      'git clone -q "$R" "$T"',
      `cd "$T"`,
      `git checkout -q main`,
      `export GIT_AUTHOR_NAME='${input.authorName}' GIT_AUTHOR_EMAIL='${input.authorEmail}'`,
      'export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME" GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"',
      // conflict â†’ list files and exit 45 (typed result, no partial state)
      `if ! git merge --squash "origin/${input.branch}" >/dev/null 2>&1; then`,
      "  git diff --name-only --diff-filter=U | sed 's/^/::conflict::/'",
      "  exit 45",
      "fi",
      `git commit -q -m '${subject}' -m 'Reviewed-by: ${input.reviewedBy}' || { echo '::conflict::EMPTY_MERGE' ; exit 45; }`,
      'git push -q "$R" main',
      'echo "::merge::$(git rev-parse HEAD)"',
    ].join("\n");
    const result = await this.runner.run(script, [
      { volume: this.reposVolume, target: REPOS_MOUNT },
    ]);
    if (result.exitCode === 44) {
      throw new GitError("REPO_NOT_FOUND", `no bare repo for project ${input.projectId}`);
    }
    if (result.exitCode === 45) {
      return {
        merged: false,
        conflictFiles: result.stdout
          .split("\n")
          .filter((l) => l.startsWith("::conflict::"))
          .map((l) => l.slice(12).trim())
          .filter(Boolean),
      };
    }
    if (result.exitCode !== 0) {
      throw new GitError("GIT_FAILED", `merge failed: ${result.stderr.trim().slice(-500)}`);
    }
    const commit = result.stdout
      .split("\n")
      .find((l) => l.startsWith("::merge::"))
      ?.slice(9)
      .trim();
    if (!commit || !COMMIT_PATTERN.test(commit)) {
      throw new GitError("GIT_FAILED", `unexpected merge output: ${result.stdout.slice(0, 300)}`);
    }
    return { merged: true, mergeCommit: commit };
  }

  /** Clone the default branch (history included) into the intake worktree
   *  volume â€” mounted READ-ONLY into analysis containers (P2). Idempotent. */
  private async provisionIntakeWorktree(projectId: string): Promise<string> {
    const volumeName = this.intakeWorktreeName(projectId);
    await this.runner.ensureVolume(volumeName);
    const repo = this.bareRepoPath(projectId);
    const script = [
      "set -e",
      // root helper inspecting uid-1000 worktrees (chown) needs the exception
      "git config --global --add safe.directory '*'",
      `R="${repo}"`,
      "if [ ! -d /work/.git ]; then",
      '  git clone "$R" /work',
      "fi",
      "git -C /work rev-parse HEAD",
    ].join("\n");
    const result = await this.runner.run(script, [
      { volume: this.reposVolume, target: REPOS_MOUNT, readonly: true },
      { volume: volumeName, target: "/work" },
    ]);
    if (result.exitCode !== 0) {
      throw new GitError(
        "GIT_FAILED",
        `intake worktree provisioning failed: ${result.stderr.trim().slice(-500)}`,
      );
    }
    return volumeName;
  }
}
