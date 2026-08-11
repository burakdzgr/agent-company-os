// T40 acceptance (Docker-gated): a scripted agent's terminal.run("npm test")
// executes in a REAL task workspace — gateway authorize → dispatch arm →
// sandbox-manager (spawned as a real child process, exactly the compose
// topology) → bare repo + worktree volume + hardened container → npm test —
// and the result + cost are recorded (tool_invocations succeeded row,
// cost_entries kind=tool, workspace/terminal records with their events).
// Skips cleanly without a Docker daemon or without built dists.
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { and, eq } from "drizzle-orm";
import {
  companyContext,
  createDb,
  createGuardedDb,
  runMigrations,
  type CompanyContext,
  type Db,
  type GuardedDb,
} from "@acos/db";
import {
  agents,
  companies,
  costEntries,
  events,
  orgUnits,
  positions,
  projects,
  tasks,
  terminalSessions,
  toolInvocations,
  toolPermissions,
  users,
  workspaces,
} from "@acos/db/schema";
import { ToolGateway } from "../../src/modules/tools/gateway.js";
import { createSandboxDispatchPort } from "../../src/modules/tools/dispatch.js";
import { startPostgres, type StartedPostgreSqlContainer } from "./helpers";

const INTERNAL_TOKEN = "dispatch-test-token-0123456789";
const SANDBOX_PORT = 3300 + Math.floor(Math.random() * 500);
const SANDBOX_URL = `http://127.0.0.1:${SANDBOX_PORT}`;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const SANDBOX_DIST = join(REPO_ROOT, "services/sandbox-manager/dist/main.js");

let dockerUp = false;
try {
  execSync("docker info", { stdio: "ignore" });
  dockerUp = true;
} catch {
  dockerUp = false;
}
const runnable = dockerUp && existsSync(SANDBOX_DIST);

let container: StartedPostgreSqlContainer;
let pool: Pool;
let db: Db;
let guardedDb: GuardedDb;
let ctx: CompanyContext;
let gateway: ToolGateway;
let sandboxProc: ChildProcess | null = null;
let companyId = "";
let DEV = "";
let taskId = "";
let projectId = "";

async function waitForHealthz(url: string, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`sandbox-manager child did not become healthy at ${url}`);
}

beforeAll(async () => {
  if (!runnable) return;
  // the internal workspaces network is a compose prerequisite (27 §12)
  try {
    execSync("docker network inspect acos-workspaces", { stdio: "ignore" });
  } catch {
    execSync("docker network create --internal acos-workspaces", { stdio: "ignore" });
  }

  container = await startPostgres();
  await runMigrations(container.getConnectionUri());
  pool = new Pool({ connectionString: container.getConnectionUri() });
  db = createDb(pool);
  guardedDb = createGuardedDb(pool);

  // sandbox-manager as a REAL separate process — the compose topology (S1)
  sandboxProc = spawn(process.execPath, [SANDBOX_DIST], {
    env: {
      ...process.env,
      SANDBOX_MANAGER_PORT: String(SANDBOX_PORT),
      INTERNAL_API_TOKEN: INTERNAL_TOKEN,
      NATS_URL: "nats://127.0.0.1:1", // unavailable — frames disabled, boot survives
      DATA_DIR: mkdtempSync(join(tmpdir(), "acos-sbx-")),
    },
    stdio: "ignore",
  });
  await waitForHealthz(SANDBOX_URL);

  gateway = new ToolGateway({
    db: guardedDb,
    dispatch: createSandboxDispatchPort({
      guardedDb,
      sandboxManagerUrl: SANDBOX_URL,
      internalApiToken: INTERNAL_TOKEN,
      // node+npm image so `npm test` is real; the canonical acos/workspace-node
      // image adds git on top (built via pnpm build:workspace-images)
      defaultImage: "node:22-alpine",
    }),
  });

  const [founder] = await db
    .insert(users)
    .values({ email: "founder@t40d.local", passwordHash: "x", displayName: "F" })
    .returning();
  const [company] = await db
    .insert(companies)
    .values({ name: "DispatchCo", slug: "dispatchco", createdByUserId: founder!.id })
    .returning();
  companyId = company!.id;
  ctx = companyContext(companyId);
  const [unit] = await db
    .insert(orgUnits)
    .values({ companyId, kind: "team", name: "Backend", slug: "backend" })
    .returning();
  const [position] = await db
    .insert(positions)
    .values({ companyId, title: "Dev", seniorityTrack: ["mid"], defaultRole: "member" })
    .returning();
  const [agent] = await db
    .insert(agents)
    .values({
      companyId,
      employeeNumber: 1,
      name: "Dana Dev",
      status: "active",
      positionId: position!.id,
      orgUnitId: unit!.id,
      seniority: "mid",
      autonomyLevel: 2,
      persona: "Dev.",
    })
    .returning();
  DEV = agent!.id;
  const [project] = await db
    .insert(projects)
    .values({
      companyId,
      slug: "webshop",
      name: "Webshop",
      objectiveMd: "Ship it",
      createdByUserId: founder!.id,
    })
    .returning();
  projectId = project!.id;
  const [task] = await db
    .insert(tasks)
    .values({
      companyId,
      projectId,
      number: 81,
      kind: "task",
      title: "Add OAuth login",
      objective: "x",
      status: "IN_PROGRESS",
      ownerAgentId: DEV,
    })
    .returning();
  taskId = task!.id;

  for (const tool of ["fs.write", "terminal.run"]) {
    await db.insert(toolPermissions).values({
      companyId,
      toolName: tool,
      subjectKind: "agent",
      subjectId: DEV,
    });
  }
}, 600_000);

