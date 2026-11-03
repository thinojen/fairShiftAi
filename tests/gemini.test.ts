/**
 * Gemini provider: adapter unit tests + a full interaction over real HTTP
 * through the OpenAI SDK against a local server that mimics Gemini's
 * OpenAI-compatible Chat Completions endpoint (including Gemini 3's rule that
 * thought signatures must be returned unchanged). No real Gemini calls.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UsageLimiter, LIMITS, dailyLimitFromEnv, aiAvailability } from "@/lib/assistant/limits";
import { AiProviderError, classifyProviderError } from "@/lib/assistant/providers/errors";
import { extractJsonText, fromChatResponse, geminiModelClient, isResponseFormatRejection, toChatRequest, toGeminiSchema } from "@/lib/assistant/providers/gemini";
import { createModelClient, providerConfig } from "@/lib/assistant/providers";
import { parseAnswerShape, runAssistant } from "@/lib/assistant/run";
import { TOOLS } from "@/lib/assistant/tools";
import type { Db } from "@/lib/db/connect";
import * as s from "@/lib/db/schema";
import { correctAssignmentTime } from "@/lib/shifts/commands";
import { createTestDb } from "./helpers/pglite";

// ---------------------------------------------------------------------------
// A local Gemini-compatible server.
type Req = { body: Record<string, unknown> };
type Handler = (req: Req, n: number) => { status: number; json: unknown };
let server: http.Server;
let baseURL = "";
let handler: Handler = () => ({ status: 500, json: {} });
const seen: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      seen.push(body);
      const r = handler({ body }, seen.length);
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1beta/openai/`;
});
afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

const SIG = "CiQB0e2Kb+opaque/thought/signature==";
const toolCallMsg = (name: string, args: Record<string, unknown>, id = "call_g1") => ({
  role: "assistant",
  content: null,
  // NOTE: Gemini omits `index` and carries the signature in extra_content.
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) }, extra_content: { google: { thought_signature: SIG } } }],
});
const chat = (message: unknown) => ({ id: "x", object: "chat.completion", choices: [{ index: 0, message, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
const answerJson = (answer: string, offer = false) => JSON.stringify({ answer, cited_fact_ids: [], offer_pay_query: offer });

/** Behaves like Gemini 3: a follow-up turn must replay the tool call WITH its thought signature. */
function requireSignature(body: Record<string, unknown>) {
  const msgs = body.messages as Array<Record<string, unknown>>;
  const asst = msgs.find((m) => m.role === "assistant" && Array.isArray(m.tool_calls));
  if (!asst) return null;
  const tc = (asst.tool_calls as Array<Record<string, unknown>>)[0];
  const sig = (tc.extra_content as { google?: { thought_signature?: string } } | undefined)?.google?.thought_signature;
  if (sig !== SIG) {
    return { status: 400, json: [{ error: { code: 400, status: "INVALID_ARGUMENT", message: "Function call is missing a thought_signature in functionCall parts." } }] };
  }
  return null;
}

let db: Db;
let close: () => Promise<void>;
beforeEach(async () => {
  ({ db, close } = await createTestDb());
  seen.length = 0;
}, 30_000);
afterEach(async () => close());

const gemini = () => createModelClient({ ok: true, provider: "gemini", apiKey: "test-key", model: "gemini-3.1-flash-lite" }, { baseURL });
const ask = (message: string, history: Array<{ role: "user" | "assistant"; content: string }> = []) =>
  runAssistant({ db, workerId: "w_sam", workerFirstName: "Sam", history, message, client: gemini(), model: "gemini-3.1-flash-lite" });
const fixSam = () =>
  correctAssignmentTime(db, { assignmentId: "sa_1030_sam", field: "clock_out", value: "2026-10-30T23:30:00Z", reason: "No clock-out recorded; set to rota end", actor: "m" });
const factOf = (toolMsg: Record<string, unknown>, path: string[]) => {
  let v: unknown = JSON.parse(String(toolMsg.content));
  for (const k of path) v = (v as Record<string, unknown>)[k];
  return (v as { fact: string }).fact;
};

