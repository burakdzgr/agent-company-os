// Projects REST surface (T42; 14 §2, 21 §3): create (greenfield or git-URL
// import — the 3-field Founder contract, P4), list, detail, intake report.
// Creation starts projectIntakeWorkflow post-commit (best-effort port; the
// project row is durable either way and the Founder can re-import).
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import {
  ArtifactDtoSchema,
  CreateProjectRequestSchema,
  ProjectDtoSchema,
  ProjectListResponseSchema,
} from "@acos/contracts";
import {
  companyContext,
  ProjectError,
  ProjectsService,
  type CompanyContext,
  type GuardedDb,
  type ProjectRow,
} from "@acos/db";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";

export type IntakeStarter = (input: {
  companyId: string;
  projectId: string;
  source: { kind: "git_url"; url: string } | { kind: "empty" };
}) => Promise<void>;

export interface ProjectRoutesDeps {
  guardedDb: () => GuardedDb;
  companiesSvc: () => CompanyService;
  intakeStarter: () => IntakeStarter | null;
}

const ParamsSchema = z.object({ companyId: z.uuid() });
const ProjectParamsSchema = z.object({ companyId: z.uuid(), projectId: z.uuid() });

export async function registerProjectRoutes(
  app: FastifyInstance,
  deps: ProjectRoutesDeps,
): Promise<void> {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const service = () => new ProjectsService(deps.guardedDb());

  async function requireMember(userId: string, companyId: string): Promise<void> {
    const role = await deps.companiesSvc().membership(userId, companyId);
    if (!role) throw new ApiError("not_found", "company not found");
  }

  async function toDto(ctx: CompanyContext, row: ProjectRow) {
    const repo = await service().repository(ctx, row.id);
    return ProjectDtoSchema.parse({
      id: row.id,
      slug: row.slug,
      name: row.name,
      objective: row.objectiveMd,
      constraints: row.constraintsMd,
      status: row.status,
      intakeReportArtifactId: row.intakeReportArtifactId,
      createdAt: row.createdAt.toISOString(),
      kind: repo?.originUrl ? "imported" : "greenfield",
      repository: repo
        ? {
            barePath: repo.barePath,
            defaultBranch: repo.defaultBranch,
            originUrl: repo.originUrl,
          }
        : null,
    });
  }

  typed.get(
    "/api/v1/companies/:companyId/projects",
    {
      schema: {
        params: ParamsSchema,
        response: { 200: ProjectListResponseSchema },
        tags: ["projects"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId } = request.params;
      await requireMember(user.id, companyId);
      const ctx = companyContext(companyId);
      const rows = await service().list(ctx);
      return { items: await Promise.all(rows.map((r) => toDto(ctx, r))) };
    },
  );

  typed.post(
    "/api/v1/companies/:companyId/projects",
    {
      schema: {
        params: ParamsSchema,
        body: CreateProjectRequestSchema,
        response: { 201: ProjectDtoSchema },
        tags: ["projects"],
      },
    },
    async (request, reply) => {
      const user = request.requireUser();
      const { companyId } = request.params;
      await requireMember(user.id, companyId);
      const ctx = companyContext(companyId);
      let row: ProjectRow;
      try {
        row = await service().create(ctx, {
          name: request.body.name,
          objective: request.body.objective,
          constraints: request.body.constraints,
          createdByUserId: user.id,
        });
      } catch (err) {
        if (err instanceof ProjectError && err.code === "PROJECT_SLUG_TAKEN") {
          throw new ApiError("conflict", err.message);
        }
        throw err;
      }
      // post-commit: intake workflow (14 §2) — durable rows stay either way
      const starter = deps.intakeStarter();
      if (starter) {
        await starter({
          companyId,
          projectId: row.id,
          source: request.body.source ?? { kind: "empty" },
        }).catch((err) => request.log.warn({ err }, "projectIntakeWorkflow start failed"));
      }
      return reply.status(201).send(await toDto(ctx, row));
    },
  );

  typed.get(
    "/api/v1/companies/:companyId/projects/:projectId",
    {
      schema: {
        params: ProjectParamsSchema,
        response: { 200: ProjectDtoSchema },
        tags: ["projects"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, projectId } = request.params;
      await requireMember(user.id, companyId);
      const ctx = companyContext(companyId);
      try {
        return await toDto(ctx, await service().get(ctx, projectId));
      } catch (err) {
        if (err instanceof ProjectError && err.code === "PROJECT_NOT_FOUND") {
          throw new ApiError("not_found", err.message);
        }
        throw err;
      }
    },
  );

  typed.get(
    "/api/v1/companies/:companyId/projects/:projectId/report",
    {
      schema: {
        params: ProjectParamsSchema,
        response: { 200: ArtifactDtoSchema },
        tags: ["projects"],
      },
    },
    async (request) => {
      const user = request.requireUser();
      const { companyId, projectId } = request.params;
      await requireMember(user.id, companyId);
      const ctx = companyContext(companyId);
      const project = await service()
        .get(ctx, projectId)
        .catch(() => {
          throw new ApiError("not_found", "project not found");
        });
      if (!project.intakeReportArtifactId) {
        throw new ApiError("not_found", "no intake report for this project");
      }
      const artifact = await service().artifact(ctx, project.intakeReportArtifactId);
      return ArtifactDtoSchema.parse({
        id: artifact.id,
        kind: artifact.kind,
        title: artifact.title,
        contentMd: artifact.contentMd,
        createdAt: artifact.createdAt.toISOString(),
        meta: artifact.meta,
      });
    },
  );
}
