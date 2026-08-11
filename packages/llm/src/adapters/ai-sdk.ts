// Provider adapters (ADR-015): Vercel AI SDK v5 lives STRICTLY inside this
// file (plus the eslint boundary that enforces it). Adapters translate the
// port shapes; they never choose models, never retry, and never let an AI SDK
// type or error escape — everything surfaces as port types / LlmError.
import { APICallError, embed as aiEmbed, generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { ProviderAdapter } from "../router.js";
import { LlmError, type LlmUsage } from "../types.js";

function toLlmError(err: unknown, providerId: string): LlmError {
  if (APICallError.isInstance(err)) {
    const status = err.statusCode ?? 0;
    if (status === 429) return new LlmError("rate_limited", err.message, providerId);
    if (status === 401 || status === 403) return new LlmError("auth", err.message, providerId);
    if (status >= 500 || status === 0)
      return new LlmError("provider_unavailable", err.message, providerId);
    return new LlmError("bad_request", err.message, providerId);
  }
  return new LlmError("provider_unavailable", String(err), providerId);
}

function toUsage(usage: {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
}): LlmUsage {
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
  };
}

type LanguageModelFactory = (modelId: string) => Parameters<typeof generateText>[0]["model"];
type EmbeddingModelFactory = (modelId: string) => Parameters<typeof aiEmbed>[0]["model"];

function buildAdapter(
  providerId: string,
  languageModel: LanguageModelFactory,
  embeddingModel: EmbeddingModelFactory,
): ProviderAdapter {
  return {
    providerId,
    async complete(input) {
      try {
        const result = await generateText({
          model: languageModel(input.model),
          messages: input.messages,
          ...(input.maxTokens !== undefined && { maxOutputTokens: input.maxTokens }),
          ...(input.temperature !== undefined && { temperature: input.temperature }),
        });
        const finishReason =
          result.finishReason === "stop"
            ? ("stop" as const)
            : result.finishReason === "length"
              ? ("length" as const)
              : result.finishReason === "content-filter"
                ? ("content_filter" as const)
                : ("other" as const);
        return { text: result.text, usage: toUsage(result.usage), finishReason };
      } catch (err) {
        throw toLlmError(err, providerId);
      }
    },
    async embed(input) {
      try {
        const result = await aiEmbed({ model: embeddingModel(input.model), value: input.text });
        return {
          embedding: result.embedding,
          usage: toUsage({ inputTokens: result.usage?.tokens ?? 0, outputTokens: 0 }),
        };
      } catch (err) {
        throw toLlmError(err, providerId);
      }
    },
  };
}

export function createAnthropicAdapter(options: {
  providerId?: string;
  apiKey: string;
  baseUrl?: string;
}): ProviderAdapter {
  const provider = createAnthropic({
    apiKey: options.apiKey,
    ...(options.baseUrl && { baseURL: options.baseUrl }),
  });
  return buildAdapter(
    options.providerId ?? "anthropic",
    (m) => provider(m),
    (m) => provider.textEmbeddingModel(m),
  );
}

export function createOpenAiAdapter(options: {
  providerId?: string;
  apiKey: string;
  baseUrl?: string;
}): ProviderAdapter {
  const provider = createOpenAI({
    apiKey: options.apiKey,
    ...(options.baseUrl && { baseURL: options.baseUrl }),
  });
  return buildAdapter(
    options.providerId ?? "openai",
    (m) => provider(m),
    (m) => provider.textEmbeddingModel(m),
  );
}

/** OpenRouter, Ollama and vLLM all speak the OpenAI-compatible dialect. */
export function createOpenAiCompatAdapter(options: {
  providerId: string;
  baseUrl: string;
  apiKey?: string;
}): ProviderAdapter {
  const provider = createOpenAICompatible({
    name: options.providerId,
    baseURL: options.baseUrl,
    ...(options.apiKey && { apiKey: options.apiKey }),
  });
  return buildAdapter(
    options.providerId,
    (m) => provider(m),
    (m) => provider.textEmbeddingModel(m),
  );
}

export function createOpenRouterAdapter(options: { apiKey: string }): ProviderAdapter {
  return createOpenAiCompatAdapter({
    providerId: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey: options.apiKey,
  });
}

export function createOllamaAdapter(options: { baseUrl: string }): ProviderAdapter {
  return createOpenAiCompatAdapter({
    providerId: "ollama",
    baseUrl: options.baseUrl.replace(/\/$/, "") + "/v1",
  });
}
