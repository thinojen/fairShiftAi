/**
 * The assistant loop (OpenAI Responses API, server-side function calling).
 *
 *   1. Send instructions + capped history + the worker's message + tools.
 *   2. Execute any function calls with deterministic, worker-scoped tools.
 *   3. Repeat (bounded) until the model returns its structured answer.
 *   4. Validate the answer against the fact ledger; one corrective retry;
 *      otherwise fall back to a deterministic message. The model's own text
 *      never reaches the worker with an unverified number in it.
 */
import type { Db } from "../db/connect";
import type { PayQueryProposal } from "../payqueries/commands";
import { factToken, FactLedger, toModelPayload } from "./facts";
import { LIMITS } from "./limits";
import { ANSWER_SCHEMA, systemPrompt } from "./prompt";
import { executeTool, TOOLS, type ToolContext } from "./tools";
import { evidenceCards, placeholderStats, validateAnswer, type EvidenceCard, type Segment } from "./validate";

/** The minimal slice of the Responses API we use (lets tests inject a fake model). */
export type ModelOutputItem =
  | { type: "function_call"; name: string; arguments: string; call_id: string; [k: string]: unknown }
  | { type: "message"; content?: Array<{ type: string; text?: string }>; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

export type ModelResponse = {
  output: ModelOutputItem[];
  output_text?: string;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
  /** Provider's stop reason when available (e.g. "stop", "length"). */
  finish_reason?: string | null;
};

/** Sanitised record of each final-answer attempt (no keys; ids masked). */
export type AnswerAttempt = {
  finishReason: string | null;
  textChars: number;
  jsonValid: boolean;
  shapeValid: boolean;
  placeholders: { total: number; unknown: number; altered: number };
  violations: string[];
};

export type ModelClient = { create(params: Record<string, unknown>): Promise<ModelResponse> };

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type AssistantResult = {
  segments: Segment[];
  evidence: EvidenceCard[];
  proposal: PayQueryProposal | null;
  offerPayQuery: boolean;
  toolCalls: Array<{ name: string; ok: boolean }>;
  verified: boolean;
  fallback: boolean;
  usage: { inputTokens: number; outputTokens: number; modelCalls: number };
  /** Why the model's answer was rejected (server logs / ai-check only; never shown). */
  violations?: string[];
  /** Per-attempt diagnostics (server logs / ai-check only; never shown). */
  attempts: AnswerAttempt[];
};

/** Mask anything id-like so diagnostics never print payment references. */
export function sanitiseDiagnostic(text: string) {
  return text.replace(/\b(?=[A-Z0-9_-]*\d)[A-Z0-9_-]{10,}\b/g, "[id]").slice(0, 300);
}

function textOf(resp: ModelResponse): string {
  if (typeof resp.output_text === "string" && resp.output_text) return resp.output_text;
  return resp.output
    .filter((o) => o.type === "message")
    .flatMap((o) => ((o as { content?: Array<{ type: string; text?: string }> }).content ?? []).map((c) => c.text ?? ""))
    .join("");
}

export type AnswerShape = { answer: string; cited_fact_ids: string[]; offer_pay_query: boolean };

/** Validate the model's JSON against ANSWER_SCHEMA (required keys, exact types, no extras). */
export function parseAnswerShape(text: string): { ok: true; value: AnswerShape } | { ok: false; error: string } {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return { ok: false, error: "the response was not valid JSON" };
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, error: "the response was not a JSON object" };
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "answer,cited_fact_ids,offer_pay_query") return { ok: false, error: `the JSON must have exactly answer, cited_fact_ids, offer_pay_query (got ${keys || "none"})` };
  if (typeof o.answer !== "string") return { ok: false, error: "answer must be a string" };
  if (!Array.isArray(o.cited_fact_ids) || !o.cited_fact_ids.every((x) => typeof x === "string")) return { ok: false, error: "cited_fact_ids must be an array of strings" };
  if (typeof o.offer_pay_query !== "boolean") return { ok: false, error: "offer_pay_query must be a boolean" };
  return { ok: true, value: { answer: o.answer, cited_fact_ids: o.cited_fact_ids as string[], offer_pay_query: o.offer_pay_query } };
}

export function sanitizeHistory(history: ChatTurn[]): ChatTurn[] {
  const recent = history.filter((t) => (t.role === "user" || t.role === "assistant") && typeof t.content === "string").slice(-LIMITS.maxHistoryMessages);
  let budget = LIMITS.maxHistoryChars;
  const out: ChatTurn[] = [];
  for (const t of recent.reverse()) {
    const c = t.content.slice(0, 1500);
    if (budget - c.length < 0) break;
    budget -= c.length;
    out.unshift({ role: t.role, content: c });
  }
  return out;
}

