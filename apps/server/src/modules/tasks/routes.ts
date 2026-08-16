// Tasks routes (T27) — 21 §3.7 under /api/v1/companies/:id/tasks. The HTTP
// principal is the Founder (agents transition via the internal service from
// workflows, T32+); role permission is enforced by TaskStateService either
// way — forbidden transitions surface as 409 task_transition_invalid.
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  ArchiveTaskRequestSchema,
  CreateAssignmentRequestSchema,
  CreateDependencyRequestSchema,
  CreateTaskRequestSchema,
  TaskAssignmentSchema,
  TaskDependenciesResponseSchema,
  TaskDependencySchema,
  TaskListQuerySchema,
  TaskSchema,
  TaskTransitionRequestSchema,
  TaskTreeNodeSchema,
  UpdateTaskRequestSchema,
  type TaskTreeNode,
} from "@acos/contracts";
import { companyContext, type CompanyContext } from "@acos/db";
import { formatTaskNumber } from "@acos/domain";
import { ApiError } from "../../app.js";
import type { CompanyService } from "../companies/service.js";
import { TaskEngineError, type TaskRow, type TasksService, type TaskStateService } from "./service.js";

const idParam = z.object({ id: z.uuid() });
const taskParam = idParam.extend({ taskId: z.uuid() });

export function toApiTask(t: TaskRow) {
  return {
    id: t.id,
    number: t.number,
    displayNumber: formatTaskNumber(t.number),
    kind: t.kind as never,
    parentId: t.parentId,
    projectId: t.projectId,
    title: t.title,
    objective: t.objective,
    priority: t.priority as never,
    status: t.status as never,
    successCriteria: t.successCriteria,
    risk: t.risk as never,
    budgetCents: t.budgetCents,
    spentCents: t.spentCents,
    deadline: t.deadline instanceof Date ? t.deadline.toISOString() : t.deadline,
    ownerAgentId: t.ownerAgentId,
    creatorAgentId: t.creatorAgentId,
    orgUnitId: t.orgUnitId,
    delegationDepth: t.delegationDepth,
    reassignmentCount: t.reassignmentCount,
    createdAt: t.createdAt instanceof Date ? t.createdAt.toISOString() : t.createdAt,
    closedAt: t.closedAt instanceof Date ? (t.closedAt?.toISOString() ?? null) : t.closedAt,
    archivedAt:
      t.archivedAt instanceof Date ? (t.archivedAt?.toISOString() ?? null) : (t.archivedAt ?? null),
  };
}

function mapTaskError(err: unknown): never {
  if (err instanceof TaskEngineError) {
    switch (err.code) {
      case "TASK_NOT_FOUND":
        throw new ApiError("not_found", err.message);
      case "TASK_TRANSITION_INVALID":
      case "TASK_REASSIGNMENT_LIMIT":
        throw new ApiError("task_transition_invalid", err.message);
      case "TASK_DEPENDENCY_CYCLE":
        throw new ApiError("dependency_cycle_detected", err.message);
      case "TASK_HIERARCHY_INVALID":
        throw new ApiError("validation_failed", err.message);
    }
  }
  throw err;
}

