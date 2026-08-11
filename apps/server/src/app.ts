// Fastify 5 modular monolith skeleton (28 §2, 21 §2): zod type provider,
// problem+json error envelope, OpenAPI 3.1 via @fastify/swagger, one plugin
// per domain module. buildApp does NO IO — boot wiring lives in main.ts.
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { problemFor, type ErrorCode } from "@acos/contracts";
import { registerHealthRoutes, type HealthCheckers } from "./modules/health/index.js";
import { moduleStubs } from "./modules/index.js";

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
}

export type App = FastifyInstance;

export async function buildApp(options: BuildAppOptions): Promise<App> {
  const app = Fastify({
    logger: options.logger ?? true,
    requestIdHeader: "x-request-id",
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

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

  await registerHealthRoutes(app, options.healthCheckers, options.version ?? "0.0.0");

  // Domain modules (28 §2) — stubs now; routes land with T16+.
  for (const [name, plugin] of Object.entries(moduleStubs)) {
    await app.register(plugin, { prefix: `/api/v1`, name });
  }

  return app;
}
