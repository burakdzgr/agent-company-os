export const packageName = "@acos/db" as const;

export { runMigrations, MIGRATION_LOCK_KEY } from "./migrate.js";
export { companyContext, type CompanyContext } from "./context.js";
export {
  createGuardedDb,
  assertTenantSafe,
  TenancyViolationError,
  TENANT_TABLES,
  PLATFORM_TABLES,
  type GuardedDb,
} from "./tenant.js";
export {
  appendEvents,
  withOutbox,
  type Tx,
  type NewEventInput,
  type AppendedEvent,
  type EventActor,
} from "./outbox.js";
export { nextSequenceValue, nextSequenceBlock, type SequenceName } from "./sequences.js";
export {
  beginIdempotent,
  completeIdempotent,
  type IdempotencyStart,
  type IdempotencyRequest,
} from "./idempotency.js";
export { AgentRepository, type AgentRow, type NewAgentRow } from "./repositories/agents.js";
export { TaskRepository, type TaskRow, type NewTaskRow } from "./repositories/tasks.js";
export {
  OrgRepository,
  type OrgUnitRow,
  type PositionRow,
  type OrgEdgeRow,
} from "./repositories/org.js";
export { CompanyRepository, type CompanyRow } from "./repositories/companies.js";

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "./schema/index.js";

export type Db = NodePgDatabase<typeof schema>;

/** Unguarded instance — platform modules, migrator, seed. */
export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}
export {
  ChannelService,
  MessageService,
  CommsError,
  deliverMessage,
  type ChannelRow,
  type MessageRow,
  type SendInput,
  type DeliveryPlan,
  type SignalPort,
  type InboxItem,
} from "./comms.js";
export {
  TaskEngineError,
  TasksService,
  TaskStateService,
  formatTaskNumber,
  // repositories/tasks.js already claims TaskRow — alias the engine's row type
  type TaskRow as TaskEngineRow,
  type TaskActorInput,
} from "./task-engine.js";
export {
  CostService,
  periodStart,
  type BudgetScope,
  type BudgetPeriod,
  type BudgetRow,
  type CostEntryInput,
  type BudgetStatus,
} from "./costs.js";
export {
  DelegationService,
  WIP_LIMIT_BY_ROLE,
  ASSIGNED_QUEUE_CAP,
  TEAM_WIP_MULTIPLIER,
  type DelegationResult,
} from "./delegation.js";
export {
  ApprovalsService,
  ApprovalError,
  sweepApprovals,
  type ApprovalRow,
  type ChainEntry,
  type CreateApprovalInput,
  type ApprovalVerdictResult,
  type SweepResult,
} from "./approvals.js";
export {
  ReviewsService,
  ReviewError,
  type ReviewRow,
  type ReviewKind,
  type ReviewVerdictValue,
} from "./reviews.js";
export {
  ProjectsService,
  ProjectError,
  projectSlug,
  type ProjectRow,
  type ArtifactRow,
  type CreateProjectInput,
} from "./projects.js";
export {
  MemoryConsolidationService,
  MemoryError,
  type TriggerWindow,
  type WindowEvent,
  type SimilarMemory,
  type EvidenceInput,
  type RelationInput,
  type PersistCandidateInput,
} from "./memory.js";
export {
  WorkspaceService,
  WorkspaceError,
  worktreeVolumeName,
  type WorkspaceRow,
  type WorkspaceLockRow,
  type TerminalSessionRow,
  type RepositoryRow,
  type SandboxPort,
  type ProvisionInput,
  type ProvisionResult,
  type AcquireLockResult,
  type LockConflict,
} from "./workspaces.js";