export async function registerTaskRoutes(
  rawApp: FastifyInstance,
  tasksSvc: () => TasksService,
  taskStateSvc: () => TaskStateService,
  companiesSvc: () => CompanyService,
  agentWorkflowStarter?: () => import("../workflows/client.js").AgentWorkflowStarter | null,
) {
  const app = rawApp.withTypeProvider<ZodTypeProvider>();

  async function requireCompany(request: FastifyRequest, companyId: string): Promise<CompanyContext> {
    const user = request.requireUser();
    const role = await companiesSvc().membership(user.id, companyId);
    if (!role) throw new ApiError("not_found", "company not found");
    return companyContext(companyId);
  }

  app.post(
    "/api/v1/companies/:id/tasks",
    {
      schema: {
        operationId: "createTask",
        tags: ["tasks"],
        params: idParam,
        body: CreateTaskRequestSchema,
        response: { 201: TaskSchema },
      },
    },
    async (request, reply) => {
      const ctx = await requireCompany(request, request.params.id);
      const task = await tasksSvc()
        .create(ctx, request.body, { kind: "founder" })
        .catch(mapTaskError);
      return reply.status(201).send(toApiTask(task));
    },
  );

  app.get(
    "/api/v1/companies/:id/tasks",
    {
      schema: {
        operationId: "listTasks",
        tags: ["tasks"],
        params: idParam,
        querystring: TaskListQuerySchema,
        response: { 200: z.array(TaskSchema) },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const { status, ...rest } = request.query;
      const rows = await tasksSvc().list(ctx, {
        ...rest,
        status: typeof status === "string" ? [status] : status,
      });
      // include varsayılanı serviste ("active") — rota katmanı karar vermez
      return rows.map(toApiTask);
    },
  );

  /**
   * Panodan kaldır / geri getir (07 §5.6).
   *
   * SİLME UCU DEĞİL ve bilerek öyle: silmek olay zincirini ve o görevden
   * doğan anıları sakat bırakırdı (INV-11 append-only). `archived=false` ile
   * her an geri gelir. Bir durum geçişi de değil — 16 durumluk makine
   * dokunulmaz; bu yüzden transitions ucundan ayrı duruyor.
   *
   * SADECE Founder: ajanlar kendi izlerini panodan silememeli.
   */
  app.post(
    "/api/v1/companies/:id/tasks/:taskId/archive",
    {
      schema: {
        operationId: "archiveTask",
        tags: ["tasks"],
        params: taskParam,
        body: ArchiveTaskRequestSchema,
        response: { 200: TaskSchema },
      },
    },
    async (request) => {
      const user = request.requireUser();
      const role = await companiesSvc().membership(user.id, request.params.id);
      if (!role) throw new ApiError("not_found", "company not found");
      if (role !== "founder") {
        throw new ApiError("forbidden", "panoyu yalnız Founder düzenler");
      }
      const ctx = companyContext(request.params.id);
      const row = await tasksSvc().setArchived(ctx, request.params.taskId, request.body.archived);
      if (!row) throw new ApiError("not_found", "task not found");
      return toApiTask(row);
    },
  );

  // DAG data source (24 §6.3) — all dependency edges of the company. Static
  // segment, so it wins over /tasks/:taskId.
  app.get(
    "/api/v1/companies/:id/tasks/dag",
    {
      schema: {
        operationId: "getTaskDag",
        tags: ["tasks"],
        params: idParam,
        response: { 200: z.object({ edges: z.array(TaskDependencySchema) }) },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const rows = await tasksSvc().listAllDependencies(ctx);
      return {
        edges: rows.map((d) => ({
          id: d.id,
          taskId: d.taskId,
          dependsOnTaskId: d.dependsOnTaskId,
          resolvedAt: d.resolvedAt?.toISOString() ?? null,
        })),
      };
    },
  );

  app.get(
    "/api/v1/companies/:id/tasks/:taskId",
    {
      schema: {
        operationId: "getTask",
        tags: ["tasks"],
        params: taskParam,
        response: { 200: TaskSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const task = await tasksSvc().get(ctx, request.params.taskId);
      if (!task) throw new ApiError("not_found", "task not found");
      return toApiTask(task);
    },
  );

  app.patch(
    "/api/v1/companies/:id/tasks/:taskId",
    {
      schema: {
        operationId: "updateTask",
        tags: ["tasks"],
        params: taskParam,
        body: UpdateTaskRequestSchema,
        response: { 200: TaskSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const task = await tasksSvc().update(ctx, request.params.taskId, request.body);
      if (!task) throw new ApiError("not_found", "task not found");
      return toApiTask(task);
    },
  );

  app.post(
    "/api/v1/companies/:id/tasks/:taskId/transitions",
    {
      schema: {
        operationId: "transitionTask",
        tags: ["tasks"],
        params: taskParam,
        body: TaskTransitionRequestSchema,
        response: { 200: TaskSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const task = await taskStateSvc()
        .transition(ctx, request.params.taskId, request.body.to, { kind: "founder" }, {
          note: request.body.reason,
        })
        .catch(mapTaskError);
      return toApiTask(task);
    },
  );

  app.get(
    "/api/v1/companies/:id/tasks/:taskId/tree",
    {
      schema: {
        operationId: "getTaskTree",
        tags: ["tasks"],
        params: taskParam,
        response: { 200: z.object({ root: TaskTreeNodeSchema }) },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const rows = await tasksSvc().subtree(ctx, request.params.taskId);
      if (rows.length === 0) throw new ApiError("not_found", "task not found");
      const nodes = new Map<string, TaskTreeNode>();
      for (const row of rows) {
        nodes.set(row.id, { ...toApiTask(row), children: [] } as TaskTreeNode);
      }
      let root: TaskTreeNode | null = null;
      for (const node of nodes.values()) {
        if (node.id === request.params.taskId) root = node;
        else if (node.parentId && nodes.has(node.parentId)) {
          nodes.get(node.parentId)!.children.push(node);
        }
      }
      return { root: root! };
    },
  );

  app.get(
    "/api/v1/companies/:id/tasks/:taskId/dependencies",
    {
      schema: {
        operationId: "listTaskDependencies",
        tags: ["tasks"],
        params: taskParam,
        response: { 200: TaskDependenciesResponseSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const { blockedBy, blocks } = await tasksSvc().dependencies(ctx, request.params.taskId);
      const map = (rows: typeof blockedBy) =>
        rows.map((d) => ({
          id: d.id,
          taskId: d.taskId,
          dependsOnTaskId: d.dependsOnTaskId,
          resolvedAt: d.resolvedAt?.toISOString() ?? null,
        }));
      return { blockedBy: map(blockedBy), blocks: map(blocks) };
    },
  );

  app.post(
    "/api/v1/companies/:id/tasks/:taskId/dependencies",
    {
      schema: {
        operationId: "addTaskDependency",
        tags: ["tasks"],
        params: taskParam,
        body: CreateDependencyRequestSchema,
        response: { 201: TaskDependencySchema },
      },
    },
    async (request, reply) => {
      const ctx = await requireCompany(request, request.params.id);
      const edge = await tasksSvc()
        .addDependency(ctx, request.params.taskId, request.body.dependsOnTaskId)
        .catch(mapTaskError);
      return reply.status(201).send({
        id: edge.id,
        taskId: edge.taskId,
        dependsOnTaskId: edge.dependsOnTaskId,
        resolvedAt: null,
      });
    },
  );

  app.delete(
    "/api/v1/companies/:id/tasks/:taskId/dependencies/:depId",
    {
      schema: {
        operationId: "removeTaskDependency",
        tags: ["tasks"],
        params: taskParam.extend({ depId: z.uuid() }),
        response: { 204: z.null() },
      },
    },
    async (request, reply) => {
      const ctx = await requireCompany(request, request.params.id);
      const removed = await tasksSvc().removeDependency(
        ctx,
        request.params.taskId,
        request.params.depId,
      );
      if (!removed) throw new ApiError("not_found", "active dependency not found");
      return reply.status(204).send(null);
    },
  );

  app.get(
    "/api/v1/companies/:id/tasks/:taskId/assignments",
    {
      schema: {
        operationId: "listTaskAssignments",
        tags: ["tasks"],
        params: taskParam,
        response: { 200: z.array(TaskAssignmentSchema) },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const rows = await tasksSvc().listAssignments(ctx, request.params.taskId);
      return rows.map((a) => ({
        id: a.id,
        taskId: a.taskId,
        agentId: a.agentId,
        role: a.role as never,
        assignedByAgentId: a.assignedByAgentId,
        reason: a.reason,
        assignedAt: a.assignedAt.toISOString(),
        unassignedAt: a.unassignedAt?.toISOString() ?? null,
      }));
    },
  );

  app.post(
    "/api/v1/companies/:id/tasks/:taskId/assignments",
    {
      schema: {
        operationId: "assignTask",
        tags: ["tasks"],
        params: taskParam,
        body: CreateAssignmentRequestSchema,
        response: { 200: TaskSchema },
      },
    },
    async (request) => {
      const ctx = await requireCompany(request, request.params.id);
      const task = await taskStateSvc()
        .assign(ctx, request.params.taskId, request.body, { kind: "founder" })
        .catch(mapTaskError);
      // assignment triggers the owner's agentTaskWorkflow (09 §4, T36) —
      // post-commit, best-effort; the DB assignment stays authoritative
      const starter = agentWorkflowStarter?.();
      if (starter && task.status === "ASSIGNED" && task.ownerAgentId) {
        await starter({ companyId: ctx.companyId, taskId: task.id, agentId: task.ownerAgentId });
      }
      return toApiTask(task);
    },
  );
}