// ---------------------------------------------------------------------------
describe("Gemini: one complete interaction over HTTP (function calling + thought signatures)", () => {
  it("question → Gemini tool call → our tool → verified answer; signature replayed unchanged", async () => {
    await fixSam();
    handler = ({ body }, n) => {
      if (n === 1) return { status: 200, json: chat(toolCallMsg("compare_periods", { earlier_shift_id: null, later_shift_id: null })) };
      const missing = requireSignature(body);
      if (missing) return missing;
      const tool = (body.messages as Array<Record<string, unknown>>).find((m) => m.role === "tool")!;
      const delta = factOf(tool, ["difference_in_your_share"]);
      return { status: 200, json: chat({ role: "assistant", content: answerJson(`You earned [[${delta}]] compared with last Friday. This figure is provisional.`) }) };
    };
    const r = await ask("Why did I earn less this Friday than last Friday?");

    // 1-2. Gemini requested an approved tool; 3. we executed it.
    expect(r.toolCalls).toEqual([{ name: "compare_periods", ok: true }]);
    // 4-5. Grounded, verified answer rendered from the fact ledger.
    expect(r.verified).toBe(true);
    expect(r.segments.map((x) => (x.type === "text" ? x.text : x.display)).join("")).toContain("−£111.69");
    expect(r.evidence[0].sourceType).toBe("comparison");

    // Request shape sent to Gemini.
    const first = seen[0];
    expect(first.model).toBe("gemini-3.1-flash-lite");
    expect((first.messages as Array<{ role: string }>)[0].role).toBe("system");
    expect(first.tool_choice).toBe("auto");
    expect((first.tools as unknown[]).length).toBe(TOOLS.length);
    expect(first.response_format).toMatchObject({ type: "json_schema" });
    expect(JSON.stringify(first.tools)).not.toMatch(/additionalProperties|"strict"/);
    expect(first).not.toHaveProperty("store");

    // Thought signature replayed verbatim, and tool result linked by id.
    const second = seen[1].messages as Array<Record<string, unknown>>;
    const asst = second.find((m) => m.role === "assistant" && m.tool_calls)!;
    expect((asst.tool_calls as Array<Record<string, unknown>>)[0]).toEqual(toolCallMsg("compare_periods", { earlier_shift_id: null, later_shift_id: null }).tool_calls[0]);
    expect(second.find((m) => m.role === "tool")).toMatchObject({ tool_call_id: "call_g1" });
  });

  it("without the signature, the Gemini-like server refuses (proves the check is real)", async () => {
    handler = ({ body }, n) => (n === 1 ? { status: 200, json: chat(toolCallMsg("get_worker_shifts", {})) } : (requireSignature(body) ?? { status: 200, json: chat({ role: "assistant", content: answerJson("ok") }) }));
    // A transport that strips extra_content, as a naive client would:
    const stripping = geminiModelClient(async (req) => {
      const clone = structuredClone(req);
      for (const m of clone.messages) for (const tc of (m.tool_calls as Array<Record<string, unknown>>) ?? []) delete tc.extra_content;
      const res = await fetch(`${baseURL}chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(clone) });
      if (!res.ok) throw Object.assign(new Error(await res.text()), { status: res.status });
      return res.json();
    }, "gemini-3.1-flash-lite");
    await expect(runAssistant({ db, workerId: "w_sam", workerFirstName: "Sam", history: [], message: "shifts?", client: stripping, model: "m" })).rejects.toMatchObject({ kind: "bad_request" });
  });

  it("parallel tool calls keep their own ids and one signature-carrying message", async () => {
    handler = ({ body }, n) => {
      if (n === 1)
        return {
          status: 200,
          json: chat({
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "a", type: "function", function: { name: "get_policy", arguments: '{"shift_id":"sh_2026-10-23_dinner","version":null}' }, extra_content: { google: { thought_signature: SIG } } },
              { id: "b", type: "function", function: { name: "get_policy", arguments: '{"shift_id":"sh_2026-10-30_dinner","version":null}' } },
            ],
          }),
        };
      const msgs = body.messages as Array<Record<string, unknown>>;
      expect(msgs.filter((m) => m.role === "assistant" && m.tool_calls)).toHaveLength(1);
      expect(msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id)).toEqual(["a", "b"]);
      return { status: 200, json: chat({ role: "assistant", content: answerJson("Two policies applied.") }) };
    };
    const r = await ask("what policies applied?");
    expect(r.verified).toBe(true);
    expect(r.toolCalls).toEqual([{ name: "get_policy", ok: true }, { name: "get_policy", ok: true }]);
  });

  it("missing tool-call ids are generated and kept consistent", () => {
    const out = fromChatResponse(chat({ role: "assistant", content: null, tool_calls: [{ type: "function", function: { name: "get_worker_shifts", arguments: "{}" } }] }) as never, true);
    const item = out.output[0] as { call_id: string };
    expect(item.call_id).toMatch(/^gemini_call_/);
    const req = toChatRequest({ input: [...out.output, { type: "function_call_output", call_id: item.call_id, output: "{}" }] }, { model: "m", withResponseFormat: false });
    const asst = req.messages.find((m) => m.role === "assistant")!;
    expect((asst.tool_calls as Array<{ id: string }>)[0].id).toBe(item.call_id);
    expect(req.messages.find((m) => m.role === "tool")!.tool_call_id).toBe(item.call_id);
  });
});

describe("structured output", () => {
  it("retries WITHOUT response_format only when Gemini explicitly rejects it, and remembers", async () => {
    handler = ({ body }) =>
      body.response_format
        ? { status: 400, json: [{ error: { code: 400, status: "INVALID_ARGUMENT", message: "Function calling with a response mime type: 'application/json' is unsupported" } }] }
        : { status: 200, json: chat({ role: "assistant", content: "```json\n" + answerJson("Hello Sam.") + "\n```" }) };
    const client = gemini();
    const r = await runAssistant({ db, workerId: "w_sam", workerFirstName: "Sam", history: [], message: "hi", client, model: "m" });
    expect(r.verified).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toHaveProperty("response_format");
    expect(seen[1]).not.toHaveProperty("response_format");
    // Remembered: the next call goes straight without it.
    await runAssistant({ db, workerId: "w_sam", workerFirstName: "Sam", history: [], message: "hi again", client, model: "m" });
    expect(seen[2]).not.toHaveProperty("response_format");
  });

  it("other 400s are NOT treated as a format rejection (no silent retry)", async () => {
    handler = () => ({ status: 400, json: [{ error: { code: 400, status: "INVALID_ARGUMENT", message: "Request contains an invalid argument." } }] });
    await expect(ask("hi")).rejects.toMatchObject({ kind: "bad_request" });
    expect(seen).toHaveLength(1);
  });

  it("parses fenced JSON but never accepts the wrong shape", () => {
    expect(extractJsonText('Sure!\n```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(parseAnswerShape(answerJson("ok")).ok).toBe(true);
    expect(parseAnswerShape("not json").ok).toBe(false);
    expect(parseAnswerShape('{"answer":"x"}').ok).toBe(false);
    expect(parseAnswerShape('{"answer":"x","cited_fact_ids":[],"offer_pay_query":false,"amount":"£5"}').ok).toBe(false);
    expect(parseAnswerShape('{"answer":5,"cited_fact_ids":[],"offer_pay_query":false}').ok).toBe(false);
    expect(parseAnswerShape('{"answer":"x","cited_fact_ids":[1],"offer_pay_query":false}').ok).toBe(false);
  });

  it("invalid JSON from Gemini → one corrective retry → safe fallback, nothing unvalidated shown", async () => {
    handler = () => ({ status: 200, json: chat({ role: "assistant", content: "Your share was about £150, nice!" }) });
    const r = await ask("how much did I earn?");
    expect(r.verified).toBe(false);
    expect(r.fallback).toBe(true);
    expect(JSON.stringify(r.segments)).not.toContain("£150");
    expect(seen).toHaveLength(2);
  });

  it("hallucinated amounts in valid JSON are rejected too", async () => {
    handler = () => ({ status: 200, json: chat({ role: "assistant", content: answerJson("You were paid £999.99 via PayPal.") }) });
    const r = await ask("have I been paid?");
    expect(r.fallback).toBe(true);
    expect(JSON.stringify(r.segments)).not.toContain("999");
  });
});

describe("quota, credentials and limits", () => {
  it("HTTP 429 RESOURCE_EXHAUSTED → quota error, after exactly ONE request (no retries burning quota)", async () => {
    handler = () => ({ status: 429, json: [{ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota." } }] });
    await expect(ask("hi")).rejects.toMatchObject({ name: "AiProviderError", kind: "quota" });
    expect(seen).toHaveLength(1);
    // Nothing was written.
    expect(await db.select().from(s.payQueries)).toHaveLength(0);
  });

  it("invalid API key → auth error", async () => {
    handler = () => ({ status: 400, json: [{ error: { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." } }] });
    await expect(ask("hi")).rejects.toMatchObject({ kind: "auth" });
  });

  it("classifies errors", () => {
    expect(classifyProviderError({ status: 429 }).kind).toBe("quota");
    expect(classifyProviderError({ status: 403 }).kind).toBe("auth");
    expect(classifyProviderError(new Error("fetch failed")).kind).toBe("unavailable");
    expect(classifyProviderError(new AiProviderError("x", "quota")).kind).toBe("quota");
  });

  it("missing or wrong configuration disables the assistant with a clear reason", () => {
    expect(providerConfig({})).toMatchObject({ ok: false, reason: expect.stringMatching(/Gemini API key/) }); // gemini is the default
    expect(providerConfig({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "" })).toMatchObject({ ok: false });
    expect(providerConfig({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k" })).toMatchObject({ ok: true, model: "gemini-3.1-flash-lite" });
    expect(providerConfig({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k", GEMINI_MODEL: "gemini-3.5-flash-lite" })).toMatchObject({ model: "gemini-3.5-flash-lite" });
    expect(providerConfig({ AI_PROVIDER: "gemini", GEMINI_API_KEY: "k", AI_ENABLED: "false" })).toMatchObject({ ok: false });
    expect(providerConfig({ AI_PROVIDER: "mystery", GEMINI_API_KEY: "k" })).toMatchObject({ ok: false });
    // An OpenAI key alone does NOT enable anything while the provider is Gemini (no paid fallback).
    expect(providerConfig({ OPENAI_API_KEY: "sk" })).toMatchObject({ ok: false });
    expect(aiAvailability({ GEMINI_API_KEY: "k" })).toMatchObject({ enabled: true, provider: "gemini" });
  });

  it("free-tier limits: 5 questions/minute globally, regardless of worker or client", () => {
    let t = 0;
    const lim = new UsageLimiter(() => 100, () => t);
    const results = Array.from({ length: 6 }, (_, i) => lim.check(`ip:${i}`).allowed);
    expect(results).toEqual([true, true, true, true, true, false]);
    t = 61_000;
    expect(lim.check("ip:9").allowed).toBe(true);
  });

  it("daily cap defaults to 100 and per-client limit applies", () => {
    expect(dailyLimitFromEnv({})).toBe(100);
    expect(dailyLimitFromEnv({ AI_DAILY_LIMIT: "100" })).toBe(100);
    let t = 0;
    const daily = new UsageLimiter(() => 3, () => (t += 61_000));
    expect([1, 2, 3, 4].map(() => daily.check("ip").allowed)).toEqual([true, true, true, false]);
    let u = 0;
    const perClient = new UsageLimiter(() => 1000, () => (u += 13_000)); // spaced out to dodge the per-minute cap
    const r = Array.from({ length: LIMITS.perClientPerWindow + 1 }, () => perClient.check("same-ip").allowed);
    expect(r.at(-1)).toBe(false);
  });
});

describe("schema dialect + request mapping (pure)", () => {
  it("converts nullable unions and drops unsupported keywords, keeping enums and required", () => {
    expect(toGeminiSchema({ type: "object", additionalProperties: false, required: ["a"], properties: { a: { type: ["string", "null"], enum: ["x"] } } })).toEqual({
      type: "object",
      required: ["a"],
      properties: { a: { type: "string", nullable: true, enum: ["x"] } },
    });
  });

  it("maps instructions, history, tool outputs and the final retry note", () => {
    const req = toChatRequest(
      {
        instructions: "SYS",
        input: [
          { role: "user", content: "q1" },
          { role: "assistant", content: "a1" },
          { type: "reasoning", encrypted_content: "zzz" },
          { role: "user", content: "q2" },
        ],
        reasoning: { effort: "low" },
        max_output_tokens: 1200,
      },
      { model: "gemini-3.1-flash-lite", withResponseFormat: false },
    );
    expect(req.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "q1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "q2" },
    ]);
    expect(req).toMatchObject({ reasoning_effort: "low", max_tokens: 2048 });
    expect(req).not.toHaveProperty("response_format");
  });

  it("recognises only explicit structured-output rejections", () => {
    expect(isResponseFormatRejection({ status: 400, message: "response_mime_type is not supported with tools" })).toBe(true);
    expect(isResponseFormatRejection({ status: 400, message: "Request contains an invalid argument." })).toBe(false);
    expect(isResponseFormatRejection({ status: 429, message: "response_format" })).toBe(false);
  });
});
