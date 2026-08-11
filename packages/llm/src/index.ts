export const packageName = "@acos/llm" as const;

export {
  LLM_PURPOSES,
  BINDING_PURPOSES,
  PURPOSE_TO_BINDING,
  LLM_ERROR_KINDS,
  FALLBACK_ELIGIBLE,
  LlmError,
  LlmMessageSchema,
  LlmUsageSchema,
  ProviderPricingSchema,
  computeCostCents,
  type LlmPurpose,
  type BindingPurpose,
  type LlmMessage,
  type LlmUsage,
  type CompleteRequest,
  type CompleteResult,
  type EmbedRequest,
  type EmbedResult,
  type LlmErrorKind,
  type AgentBindingInput,
  type ModelProfileInput,
  type ResolvedTarget,
  type ProviderPricing,
  type LlmCallLogEntry,
  type LlmCallLogger,
} from "./types.js";
export {
  AgentActionSchema,
  TaskResultSchema,
  AGENT_ACTION_TYPES,
  type AgentAction,
  type AgentActionType,
  type TaskResult,
} from "./agent-action.js";
export { resolveTargets } from "./resolution.js";
export { ModelRouter, type ProviderAdapter, type RouterOptions, type RoutingContext } from "./router.js";
export {
  createAnthropicAdapter,
  createOpenAiAdapter,
  createOpenAiCompatAdapter,
  createOpenRouterAdapter,
  createOllamaAdapter,
} from "./adapters/ai-sdk.js";
export { createProvidersFromConfig } from "./providers.js";
