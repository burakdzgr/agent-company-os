// Fastify 5 modular monolith skeleton (28 §2, 21 §2): zod type provider,
// problem+json error envelope, OpenAPI 3.1 via @fastify/swagger, one plugin
// per domain module. buildApp does NO IO — boot wiring lives in main.ts.
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import swagger from "@fastify/swagger";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { problemFor, type ErrorCode } from "@acos/contracts";
import type { Db, GuardedDb } from "@acos/db";
import { registerHealthRoutes, type HealthCheckers } from "./modules/health/index.js";
import { moduleStubs } from "./modules/index.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { AuthService, CSRF_COOKIE, SESSION_COOKIE, type UserRow } from "./modules/auth/service.js";
import { registerCompanyRoutes } from "./modules/companies/routes.js";
import { CompanyService } from "./modules/companies/service.js";
import { registerOrgRoutes } from "./modules/org/routes.js";
import { OrgService } from "./modules/org/service.js";
import { registerAgentRoutes } from "./modules/agents/routes.js";
import { AgentsService } from "./modules/agents/service.js";

declare module "fastify" {
  interface FastifyRequest {
    principal: { kind: "user"; user: UserRow; scopes: string[] | null } | null;
    requireUser(): UserRow;
  }
}

/** Domain errors carrying a stable API error code (21 §2.5). */
export class ApiError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface BuildAppOptions {
  healthCheckers: HealthCheckers;
  version?: string;
  logger?: boolean;
  /** Absent only for OpenAPI generation — handlers throw if hit without it. */
  db?: Db;
  guardedDb?: GuardedDb;
  masterKey?: string;
}

export type App = FastifyInstance;

export async function buildApp(options: BuildAppOptions): Promise<App> {
  const app = Fastify({
    logger: options.logger ?? true,
    requestIdHeader: "x-request-id",
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);

  // ---------- principal resolution + CSRF (18 §2, 21 §2.2) ----------
  let authService: AuthService | null = null;
  const auth = (): AuthService => {
    if (!authService) {
      if (!options.db || !options.masterKey) throw new ApiError("internal", "auth not wired");
      authService = new AuthService(options.db, options.masterKey);
    }
    return authService;
  };

  app.decorateRequest("principal", null);
  app.decorateRequest("requireUser", function (this: { principal: { user: UserRow } | null }) {
    if (!this.principal) throw new ApiError("unauthenticated", "authentication required");
    return this.principal.user;
  });

  app.addHook("preHandler", async (request) => {
    const bearer = request.headers.authorization;
    if (bearer?.startsWith("Bearer acos_pat_")) {
      const verified = await auth().verifyPat(bearer.slice("Bearer ".length));
      if (verified) request.principal = { kind: "user", user: verified.user, scopes: verified.scopes };
      return;
    }
    const sessionToken = request.cookies?.[SESSION_COOKIE];
    if (sessionToken) {
      const user = await auth().verifySession(sessionToken);
      if (user) {
        request.principal = { kind: "user", user, scopes: null };
        // CSRF double-submit for cookie-session mutations (18 §2). Auth
        // bootstrap routes (login/setup/logout) are exempt by design.
        const mutating = !["GET", "HEAD", "OPTIONS"].includes(request.method);
        const exempt = ["/api/v1/auth/login", "/api/v1/auth/setup", "/api/v1/auth/logout"];
        if (mutating && !exempt.includes(request.url.split("?")[0]!)) {
          const cookieToken = request.cookies?.[CSRF_COOKIE];
          const headerToken = request.headers["x-csrf-token"];
          if (!cookieToken || headerToken !== cookieToken) {
            throw new ApiError("forbidden", "missing or mismatched CSRF token");
          }
        }
      }
    }
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: {
        title: "ACOS API",
        description: "AI Agent Company OS control-plane API (21-API-DESIGN.md)",
        version: options.version ?? "0.0.0",
      },
      servers: [{ url: "/" }],
    },
    transform: jsonSchemaTransform,
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ApiError) {
      const problem = problemFor(error.code, error.message, {
        instance: request.url,
        requestId: request.id,
      });
      return reply.status(problem.status).type("application/problem+json").send(problem);
    }
    if (error.validation) {
      const problem = problemFor("validation_failed", "request validation failed", {
        instance: request.url,
        requestId: request.id,
        errors: error.validation.map((issue) => ({
          path: String(issue.instancePath || issue.params?.missingProperty || ""),
          message: issue.message ?? "invalid",
        })),
      });
      return reply.status(400).type("application/problem+json").send(problem);
    }
    request.log.error(error);
    const problem = problemFor("internal", "unexpected server error", {
      instance: request.url,
      requestId: request.id,
    });
    return reply.status(500).type("application/problem+json").send(problem);
  });

  app.setNotFoundHandler((request, reply) => {
    const problem = problemFor("not_found", `route ${request.method} ${request.url} not found`, {
      instance: request.url,
      requestId: request.id,
    });
    return reply.status(404).type("application/problem+json").send(problem);
  });

  // Container healthcheck (compose) — trivial liveness.
  app.get("/healthz", () => ({ status: "ok", service: "server" }));

  let companyService: CompanyService | null = null;
  const companiesSvc = (): CompanyService => {
    if (!companyService) {
      if (!options.guardedDb) throw new ApiError("internal", "companies not wired");
      companyService = new CompanyService(options.guardedDb);
    }
    return companyService;
  };

  await registerHealthRoutes(app, options.healthCheckers, options.version ?? "0.0.0");
  await registerAuthRoutes(app, auth);
  let orgService: OrgService | null = null;
  const orgSvc = (): OrgService => {
    if (!orgService) {
      if (!options.guardedDb) throw new ApiError("internal", "org not wired");
      orgService = new OrgService(options.guardedDb);
    }
    return orgService;
  };

  await registerCompanyRoutes(app, companiesSvc);
  let agentsService: AgentsService | null = null;
  const agentsSvc = (): AgentsService => {
    if (!agentsService) {
      if (!options.guardedDb) throw new ApiError("internal", "agents not wired");
      agentsService = new AgentsService(options.guardedDb, orgSvc());
    }
    return agentsService;
  };

  await registerOrgRoutes(app, orgSvc, companiesSvc);
  await registerAgentRoutes(app, agentsSvc, companiesSvc);

  // Domain modules (28 §2) — stubs now; routes land with T16+.
  for (const [name, plugin] of Object.entries(moduleStubs)) {
    await app.register(plugin, { prefix: `/api/v1`, name });
  }

  return app;
}
