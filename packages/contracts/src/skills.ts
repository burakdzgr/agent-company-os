// Skills API (T47; 13 §10): the agents × skills matrix for the Skills view.
import { z } from "zod";

export const SkillMatrixRowSchema = z.object({
  agentId: z.uuid(),
  agentName: z.string(),
  skillId: z.uuid(),
  skillName: z.string(),
  category: z.string(),
  level: z.number().int().min(1).max(5),
  confidence: z.number().min(0).max(1),
  evidenceCount: z.number().int().min(0),
  lastUsedAt: z.iso.datetime().nullable(),
});
export type SkillMatrixRow = z.infer<typeof SkillMatrixRowSchema>;

export const SkillMatrixResponseSchema = z.object({ items: z.array(SkillMatrixRowSchema) });
export type SkillMatrixResponse = z.infer<typeof SkillMatrixResponseSchema>;

export const SkillEvidenceDtoSchema = z.object({
  id: z.uuid(),
  kind: z.string(),
  weight: z.number(),
  ref: z.string(),
  note: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type SkillEvidenceDto = z.infer<typeof SkillEvidenceDtoSchema>;

export const SkillEvidenceResponseSchema = z.object({ items: z.array(SkillEvidenceDtoSchema) });
export type SkillEvidenceResponse = z.infer<typeof SkillEvidenceResponseSchema>;
