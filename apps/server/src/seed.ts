// Seed v1 (27 §4, T17): idempotent (keyed on company slug) — creates the
// Founder user and "Acme Technologies" with default settings. Org, positions
// and the 8 agents extend this in T18/T19.
import { randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { companyContext, type CompanyContext, type GuardedDb } from "@acos/db";
import {
  companies,
  modelProfiles,
  modelProviders,
  orgUnits,
  toolPermissions,
  users,
} from "@acos/db/schema";
import { hashPassword } from "./modules/auth/crypto.js";
import { CompanyService } from "./modules/companies/service.js";
import { OrgService } from "./modules/org/service.js";
import { AgentsService } from "./modules/agents/service.js";

export const SEED_COMPANY_SLUG = "acme";
export const SEED_FOUNDER_EMAIL = "founder@acme.local";

export interface SeedResult {
  created: boolean;
  companyId: string;
  founderUserId: string;
  /** Present only when the user was created this run (printed once, 27 §14). */
  founderPassword?: string;
}

export async function ensureSeed(db: GuardedDb): Promise<SeedResult> {
  const [existingCompany] = await db
    .select()
    .from(companies)
    .where(eq(companies.slug, SEED_COMPANY_SLUG));

  const [existingUser] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${SEED_FOUNDER_EMAIL}`);

  if (existingCompany && existingUser) {
    // live routing rows apply to EXISTING installs too (idempotent) — the
    // nightly live-LLM lane boots the same seed with a provider key present
    await ensureLiveModelRouting(db, existingCompany.id);
    return { created: false, companyId: existingCompany.id, founderUserId: existingUser.id };
  }

  let founderUserId = existingUser?.id;
  let founderPassword: string | undefined;
  if (!founderUserId) {
    founderPassword = process.env.SEED_FOUNDER_PASSWORD || randomBytes(12).toString("base64url");
    const [user] = await db
      .insert(users)
      .values({
        email: SEED_FOUNDER_EMAIL,
        passwordHash: await hashPassword(founderPassword),
        displayName: "Founder",
        platformRole: "owner",
      })
      .returning();
    founderUserId = user!.id;
  }

  let companyId = existingCompany?.id;
  if (!companyId) {
    const service = new CompanyService(db);
    const company = await service.create({
      name: "Acme Technologies",
      slug: SEED_COMPANY_SLUG,
      currency: "USD",
      createdByUserId: founderUserId,
    });
    companyId = company.id;
  }

  await seedOrgAndAgents(db, companyId);
  await ensureLiveModelRouting(db, companyId);

  return {
    created: true,
    companyId,
    founderUserId,
    ...(founderPassword !== undefined && { founderPassword }),
  };
}

/**
 * Live-LLM routing rows (T50; 29 §8.3 nightly lane): when a provider key is
 * present and the stack is NOT scripted, ensure the anthropic
 * model_providers row + the seed company's model_profiles (reasoning /
 * coding / fast). Embedding has no anthropic endpoint — the memory pipeline
 * degrades per 12 §5.4/§7.5c (NULL embeddings + skipped semantic lane) until
 * an embedding provider is configured. Idempotent; a no-op without the key.
 */
async function ensureLiveModelRouting(db: GuardedDb, companyId: string): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY || process.env.LLM_MODE === "scripted") return;
  const [existingProvider] = await db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(eq(modelProviders.name, "anthropic"));
  const providerId =
    existingProvider?.id ??
    (
      await db
        .insert(modelProviders)
        .values({ kind: "anthropic", name: "anthropic" })
        .onConflictDoNothing()
        .returning({ id: modelProviders.id })
    )[0]?.id;
  if (!providerId) return; // lost a boot race — the winner seeded it

  const LIVE_MODEL = process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-5";
  const FAST_MODEL = process.env.ANTHROPIC_FAST_MODEL ?? "claude-haiku-4-5-20251001";
  for (const [purpose, model] of [
    ["reasoning", LIVE_MODEL],
    ["coding", LIVE_MODEL],
    ["fast", FAST_MODEL],
  ] as const) {
    await db
      .insert(modelProfiles)
      .values({ companyId, purpose, providerId, model, priority: 0 })
      .onConflictDoNothing();
  }
}

/**
 * 27 §4: Engineering dept (Backend + Frontend teams), positions, the 8 agents
 * (CEO, CTO, EM, Backend Lead, 2 Backend Engineers, 1 Frontend Engineer,
 * 1 QA/Reviewer) with the reports_to forest Dev→Lead→EM→CTO→CEO.
 * Idempotent: skipped when the company already has agents.
 */
async function seedOrgAndAgents(db: GuardedDb, companyId: string): Promise<void> {
  const ctx = companyContext(companyId);
  const [{ n }] = (
    await db.execute(
      sql`SELECT count(*)::int AS n FROM agents WHERE company_id = ${companyId}`,
    )
  ).rows as [{ n: number }];
  if (Number(n) > 0) {
    // additive seed upgrades (T41 grants) still apply to existing installs
    await seedToolGrants(db, ctx);
    return;
  }

  const org = new OrgService(db);
  const agentsService = new AgentsService(db, org);

  const engineering = await org.createUnit(ctx, {
    name: "Engineering",
    slug: "engineering",
    kind: "department",
  });
  const backend = await org.createUnit(ctx, {
    name: "Backend",
    slug: "backend",
    kind: "team",
    parentId: engineering.id,
  });
  const frontend = await org.createUnit(ctx, {
    name: "Frontend",
    slug: "frontend",
    kind: "team",
    parentId: engineering.id,
  });

  const positionOf: Record<string, string> = {};
  for (const [title, track, role] of [
    ["CEO", ["expert"], "executive"],
    ["CTO", ["expert"], "executive"],
    ["Engineering Manager", ["lead", "expert"], "manager"],
    ["Backend Lead", ["senior", "staff", "lead"], "lead"],
    ["Backend Engineer", ["junior", "mid", "senior"], "member"],
    ["Frontend Engineer", ["junior", "mid", "senior"], "member"],
    ["QA/Reviewer", ["mid", "senior"], "reviewer"],
  ] as const) {
    const position = await org.createPosition(ctx, {
      title,
      seniorityTrack: [...track],
      defaultRole: role,
    });
    positionOf[title] = position.id;
  }

  const hire = (input: {
    name: string;
    title: string;
    unitId: string;
    seniority: string;
    autonomyLevel: number;
    persona: string;
    managerAgentId?: string;
    leadsUnit?: boolean;
  }) =>
    agentsService.hire(ctx, {
      name: input.name,
      positionId: positionOf[input.title]!,
      orgUnitId: input.unitId,
      seniority: input.seniority,
      autonomyLevel: input.autonomyLevel,
      persona: input.persona,
      ...(input.managerAgentId !== undefined && { managerAgentId: input.managerAgentId }),
      ...(input.leadsUnit !== undefined && { leadsUnit: input.leadsUnit }),
      activate: true,
    });

  const ceo = await hire({
    name: "Aylin Vural",
    title: "CEO",
    unitId: engineering.id,
    seniority: "expert",
    autonomyLevel: 5,
    persona: "Decisive CEO agent; delegates to executives, never to individual contributors.",
  });
  const cto = await hire({
    name: "Mert Aksoy",
    title: "CTO",
    unitId: engineering.id,
    seniority: "expert",
    autonomyLevel: 5,
    persona: "Pragmatic CTO agent; owns technical direction and the engineering org.",
    managerAgentId: ceo.id,
  });
  const em = await hire({
    name: "Selin Koç",
    title: "Engineering Manager",
    unitId: engineering.id,
    seniority: "lead",
    autonomyLevel: 4,
    persona: "Engineering manager; decomposes objectives and balances team load.",
    managerAgentId: cto.id,
  });
  const backendLead = await hire({
    name: "Kerem Yıldız",
    title: "Backend Lead",
    unitId: backend.id,
    seniority: "lead",
    autonomyLevel: 3,
    persona: "Backend lead; reviews and merges, owns the backend services.",
    managerAgentId: em.id,
    leadsUnit: true,
  });
  await hire({
    name: "Alex Demir",
    title: "Backend Engineer",
    unitId: backend.id,
    seniority: "mid",
    autonomyLevel: 2,
    persona: "Backend engineer; pragmatic, test-first.",
    managerAgentId: backendLead.id,
  });
  await hire({
    name: "Deniz Kaya",
    title: "Backend Engineer",
    unitId: backend.id,
    seniority: "junior",
    autonomyLevel: 2,
    persona: "Backend engineer; eager, asks for review early.",
    managerAgentId: backendLead.id,
  });
  await hire({
    name: "Ece Arslan",
    title: "Frontend Engineer",
    unitId: frontend.id,
    seniority: "mid",
    autonomyLevel: 2,
    persona: "Frontend engineer; owns the SPA views.",
    managerAgentId: em.id,
  });
  await hire({
    name: "Baran Çelik",
    title: "QA/Reviewer",
    unitId: engineering.id,
    seniority: "senior",
    autonomyLevel: 3,
    persona: "QA and independent reviewer; never approves own work.",
    managerAgentId: em.id,
  });

  await seedToolGrants(db, ctx);
}

const SEED_GRANT_UNIT_SLUGS = ["engineering", "backend", "frontend"];
const SEED_GRANT_TOOLS = ["fs.*", "git.*", "terminal.run", "task.query", "memory.search"];

/**
 * Engineering-wide tool grants (T41; 17 §4.1 org_unit subject): the coding
 * toolset for every engineer — granted per unit (member_of is direct, no
 * tree inheritance in MVP); the gateway still applies autonomy × risk ×
 * budget per call. Idempotent via the active-grant unique index, and safe
 * to re-run on existing installs (additive seed upgrade).
 */
async function seedToolGrants(db: GuardedDb, ctx: CompanyContext): Promise<void> {
  const units = await db
    .select({ id: orgUnits.id })
    .from(orgUnits)
    .where(and(eq(orgUnits.companyId, ctx.companyId), inArray(orgUnits.slug, SEED_GRANT_UNIT_SLUGS)));
  for (const unit of units) {
    for (const toolName of SEED_GRANT_TOOLS) {
      await db
        .insert(toolPermissions)
        .values({
          companyId: ctx.companyId,
          toolName,
          subjectKind: "org_unit",
          subjectId: unit.id,
        })
        .onConflictDoNothing();
    }
  }
}
