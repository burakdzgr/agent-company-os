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