export async function runAssistant(args: {
  db: Db;
  workerId: string;
  workerFirstName: string;
  history: ChatTurn[];
  message: string;
  client: ModelClient;
  model: string;
}): Promise<AssistantResult> {
  const ledger = new FactLedger();
  const ctx: ToolContext = { db: args.db, workerId: args.workerId, ledger, proposals: [] };
  const toolCalls: AssistantResult["toolCalls"] = [];
  const usage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };

  const input: unknown[] = [
    ...sanitizeHistory(args.history).map((t) => ({ role: t.role, content: t.content })),
    { role: "user", content: args.message.slice(0, LIMITS.maxMessageChars) },
  ];

  const baseParams = {
    model: args.model,
    instructions: systemPrompt(args.workerFirstName),
    tools: TOOLS.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters, strict: true })),
    tool_choice: "auto",
    parallel_tool_calls: true,
    text: { format: { type: "json_schema", name: "fairshift_answer", schema: ANSWER_SCHEMA, strict: true } },
    reasoning: { effort: "low" },
    max_output_tokens: LIMITS.maxOutputTokens,
    // Stateless: nothing stored at OpenAI; reasoning is passed back encrypted.
    store: false,
    include: ["reasoning.encrypted_content"],
  };

  let retried = false;
  let lastViolations: string[] = [];
  const attempts: AnswerAttempt[] = [];

  for (let round = 0; round < LIMITS.maxToolRounds; round++) {
    const resp = await args.client.create({ ...baseParams, input });
    usage.modelCalls++;
    usage.inputTokens += resp.usage?.input_tokens ?? 0;
    usage.outputTokens += resp.usage?.output_tokens ?? 0;

    const calls = resp.output.filter((o): o is Extract<ModelOutputItem, { type: "function_call" }> => o.type === "function_call");
    if (calls.length) {
      input.push(...resp.output);
      for (const call of calls) {
        let output: unknown;
        if (toolCalls.length >= LIMITS.maxToolCalls) {
          output = { error: "Tool call limit reached for this message. Answer with what you have." };
          toolCalls.push({ name: String(call.name), ok: false });
        } else {
          const r = await executeTool(ctx, String(call.name), String(call.arguments ?? "{}"));
          output = r.output;
          toolCalls.push({ name: String(call.name), ok: r.ok });
        }
        // Values reach the model as self-verifying tokens like [[f12|−£111.69]].
        input.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(toModelPayload(output)) });
      }
      continue;
    }

    // Final answer: must be JSON matching ANSWER_SCHEMA exactly, then pass the fact-ledger checks.
    const text = textOf(resp);
    const shape = parseAnswerShape(text);
    const parsed = shape.ok ? shape.value : { answer: "", cited_fact_ids: [], offer_pay_query: false };
    const answer = parsed.answer;
    const v: ReturnType<typeof validateAnswer> = shape.ok ? validateAnswer(answer, ledger) : { ok: false, violations: [shape.error] };
    let jsonValid = true;
    try {
      JSON.parse(text);
    } catch {
      jsonValid = false;
    }
    attempts.push({
      finishReason: resp.finish_reason ?? null,
      textChars: text.length,
      jsonValid,
      shapeValid: shape.ok,
      placeholders: placeholderStats(answer, ledger),
      violations: v.ok ? [] : v.violations.map(sanitiseDiagnostic),
    });
    if (v.ok) {
      const cited = parsed.cited_fact_ids;
      const extra = cited.map((id) => ledger.get(id)).filter((f): f is NonNullable<typeof f> => Boolean(f));
      const facts = [...v.usedFacts, ...extra.filter((f) => !v.usedFacts.includes(f))];
      return {
        segments: v.segments,
        evidence: evidenceCards(facts),
        proposal: ctx.proposals[0] ?? null,
        offerPayQuery: parsed.offer_pay_query === true,
        toolCalls,
        verified: true,
        fallback: false,
        usage,
        attempts,
      };
    }
    lastViolations = v.violations;
    if (retried) break;
    retried = true;
    input.push(...resp.output);
    // Corrective retry: say exactly what was wrong and list the tokens that ARE available.
    const available = ledger
      .all()
      .filter((f) => ["money", "minutes", "status", "policy", "percent", "time"].includes(f.kind))
      .slice(0, 30)
      .map((f) => `${factToken(f.id, f.display)} (${f.label})`);
    input.push({
      role: "user",
      content:
        "[FairShift system check — not from the worker] Your answer was rejected because " +
        v.violations.slice(0, 5).join("; ") +
        ". Reply again with the JSON object only. Every amount, time, duration, percentage, status or id must be one of these tokens, copied exactly:\n" +
        (available.length ? available.join("\n") : "(no facts yet — call a tool first)"),
    });
  }

  // Deterministic fallback: never show unverified model text.
  const facts = ledger.all().filter((f) => f.kind === "money" || f.kind === "status" || f.kind === "minutes");
  return {
    segments: [
      {
        type: "text",
        text:
          "Sorry — I couldn't put together an answer I could fully verify against your records, so I'm not showing it. " +
          (facts.length ? "Here are the records I checked:" : "Please try asking in a different way."),
      },
    ],
    evidence: evidenceCards(facts.slice(0, 12)),
    proposal: ctx.proposals[0] ?? null,
    offerPayQuery: false,
    toolCalls,
    verified: false,
    fallback: true,
    usage,
    violations: lastViolations,
    attempts,
  };
}
