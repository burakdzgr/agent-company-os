export const packageName = "@acos/db" as const;

export { runMigrations, MIGRATION_LOCK_KEY } from "./migrate.js";

// Repositories, CompanyContext tenancy wrapper and withOutbox land in T13.
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "./schema/index.js";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(pool: Pool): Db {
  return drizzle(pool, { schema });
}
