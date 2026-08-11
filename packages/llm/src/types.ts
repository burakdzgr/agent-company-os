// The ModelRouter port types (ADR-015): OUR shapes, vendor-neutral. No AI SDK
// type crosses this boundary — adapters translate into these and nothing else.
import { z } from "zod";

export const LLM_PURPOSES = ["reasoning", "coding", "fast", "embedding", "vision"] as const;
export type LlmPurpose = (typeof LLM_PURPOSES)[number];

export const BINDING_PURPOSES = ["primary", "fast", "embedding"] as const;
export type BindingPurpose = (typeof BINDING_PURPOSES)[number];

/** Profile purposes collapse onto binding purposes (_DECISIONS §17, T19). */
export const PURPOSE_TO_BINDING: Record<LlmPurpose, BindingPurpose> = {
  reasoning: "primary",
  coding: "primary",
  vision: "primary",
  fast: "fast",
  embedding: "embedding",
};

export const LlmMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});
export type LlmMessage = z.infer<typeof LlmMessageSchema>;

export interface CompleteRequest {
  purpose: LlmPurpose;
  messages: LlmMessage[];
  maxTokens?: number | undefined;
  temperature?: number | undefined;
  /** accounting refs — flow into the llm_calls log entry verbatim */
  agentId?: string | undefined;
  taskId?: string | undefined;
  sessionId?: string | undefined;
}

export const LlmUsageSchema = z.object({
  inputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0).default(0),
});
export type LlmUsage = z.infer<typeof LlmUsageSchema>;

export interface CompleteResult {
  text: string;
  usage: LlmUsage;
  providerId: string;
  model: string;
  latencyMs: number;
  costCents: number;
  finishReason: "stop" | "length" | "content_filter" | "other";
}

export interface EmbedRequest {
  purpose?: "embedding" | undefined;
  text: string;
  agentId?: string | undefined;
  taskId?: string | undefined;
}

export interface EmbedResult {
  embedding: number[];
  dimension: number;
  usage: LlmUsage;
  providerId: string;
  model: string;
  latencyMs: number;
  costCents: number;
}

export const LLM_ERROR_KINDS = [
  "rate_limited", // 429 — fallback-eligible
  "provider_unavailable", // 5xx / network — fallback-eligible
  "auth", // 401/403 — configuration problem, no fallback masking
  "bad_request", // 4xx — our fault, never fall back
  "no_target", // resolution produced no usable provider+model
] as const;
export type LlmErrorKind = (typeof LLM_ERROR_KINDS)[number];

export class LlmError extends Error {
  constructor(
    public readonly kind: LlmErrorKind,
    message: string,
    public readonly providerId?: string,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export const FALLBACK_ELIGIBLE: ReadonlySet<LlmErrorKind> = new Set([
  "rate_limited",
  "provider_unavailable",
]);

// ---------- resolution inputs (data rows, repository-free) ----------

export interface AgentBindingInput {
  purpose: BindingPurpose;
  providerId: string;
  model: string;
  params?: Record<string, unknown> | undefined;
  priority?: number | undefined;
}

export interface ModelProfileInput {
  purpose: LlmPurpose;
  providerId: string;
  model: string;
  params?: Record<string, unknown> | undefined;
  priority?: number | undefined;
  enabled?: boolean | undefined;
  maxTokensPerCall?: number | null | undefined;
  costCapCentsPerCall?: number | null | undefined;
}

export interface ResolvedTarget {
  providerId: string;
  model: string;
  params: Record<string, unknown>;
  maxTokensPerCall: number | null;
  costCapCentsPerCall: number | null;
  source: "binding" | "profile";
}

// ---------- pricing (model_providers.pricing JSONB, 26 §3.1) ----------

export const ProviderPricingSchema = z.object({
  inputPerMTokCents: z.number().min(0).default(0),
  outputPerMTokCents: z.number().min(0).default(0),
  cachedInputPerMTokCents: z.number().min(0).default(0),
});
export type ProviderPricing = z.infer<typeof ProviderPricingSchema>;

export function computeCostCents(usage: LlmUsage, pricing: ProviderPricing | null): number {
  if (!pricing) return 0;
  const freshInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cents =
    (freshInput * pricing.inputPerMTokCents +
      usage.cachedInputTokens * pricing.cachedInputPerMTokCents +
      usage.outputTokens * pricing.outputPerMTokCents) /
    1_000_000;
  return Math.ceil(cents);
}

// ---------- llm_calls accounting hook (written by the app, ADR-015) ----------

export interface LlmCallLogEntry {
  providerId: string;
  model: string;
  purpose: LlmPurpose;
  status: "ok" | "error";
  errorKind?: LlmErrorKind | undefined;
  usage: LlmUsage;
  costCents: number;
  latencyMs: number;
  agentId?: string | undefined;
  taskId?: string | undefined;
  sessionId?: string | undefined;
}

export type LlmCallLogger = (entry: LlmCallLogEntry) => void | Promise<void>;
