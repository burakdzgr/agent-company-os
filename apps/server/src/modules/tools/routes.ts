// Internal tool-invoke surface (17 §1, T39): workers reach the gateway over
// internal HTTP with the shared INTERNAL_API_TOKEN bearer — transport auth
// only; the acting agent identity travels in the body and is re-verified
// against the DB by the gateway. No session/PAT path exists here, the route
// is hidden from OpenAPI, and the reverse proxy never exposes /internal/*.
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  GrantToolPermissionRequestSchema,
  ToolDefinitionSchema,
  ToolInvokeWireRequestSchema,
  ToolPermissionItemSchema,
} from "@acos/contracts";
import { and, companyContext, eq, isNull, type GuardedDb } from "@acos/db";
import { agents, orgUnits, positions, toolPermissions } from "@acos/db/schema";
import { listTools } from "@acos/tools";
import type { ToolGateway } from "./gateway.js";

/** The wire schema lives in @acos/contracts (shared with worker clients). */
export const ToolInvokeBodySchema = ToolInvokeWireRequestSchema;

function bearerOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function registerToolGatewayRoutes(
  app: FastifyInstance,
  deps: { gateway: () => ToolGateway; internalApiToken: () => string },
): void {
  app.post(
    "/internal/v1/tools/invoke",
    { schema: { hide: true } },
    async (request, reply) => {
      if (!bearerOk(request.headers.authorization, deps.internalApiToken())) {
        return reply
          .status(401)
          .send({ code: "unauthenticated", message: "internal token required" });
      }
      const parsed = ToolInvokeBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply
          .status(400)
          .send({ code: "validation_failed", issues: parsed.error.issues });
      }
      const { companyId, ...invoke } = parsed.data;
      const response = await deps
        .gateway()
        .invoke(companyContext(companyId), { ...invoke, input: invoke.input ?? {} });
      return reply.status(200).send(response);
    },
  );
}

/**
 * Tool Management API — Founder/admin UI için permission CRUD + tool registry listeleme.
 */
export function registerToolManagementRoutes(
  app: FastifyInstance,
  deps: { db: GuardedDb },
): void {
  // GET /api/v1/tools — registry'deki tüm tool tanımlarını listele
  app.get("/api/v1/tools", async (_request, reply) => {
    const tools = listTools().map((t) => ({
      name: t.name,
      description: t.description,
      risk: t.risk,
      scopes: t.scopes,
      sideEffectFree: t.sideEffectFree,
    }));
    return reply.send(tools.map((t) => ToolDefinitionSchema.parse(t)));
  });

  // GET /api/v1/tools/permissions — şirketteki tüm aktif permission'ları listele (enriched)
  app.get("/api/v1/tools/permissions", async (request, reply) => {
    if (!request.principal || !request.companyId) {
      return reply.status(401).send({ code: "unauthenticated" });
    }
    const ctx = companyContext(request.companyId);

    const rows = await deps.db
      .select({
        id: toolPermissions.id,
        toolName: toolPermissions.toolName,
        subjectKind: toolPermissions.subjectKind,
        subjectId: toolPermissions.subjectId,
        constraints: toolPermissions.constraints,
        grantedByUserId: toolPermissions.grantedByUserId,
        grantedByAgentId: toolPermissions.grantedByAgentId,
        expiresAt: toolPermissions.expiresAt,
        revokedAt: toolPermissions.revokedAt,
        createdAt: toolPermissions.createdAt,
        // enrichment joins
        agentName: agents.name,
        unitSlug: orgUnits.slug,
        positionTitle: positions.title,
      })
      .from(toolPermissions)
      .leftJoin(agents, eq(toolPermissions.subjectId, agents.id))
      .leftJoin(orgUnits, eq(toolPermissions.subjectId, orgUnits.id))
      .leftJoin(positions, eq(toolPermissions.subjectId, positions.id))
      .where(
        and(
          eq(toolPermissions.companyId, ctx.companyId),
          isNull(toolPermissions.revokedAt),
        ),
      );

    const items = rows.map((r) => {
      let subjectLabel = r.subjectId;
      if (r.subjectKind === "agent" && r.agentName) subjectLabel = r.agentName;
      else if (r.subjectKind === "org_unit" && r.unitSlug) subjectLabel = r.unitSlug;
      else if (r.subjectKind === "position" && r.positionTitle) subjectLabel = r.positionTitle;

      return ToolPermissionItemSchema.parse({
        id: r.id,
        toolName: r.toolName,
        subjectKind: r.subjectKind,
        subjectId: r.subjectId,
        subjectLabel,
        constraints: r.constraints,
        grantedByUserId: r.grantedByUserId,
        grantedByAgentId: r.grantedByAgentId,
        expiresAt: r.expiresAt?.toISOString() ?? null,
        revokedAt: r.revokedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      });
    });

    return reply.send(items);
  });

  // POST /api/v1/tools/permissions — yeni grant oluştur
  app.post("/api/v1/tools/permissions", async (request, reply) => {
    if (!request.principal || !request.companyId) {
      return reply.status(401).send({ code: "unauthenticated" });
    }
    const ctx = companyContext(request.companyId);

    const parsed = GrantToolPermissionRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
    }

    const { toolName, subjectKind, subjectId, constraints, expiresAt } = parsed.data;

    const [created] = await deps.db
      .insert(toolPermissions)
      .values({
        companyId: ctx.companyId,
        toolName,
        subjectKind,
        subjectId,
        constraints: constraints ?? {},
        grantedByUserId: request.principal.kind === "user" ? request.principal.userId : null,
        grantedByAgentId: request.principal.kind === "agent" ? request.principal.agentId : null,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      })
      .returning();

    return reply.status(201).send({
      id: created!.id,
      toolName: created!.toolName,
      subjectKind: created!.subjectKind,
      subjectId: created!.subjectId,
      createdAt: created!.createdAt.toISOString(),
    });
  });

  // DELETE /api/v1/tools/permissions/:id — permission'ı revoke et (soft delete)
  app.delete("/api/v1/tools/permissions/:id", async (request, reply) => {
    if (!request.principal || !request.companyId) {
      return reply.status(401).send({ code: "unauthenticated" });
    }
    const ctx = companyContext(request.companyId);
    const { id } = request.params as { id: string };

    const [updated] = await deps.db
      .update(toolPermissions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(toolPermissions.id, id),
          eq(toolPermissions.companyId, ctx.companyId),
          isNull(toolPermissions.revokedAt),
        ),
      )
      .returning();

    if (!updated) {
      return reply.status(404).send({ code: "not_found", message: "Permission not found or already revoked" });
    }

    return reply.status(204).send();
  });
}
