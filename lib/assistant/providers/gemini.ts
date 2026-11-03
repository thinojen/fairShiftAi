/**
 * Gemini adapter (free tier) via Google's OpenAI-compatible CHAT COMPLETIONS
 * endpoint. The assistant loop speaks a small Responses-API-shaped protocol
 * (lib/assistant/run.ts); this adapter translates it in both directions.
 *
 * Thought signatures: Gemini 3 attaches an opaque signature to tool calls
 * (tool_calls[].extra_content.google.thought_signature) that must be sent back
 * UNCHANGED on the next turn. We keep the raw assistant message returned by the
 * API and replay it verbatim, so every field — known or not — survives.
 *
 * Structured output: we send response_format json_schema with the tools. Only if
 * Gemini EXPLICITLY rejects that combination do we retry once without it; the
 * loop still validates the JSON shape and every fact either way.
 */
import { AiProviderError, classifyProviderError } from "./errors";
import type { ModelClient, ModelOutputItem, ModelResponse } from "../run";

export const GEMINI_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash-lite";

type JsonObject = Record<string, unknown>;
type ChatMessage = JsonObject & { role: string };
export type ChatRequest = JsonObject & { model: string; messages: ChatMessage[] };
export type ChatResponse = {
  choices?: Array<{ message?: JsonObject & { content?: string | null; tool_calls?: Array<JsonObject & { id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

/** Marker carried on our output items so the raw Gemini message can be replayed verbatim. */
const RAW = "_gemini_raw_message";

/** Convert our JSON Schema (OpenAI strict dialect) to what Gemini's compatibility layer accepts. */
export function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== "object") return schema;
  const out: JsonObject = {};
  for (const [k, v] of Object.entries(schema as JsonObject)) {
    if (k === "additionalProperties" || k === "strict") continue;
    if (k === "type" && Array.isArray(v)) {
      const types = v.filter((t) => t !== "null");
      out.type = types[0] ?? "string";
      if (v.includes("null")) out.nullable = true;
      continue;
    }
    out[k] = toGeminiSchema(v);
  }
  return out;
}

/** Strip ```json fences / surrounding prose so a JSON answer can be parsed. Never invents content. */
export function extractJsonText(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  const first = body.indexOf("{");
  const last = body.lastIndexOf("}");
  return first >= 0 && last > first ? body.slice(first, last + 1) : body;
}

/** Our Responses-style params → Chat Completions request. Pure. */
export function toChatRequest(params: JsonObject, opts: { model: string; withResponseFormat: boolean }): ChatRequest {
  const messages: ChatMessage[] = [];
  if (typeof params.instructions === "string") messages.push({ role: "system", content: params.instructions });

  const input = (params.input as Array<JsonObject>) ?? [];
  const replayed = new Set<unknown>();
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (item.type === "function_call") {
      const raw = item[RAW] as ChatMessage | undefined;
      if (raw) {
        if (!replayed.has(raw)) {
          messages.push(structuredClone(raw)); // verbatim: keeps extra_content / thought signatures
          replayed.add(raw);
        }
        continue;
      }
      // No raw message (e.g. history from another provider): rebuild a plain one, grouping consecutive calls.
      const calls: JsonObject[] = [];
      while (i < input.length && input[i].type === "function_call" && !input[i][RAW]) {
        const c = input[i];
        calls.push({ id: c.call_id, type: "function", function: { name: c.name, arguments: c.arguments ?? "{}" } });
        i++;
      }
      i--;
      messages.push({ role: "assistant", content: null, tool_calls: calls });
    } else if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: String(item.output ?? "") });
    } else if (item.type === "message") {
      const raw = item[RAW] as ChatMessage | undefined;
      if (raw) messages.push(structuredClone(raw));
      else {
        const text = ((item.content as Array<{ text?: string }>) ?? []).map((c) => c.text ?? "").join("");
        messages.push({ role: "assistant", content: text });
      }
    } else if (item.role === "user" || item.role === "assistant" || item.role === "system") {
      messages.push({ role: String(item.role), content: String(item.content ?? "") });
    }
    // Anything else (e.g. OpenAI reasoning items) is not meaningful to Gemini and is dropped.
  }

  const req: ChatRequest = { model: opts.model, messages };
  const tools = (params.tools as Array<JsonObject>) ?? [];
  if (tools.length) {
    req.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) },
    }));
    req.tool_choice = "auto";
  }
  const format = (params.text as { format?: { type?: string; name?: string; schema?: unknown } } | undefined)?.format;
  if (opts.withResponseFormat && format?.type === "json_schema") {
    req.response_format = { type: "json_schema", json_schema: { name: format.name ?? "answer", schema: toGeminiSchema(format.schema) } };
  }
  const effort = (params.reasoning as { effort?: string } | undefined)?.effort;
  if (effort) req.reasoning_effort = effort;
  // Gemini counts thinking toward the budget; leave room so answers aren't truncated.
  if (typeof params.max_output_tokens === "number") req.max_tokens = Math.max(params.max_output_tokens, 2048);
  return req;
}