afterAll(async () => {
  if (sandboxProc) sandboxProc.kill("SIGTERM");
  // reap the workspace container + volumes this suite created
  if (runnable && taskId) {
    try {
      const [ws] = await db.select().from(workspaces).where(eq(workspaces.taskId, taskId));
      if (ws) execSync(`docker rm -f acos-ws-${ws.id}`, { stdio: "ignore" });
      if (ws?.volumePath) execSync(`docker volume rm -f ${ws.volumePath}`, { stdio: "ignore" });
    } catch {
      /* already gone */
    }
  }
  await pool?.end();
  await container?.stop();
});

describe.skipIf(!runnable)("gateway → dispatch → real workspace (T40 acceptance)", () => {
  it("fs.write seeds package.json into the freshly provisioned worktree (workspace.* events fire)", async () => {
    const pkg = JSON.stringify({
      name: "acceptance",
      scripts: { test: "node -e \"console.log('2 passing'); process.exit(0)\"" },
    });
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "fs.write",
      input: { path: "package.json", content: pkg },
      taskId,
    });
    expect(res.decision).toBe("allow");
    expect(res.status, `dispatch error: ${res.error ?? res.reason ?? "none"}`).toBe("succeeded");
    expect((res.output as { created: boolean }).created).toBe(true);

    // T38 control plane did the provisioning: row + branch + events
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.taskId, taskId));
    expect(ws).toBeDefined();
    expect(ws!.status).toBe("in_use");
    expect(ws!.branch).toBe("task/81-add-oauth-login");
    const provisioned = await db
      .select()
      .from(events)
      .where(and(eq(events.companyId, companyId), eq(events.type, "workspace.provisioned")));
    expect(provisioned).toHaveLength(1);
  }, 600_000);

  it("terminal.run('npm test') executes IN the workspace container; result + cost recorded", async () => {
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "terminal.run",
      input: { command: "npm test", timeoutSec: 120 },
      taskId,
    });
    expect(res.decision).toBe("allow");
    expect(res.status, `dispatch error: ${res.error ?? res.reason ?? "none"}`).toBe("succeeded");
    const output = res.output as {
      exitCode: number;
      stdoutTail: string;
      terminalSessionId: string;
    };
    expect(output.exitCode).toBe(0);
    expect(output.stdoutTail).toContain("2 passing"); // the real npm test output
    expect(res.costCents).toBeGreaterThanOrEqual(1);

    // result recorded on the audit row…
    const [row] = await db
      .select()
      .from(toolInvocations)
      .where(and(eq(toolInvocations.companyId, companyId), eq(toolInvocations.id, res.invocationId!)));
    expect(row!.status).toBe("succeeded");
    expect(row!.costCents).toBe(res.costCents);
    expect(row!.durationMs).toBeGreaterThan(0);

    // …cost in the ledger (26 §1)…
    const costs = await db
      .select()
      .from(costEntries)
      .where(and(eq(costEntries.companyId, companyId), eq(costEntries.kind, "tool")));
    expect(costs.some((c) => c.ref === "terminal.run" && c.amountCents === res.costCents)).toBe(
      true,
    );

    // …and the terminal session record opened + closed around the run (T38)
    const sessions = await db
      .select()
      .from(terminalSessions)
      .where(eq(terminalSessions.id, output.terminalSessionId));
    expect(sessions[0]!.status).toBe("closed");
  }, 600_000);

  it("a failing command comes back as a RESULT (exit != 0), still succeeded + audited", async () => {
    const res = await gateway.invoke(ctx, {
      agentId: DEV,
      toolName: "terminal.run",
      input: { command: "node -e \"process.exit(3)\"", timeoutSec: 60 },
      taskId,
    });
    // dispatch worked; the EXIT CODE is the result
    expect(res.status, `dispatch error: ${res.error ?? res.reason ?? "none"}`).toBe("succeeded");
    expect((res.output as { exitCode: number }).exitCode).toBe(3);
  }, 600_000);
});
