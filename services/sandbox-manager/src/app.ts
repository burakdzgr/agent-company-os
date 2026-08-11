// sandbox-manager HTTP surface (28 §2, T37). Internal-only: every route
// behind the shared INTERNAL_API_TOKEN bearer (18 §2) — there is no session
// or PAT path into the Docker-socket owner. Buffered exec returns the result
// inline; a streaming exec (sessionId present) acks immediately and frames
// flow over NATS `term.<sessionId>`.
import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import {
  CreateWorkspaceRequestSchema,
  EnsureRepoRequestSchema,
  ExecRequestSchema,
  ProvisionWorktreeRequestSchema,
  WORKTREE_VOLUME_PATTERN,
  type ExecResult,
} from "@acos/contracts";
import type { DockerSandbox } from "./docker.js";
import type { GitWorkspaces } from "./git.js";

export interface AppDeps {
  sandbox: DockerSandbox;
  git: GitWorkspaces;
  internalApiToken: string;
  logger?: boolean;
}

function bearerOk(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({ logger: deps.logger ?? true });

  // container liveness (compose healthcheck) — no auth, no Docker call
  app.get("/healthz", () => ({ status: "ok", service: "sandbox-manager" }));

  // everything else requires the internal bearer (S2/S3 boundary)
  app.addHook("preHandler", async (request, reply) => {
    if (request.url === "/healthz") return;
    if (!bearerOk(request.headers.authorization, deps.internalApiToken)) {
      return reply.status(401).send({ code: "unauthenticated", message: "internal token required" });
    }
  });

  app.post("/internal/v1/workspaces", async (request, reply) => {
    const parsed = CreateWorkspaceRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
    }
    const workspace = await deps.sandbox.createWorkspace(parsed.data);
    return reply.status(201).send(workspace);
  });

  app.get("/internal/v1/workspaces", async () => {
    return deps.sandbox.list();
  });

  app.post<{ Params: { workspaceId: string } }>(
    "/internal/v1/workspaces/:workspaceId/exec",
    async (request, reply) => {
      const parsed = ExecRequestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
      }
      const { workspaceId } = request.params;
      if (parsed.data.sessionId) {
        // streaming: ack now, frames flow over NATS; the exec runs in the
        // background and its terminal session carries the output
        const session = deps.sandbox.newTerminalSession(parsed.data.sessionId);
        void deps.sandbox
          .exec(workspaceId, parsed.data, session)
          .catch((err) => app.log.error({ err, workspaceId }, "streaming exec failed"));
        return reply.status(202).send({ sessionId: parsed.data.sessionId, streaming: true });
      }
      const result: ExecResult = await deps.sandbox.exec(workspaceId, parsed.data);
      return reply.status(200).send(result);
    },
  );

  app.delete<{ Params: { workspaceId: string } }>(
    "/internal/v1/workspaces/:workspaceId",
    async (request, reply) => {
      await deps.sandbox.destroyWorkspace(request.params.workspaceId);
      return reply.status(204).send();
    },
  );

  // --- Git model (T38): bare repos + per-task worktree volumes ---

  app.post("/internal/v1/repos", async (request, reply) => {
    const parsed = EnsureRepoRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
    }
    const result = await deps.git.ensureBareRepo(parsed.data.projectId);
    return reply.status(result.created ? 201 : 200).send(result);
  });

  app.post("/internal/v1/worktrees", async (request, reply) => {
    const parsed = ProvisionWorktreeRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ code: "validation_failed", issues: parsed.error.issues });
    }
    const result = await deps.git.provisionWorktree(parsed.data);
    return reply.status(result.created ? 201 : 200).send(result);
  });

  app.delete<{ Params: { volumeName: string } }>(
    "/internal/v1/worktrees/:volumeName",
    async (request, reply) => {
      if (!WORKTREE_VOLUME_PATTERN.test(request.params.volumeName)) {
        return reply.status(400).send({ code: "validation_failed", message: "bad volume name" });
      }
      await deps.git.removeWorktree(request.params.volumeName);
      return reply.status(204).send();
    },
  );

  app.setErrorHandler((error: Error & { code?: string }, request, reply) => {
    if (error.code === "NOT_FOUND" || error.code === "REPO_NOT_FOUND") {
      return reply.status(404).send({ code: "not_found", message: error.message });
    }
    if (error.code === "INVALID_INPUT") {
      return reply.status(400).send({ code: "validation_failed", message: error.message });
    }
    request.log.error(error);
    return reply.status(500).send({ code: "internal", message: error.message });
  });

  return app;
}
