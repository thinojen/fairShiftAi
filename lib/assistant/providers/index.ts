/**
 * AI provider selection. Configured only through server-side environment
 * variables; keys never reach the browser.
 *
 *   AI_PROVIDER=gemini (default)  GEMINI_API_KEY, GEMINI_MODEL (default gemini-3.5-flash-lite)
 *   AI_PROVIDER=openai            OPENAI_API_KEY, OPENAI_MODEL (optional, paid)
 *
 * There is no automatic fallback to another (possibly paid) provider or model.
 */
import OpenAI from "openai";
import type { ModelClient, ModelResponse } from "../run";
import { classifyProviderError } from "./errors";
import { DEFAULT_GEMINI_MODEL, GEMINI_OPENAI_BASE_URL, geminiModelClient, type ChatResponse } from "./gemini";

type Env = Record<string, string | undefined>;

export type ProviderConfig =
  | { ok: true; provider: "gemini" | "openai"; model: string; apiKey: string }
  | { ok: false; reason: string };

/** Lower-case Gemini model ids, e.g. gemini-3.5-flash-lite, gemini-3.5-flash-lite-preview-06-2026. */
export function isPlausibleGeminiModelId(model: string) {
  return /^gemini-[a-z0-9][a-z0-9.-]{1,60}$/.test(model);
}

export function providerConfig(env: Env = process.env): ProviderConfig {
  if (env.AI_ENABLED === "false") return { ok: false, reason: "The assistant is switched off right now." };
  const provider = (env.AI_PROVIDER ?? "gemini").trim().toLowerCase();
  if (provider === "gemini") {
    const apiKey = env.GEMINI_API_KEY?.trim();
    if (!apiKey) return { ok: false, reason: "The assistant isn't configured on this server (missing Gemini API key)." };
    const model = (env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL).replace(/^models\//, "");
    // Checked locally so a typo (or a secret pasted into the wrong variable) never reaches the API.
    // The value itself is not echoed back.
    if (!isPlausibleGeminiModelId(model)) {
      return { ok: false, reason: "GEMINI_MODEL is not a valid Gemini model id (expected something like gemini-3.5-flash-lite)." };
    }
    return { ok: true, provider, apiKey, model };
  }
  if (provider === "openai") {
    const apiKey = env.OPENAI_API_KEY?.trim();
    if (!apiKey) return { ok: false, reason: "The assistant isn't configured on this server (missing OpenAI API key)." };
    return { ok: true, provider, apiKey, model: env.OPENAI_MODEL?.trim() || "gpt-5.4-mini" };
  }
  return { ok: false, reason: `Unknown AI_PROVIDER "${provider}".` };
}

export function createModelClient(cfg: Extract<ProviderConfig, { ok: true }>, opts: { baseURL?: string; timeoutMs?: number } = {}): ModelClient {
  if (cfg.provider === "gemini") {
    // maxRetries 0: never burn free-tier quota on automatic retries (a 429 is reported, not retried).
    // GEMINI_BASE_URL exists only so tests/local harnesses can point at a mock server.
    const sdk = new OpenAI({ apiKey: cfg.apiKey, baseURL: opts.baseURL ?? process.env.GEMINI_BASE_URL ?? GEMINI_OPENAI_BASE_URL, timeout: opts.timeoutMs ?? 45_000, maxRetries: 0 });
    return geminiModelClient(async (req) => (await sdk.chat.completions.create(req as never)) as unknown as ChatResponse, cfg.model);
  }
  const sdk = new OpenAI({ apiKey: cfg.apiKey, baseURL: opts.baseURL, timeout: 45_000, maxRetries: 1 });
  return {
    async create(params) {
      try {
        return (await sdk.responses.create(params as never)) as unknown as ModelResponse;
      } catch (err) {
        throw classifyProviderError(err);
      }
    },
  };
}
