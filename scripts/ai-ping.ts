/**
 * npm run ai:ping — minimal Gemini connectivity test.
 *
 * ONE short, text-only Chat Completions request with the configured key and
 * model: no tools, no structured output, no database, no PayPal. It separates
 * "can we reach Gemini with this key and model at all?" from problems in the
 * tool-calling adapter (which ai-smoke exercises).
 *
 * Prints success details, or a sanitised error (category, HTTP status,
 * provider code, timeout) — never the key, headers or raw bodies.
 *
 * Exit codes: 0 success · 1 failure · 2 inconclusive (free quota hit).
 */
import "dotenv/config";
import OpenAI from "openai";
import { providerConfig } from "../lib/assistant/providers";
import { classifyProviderError, describeProviderError, KIND_LABEL, sanitiseProviderText } from "../lib/assistant/providers/errors";
import { GEMINI_OPENAI_BASE_URL } from "../lib/assistant/providers/gemini";

async function main() {
  const cfg = providerConfig({ ...process.env, AI_PROVIDER: "gemini" });
  if (!cfg.ok) {
    console.error(`RESULT: ✗ Not configured: ${cfg.reason}`);
    process.exit(1);
  }
  const baseURL = process.env.GEMINI_BASE_URL ?? GEMINI_OPENAI_BASE_URL;
  console.log("Gemini connectivity test (one text-only request; no tools, no database, no PayPal)");
  console.log(`  model: ${cfg.model}`);
  console.log(`  endpoint: ${new URL(baseURL).host}${new URL(baseURL).pathname}chat/completions${process.env.GEMINI_BASE_URL ? " (OVERRIDDEN by GEMINI_BASE_URL)" : ""}`);
  console.log("  API key: set");

  const sdk = new OpenAI({ apiKey: cfg.apiKey, baseURL, timeout: 30_000, maxRetries: 0 });
  const started = Date.now();
  try {
    const res = await sdk.chat.completions.create({
      model: cfg.model,
      messages: [{ role: "user", content: "Reply with exactly one word: pong" }],
    });
    const choice = res.choices?.[0];
    const text = typeof choice?.message?.content === "string" ? choice.message.content : "";
    console.log("\n✓ Gemini responded");
    console.log(`  HTTP: 200 · latency: ${Date.now() - started} ms`);
    console.log(`  finish_reason: ${choice?.finish_reason ?? "n/a"}`);
    console.log(`  reply (first 40 chars): "${sanitiseProviderText(text, 40)}"`);
    console.log(`  tokens in/out: ${res.usage?.prompt_tokens ?? "?"}/${res.usage?.completion_tokens ?? "?"}`);
    if (!text.trim()) {
      console.log("\nRESULT: ✗ Connected, but the reply was empty.");
      process.exit(1);
    }
    console.log("\nRESULT: ✓ Connectivity, key and model are OK. Any ai-smoke failure is in the tool-calling flow, not basic access.");
  } catch (err) {
    const e = classifyProviderError(err);
    e.details = { ...e.details, stage: "connectivity ping (single text-only request)", requestsCompleted: 0, request: `model=${cfg.model}, messages=1, tools=0, response_format=none` };
    console.error(`\n✗ Request failed after ${Date.now() - started} ms`);
    for (const line of describeProviderError(e)) console.error(`  ${line}`);
    if (e.kind === "quota") {
      console.log("\nRESULT: ⚠ INCONCLUSIVE — free quota or rate limit hit. This is NOT a pass.");
      process.exit(2);
    }
    console.error(`\nRESULT: ✗ ${KIND_LABEL[e.kind]}${e.status !== undefined ? ` (HTTP ${e.status})` : ""}`);
    process.exit(1);
  }
}

main();
