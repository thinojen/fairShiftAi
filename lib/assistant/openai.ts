/**
 * Real OpenAI client (Responses API). Server-only: the API key never leaves the
 * server. Wrapped in the small ModelClient interface used by the loop.
 */
import "server-only";
import OpenAI from "openai";
import type { ModelClient, ModelResponse } from "./run";

let client: OpenAI | undefined;

export function openAIModelClient(): ModelClient {
  client ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 45_000, maxRetries: 1 });
  return {
    async create(params) {
      const r = await client!.responses.create(params as unknown as Parameters<OpenAI["responses"]["create"]>[0]);
      return r as unknown as ModelResponse;
    },
  };
}