let callCounter = 0;

/** Chat Completions response → our Responses-style output. Pure (aside from fallback ids). */
export function fromChatResponse(resp: ChatResponse, wantJson: boolean): ModelResponse {
  const msg = resp.choices?.[0]?.message;
  if (!msg) throw new AiProviderError("AI returned no message", "unavailable");
  const usage = { input_tokens: resp.usage?.prompt_tokens ?? 0, output_tokens: resp.usage?.completion_tokens ?? 0 };

  const toolCalls = msg.tool_calls ?? [];
  if (toolCalls.length) {
    // Fill any missing ids IN the raw message too, so tool results match on replay.
    const raw: ChatMessage = { ...structuredClone(msg), role: "assistant" };
    const rawCalls = raw.tool_calls as Array<JsonObject & { id?: string }>;
    rawCalls.forEach((tc) => {
      if (!tc.id) tc.id = `gemini_call_${++callCounter}`;
    });
    // Every item points at the SAME raw message; the request builder replays it once.
    const output: ModelOutputItem[] = rawCalls.map((tc) => ({
      type: "function_call",
      call_id: String(tc.id),
      name: String((tc.function as { name?: string })?.name ?? ""),
      arguments: String((tc.function as { arguments?: string })?.arguments ?? "{}"),
      [RAW]: raw,
    }));
    return { output, output_text: "", usage };
  }

  const text = typeof msg.content === "string" ? msg.content : "";
  const raw: ChatMessage = { ...structuredClone(msg), role: "assistant" };
  return {
    output: [{ type: "message", content: [{ type: "output_text", text }], [RAW]: raw }],
    output_text: wantJson ? extractJsonText(text) : text,
    usage,
  };
}

/** True only when the API explicitly refused structured output (alone or combined with tools). */
export function isResponseFormatRejection(err: unknown): boolean {
  const e = err as { status?: number; message?: string; error?: unknown };
  if (e?.status !== 400) return false;
  const text = `${e.message ?? ""} ${JSON.stringify(e.error ?? "")}`;
  return /response_format|response[ _]mime[ _]type|responseMimeType|response_schema|responseSchema|json_schema|structured output/i.test(text);
}

export type ChatTransport = (req: ChatRequest) => Promise<ChatResponse>;

/** A ModelClient backed by Gemini's OpenAI-compatible Chat Completions endpoint. */
export function geminiModelClient(transport: ChatTransport, model: string): ModelClient & { responseFormatDisabled: () => boolean } {
  let rejectsResponseFormat = false;
  return {
    responseFormatDisabled: () => rejectsResponseFormat,
    async create(params) {
      const wantJson = Boolean((params.text as { format?: unknown } | undefined)?.format);
      const send = async (withResponseFormat: boolean) => fromChatResponse(await transport(toChatRequest(params, { model, withResponseFormat })), wantJson);
      try {
        return await send(!rejectsResponseFormat);
      } catch (err) {
        if (!rejectsResponseFormat && isResponseFormatRejection(err)) {
          rejectsResponseFormat = true; // remember for this process; JSON is still validated by the loop
          try {
            return await send(false);
          } catch (err2) {
            throw classifyProviderError(err2);
          }
        }
        throw classifyProviderError(err);
      }
    },
  };
}
