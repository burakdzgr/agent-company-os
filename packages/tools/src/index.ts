export const packageName = "@acos/tools" as const;

export {
  ISOLATION_LEVELS,
  ISOLATION_LIMITS,
  WORKSPACE_NETWORK,
  EGRESS_PROXY_URL,
  isIsolationLevel,
  hardenedHostConfig,
  workspaceEnv,
  type IsolationLevel,
  type IsolationLimits,
  type WorkspaceMount,
  type HardenedHostConfig,
} from "./isolation.js";
