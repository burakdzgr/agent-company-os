// Internal tool-invoke surface (17 §1, T39): workers reach the gateway over
// internal HTTP with the shared INTERNAL_API_TOKEN bearer — transport auth
// only; the acting agent identity travels in the body and is re-verified
// against the DB by the gateway. No session/PAT path exists here, the route
// is hidden from OpenAPI, and the reverse proxy never exposes /internal/*.
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { companyContext } from "@acos/db";
import type { ToolGateway } from "./gateway.js";

export const ToolInvokeBodySchema = z.object({
  companyId: z.uuid(),
  agentId: z.uuid(),
  toolName: z.string().min(1).max(128),
  input: z.unknown(),
  taskId: z.uuid().optional(),
  agentSessionId: z.uuid().optional(),
  workspaceId: z.uuid().optional(),
  tainted: z.boolean().optional(),
  scopeRelation: z.enum(["own_team", "own_department", "company", "external"]).optional(),
  idempotencyKey: z.string().min(8).max(200).optional(),
});

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
