// Skills REST surface (T47; 13 §10): the agents × skills matrix — real
// agent_skills rows, levels always from the deterministic recompute.
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { SkillMatrixResponseSchema, SkillMatrixRowSchema } from "@acos/contracts";
import { companyContext, SkillsService, type GuardedDb } from "@acos/db";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";

export interface SkillRoutesDeps {
  guardedDb: () => GuardedDb;
  companiesSvc: () => CompanyService;
}

const CompanyParamsSchema = z.object({ companyId: z.uuid() });

export async function registerSkillRoutes(
  app: FastifyInstance,
  deps: SkillRoutesDeps,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get(
    "/api/v1/companies/:companyId/skills/matrix",
    {
      schema: {
        params: CompanyParamsSchema,
        response: { 200: SkillMatrixResponseSchema },
        tags: ["skills"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId } = request.params;
      const role = await deps.companiesSvc().membership(user.id, companyId);
      if (!role) throw new ApiError("not_found", "company not found");
      const rows = await new SkillsService(deps.guardedDb()).matrix(companyContext(companyId));
      return {
        items: rows.map((row) =>
          SkillMatrixRowSchema.parse({
            ...row,
            lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
          }),
        ),
      };
    },
  );
}
