// Agents module schemas (05, _DECISIONS §6). NOTE: no model/provider fields
// on the agent shape — bindings are a separate resource (sacred invariant).
import { z } from "zod";

export const AgentStatusSchema = z.enum(["draft", "active", "paused", "offboarded"]);
export const SenioritySchema = z.enum(["junior", "mid", "senior", "staff", "lead", "expert"]);
export const BindingPurposeSchema = z.enum(["primary", "fast", "embedding"]);

export const AgentSchema = z.object({
  id: z.uuid(),
  employeeNumber: z.number().int(),
  displayNumber: z.string(), // "EMP-007"
  name: z.string(),
  avatarUrl: z.string().nullable(),
  status: AgentStatusSchema,
  positionId: z.uuid(),
  orgUnitId: z.uuid(),
  seniority: SenioritySchema,
  autonomyLevel: z.number().int().min(0).max(5),
  persona: z.string(),
  createdAt: z.iso.datetime(),
});
export type Agent = z.infer<typeof AgentSchema>;

export const HireAgentRequestSchema = z.object({
  name: z.string().min(1),
  positionId: z.uuid(),
  orgUnitId: z.uuid(),
  seniority: SenioritySchema,
  autonomyLevel: z.number().int().min(0).max(5),
  persona: z.string().min(1),
  avatarUrl: z.string().nullable().optional(),
  managerAgentId: z.uuid().nullable().optional(),
  leadsUnit: z.boolean().optional(),
  activate: z.boolean().optional(),
  // U10 (36 §8) — additive hire params; single-transaction hire (T19) intact.
  /** PixelLab library pick — stored as agents.avatar_url = `pixel:avNN`. */
  avatarId: z.string().regex(/^av\d{2}$/).optional(),
  /** initial agent_skills seed via the T47 evidence writer */
  expertise: z.array(z.string().min(1).max(60)).max(12).optional(),
  /** project placement → project_members (T42) */
  projectId: z.uuid().optional(),
  /** explicit engine/model → agent_model_bindings (identity stays decoupled) */
  modelBinding: z
    .object({ provider: z.string().min(1), model: z.string().min(1) })
    .optional(),
});

export const UpdateAgentRequestSchema = z.object({
  persona: z.string().min(1).optional(),
  avatarUrl: z.string().nullable().optional(),
  autonomyLevel: z.number().int().min(0).max(5).optional(),
});

export const LifecycleActionRequestSchema = z.object({
  reason: z.string().optional(),
  topLevel: z.boolean().optional(),
});

export const ModelBindingSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  purpose: BindingPurposeSchema,
  providerId: z.uuid(),
  model: z.string(),
  priority: z.number().int(),
});
export type ModelBinding = z.infer<typeof ModelBindingSchema>;

export const SetModelBindingRequestSchema = z.object({
  purpose: BindingPurposeSchema,
  providerId: z.uuid(),
  model: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
  priority: z.number().int().min(0).optional(),
});

export const AgentSessionSchema = z.object({
  id: z.uuid(),
  agentId: z.uuid(),
  taskId: z.uuid().nullable(),
  workflowId: z.string(),
  status: z.enum(["starting", "running", "waiting", "completed", "failed", "cancelled"]),
  currentActivity: z.string(),
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(),
  stepsCount: z.number().int(),
  costCents: z.number().int(),
});
