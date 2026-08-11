// Seed v1 (27 §4, T17): idempotent (keyed on company slug) — creates the
// Founder user and "Acme Technologies" with default settings. Org, positions
// and the 8 agents extend this in T18/T19.
import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { GuardedDb } from "@acos/db";
import { companies, users } from "@acos/db/schema";
import { hashPassword } from "./modules/auth/crypto.js";
import { CompanyService } from "./modules/companies/service.js";

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
    return { created: false, companyId: existingCompany.id, founderUserId: existingUser.id };
  }

  let founderUserId = existingUser?.id;
  let founderPassword: string | undefined;
  if (!founderUserId) {
    founderPassword = randomBytes(12).toString("base64url");
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

  return {
    created: true,
    companyId,
    founderUserId,
    ...(founderPassword !== undefined && { founderPassword }),
  };
}
