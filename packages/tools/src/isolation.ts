// Workspace isolation levels + the hardened container spec (27 §11,
// _DECISIONS §13, invariant S8). Pure data + a pure HostConfig builder: the
// sandbox-manager (the only Docker-socket owner, S1) applies these; the Tool
// Gateway (T39) reads the matrix to decide which level a tool needs. No
// dockerode here — the shape mirrors Docker's HostConfig so the service
// hands it straight to container create.

export const ISOLATION_LEVELS = ["analysis", "coding", "testing"] as const;
export type IsolationLevel = (typeof ISOLATION_LEVELS)[number];

export function isIsolationLevel(value: string): value is IsolationLevel {
  return (ISOLATION_LEVELS as readonly string[]).includes(value);
}

export interface IsolationLimits {
  /** Fractional CPUs (Docker NanoCpus = cpus × 1e9). */
  readonly cpus: number;
  readonly memoryBytes: number;
  readonly pidsLimit: number;
  readonly diskQuotaBytes: number;
  /**
   * `none`   — no interface beyond loopback (analysis; ro source).
   * `egress` — attached to the internal acos-workspaces network; all traffic
   *            forced through the egress-proxy allowlist (coding/testing).
   */
  readonly network: "none" | "egress";
  /** tmpfs scratch mounted at /tmp (bytes). */
  readonly scratchBytes: number;
}

const GB = 1024 ** 3;

/** 27 §11, verbatim. */
export const ISOLATION_LIMITS: Readonly<Record<IsolationLevel, IsolationLimits>> = {
  analysis: {
    cpus: 1,
    memoryBytes: 1 * GB,
    pidsLimit: 256,
    diskQuotaBytes: 2 * GB,
    network: "none",
    scratchBytes: 512 * 1024 * 1024,
  },
  coding: {
    cpus: 2,
    memoryBytes: 4 * GB,
    pidsLimit: 512,
    diskQuotaBytes: 10 * GB,
    network: "egress",
    scratchBytes: 1 * GB,
  },
  testing: {
    cpus: 4,
    memoryBytes: 8 * GB,
    pidsLimit: 1024,
    diskQuotaBytes: 20 * GB,
    network: "egress",
    scratchBytes: 2 * GB,
  },
};

/** The internal workspaces network (compose `acos-workspaces`, 27 §12).
 *  Env-overridable so the ephemeral e2e stack (P0-A) attaches its workspace
 *  containers to ITS OWN network instead of the dev stack's. */
export const WORKSPACE_NETWORK = process.env.WORKSPACE_NETWORK ?? "acos-workspaces";
export const EGRESS_PROXY_URL = "http://egress-proxy:3128";

/** A container mount, mirroring Docker's HostConfig.Mounts entry. Worktree
 *  volumes (T38) are named Docker volumes — `type: "volume"`; host binds
 *  stay the default. */
export interface WorkspaceMount {
  readonly source: string;
  readonly target: string;
  readonly readonly: boolean;
  readonly type?: "bind" | "volume";
}

/** The subset of Docker's HostConfig we set — kept structural so the service
 *  passes it to dockerode without a translation layer. */
export interface HardenedHostConfig {
  readonly NanoCpus: number;
  readonly Memory: number;
  readonly PidsLimit: number;
  readonly CapDrop: readonly string[];
  readonly SecurityOpt: readonly string[];
  readonly ReadonlyRootfs: true;
  readonly NetworkMode: string;
  readonly Tmpfs: Readonly<Record<string, string>>;
  readonly Mounts: readonly {
    Type: "bind" | "volume";
    Source: string;
    Target: string;
    ReadOnly: boolean;
  }[];
  readonly AutoRemove: false;
}

/**
 * The hardened HostConfig for an isolation level (S8): every capability
 * dropped, no-new-privileges, read-only root fs with a size-capped tmpfs
 * `/tmp`, pids/cpu/memory caps, and NO host mounts beyond the caller's
 * worktree volume. `analysis` gets `network: none`; the others join the
 * internal workspaces network where the only route out is the egress proxy.
 */
export function hardenedHostConfig(
  level: IsolationLevel,
  mounts: readonly WorkspaceMount[] = [],
): HardenedHostConfig {
  const limits = ISOLATION_LIMITS[level];
  return {
    NanoCpus: Math.round(limits.cpus * 1e9),
    Memory: limits.memoryBytes,
    PidsLimit: limits.pidsLimit,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
    ReadonlyRootfs: true,
    NetworkMode: limits.network === "none" ? "none" : WORKSPACE_NETWORK,
    Tmpfs: {
      // noexec on scratch — nothing dropped there may be run (S8 hardening)
      "/tmp": `rw,noexec,nosuid,size=${limits.scratchBytes}`,
    },
    Mounts: mounts.map((m) => ({
      Type: m.type ?? ("bind" as const),
      Source: m.source,
      Target: m.target,
      ReadOnly: m.readonly,
    })),
    AutoRemove: false,
  };
}

/** Proxy env injected into egress-level workspaces so tooling routes out
 *  through the allowlist; there is no default route otherwise (27 §12). */
export function workspaceEnv(level: IsolationLevel): Record<string, string> {
  if (ISOLATION_LIMITS[level].network !== "egress") return {};
  return {
    HTTP_PROXY: EGRESS_PROXY_URL,
    HTTPS_PROXY: EGRESS_PROXY_URL,
    http_proxy: EGRESS_PROXY_URL,
    https_proxy: EGRESS_PROXY_URL,
    NO_PROXY: "localhost,127.0.0.1",
  };
}
