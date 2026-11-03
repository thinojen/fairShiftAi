/**
 * POST /api/assistant — the worker's AI assistant.
 *
 * Server-side only: the OpenAI key never reaches the browser. The worker is
 * taken from the demo role cookie (a demo mechanism, not authentication) and
 * every tool is scoped to them. Limits are keyed on the client IP plus global
 * counters, so switching the demo worker doesn't reset them.
 */
import { headers } from "next/headers";
import { assistantLimiter, LIMITS } from "@/lib/assistant/limits";
import { AiProviderError, createModelClient, providerConfig } from "@/lib/assistant/server";
import { runAssistant, type ChatTurn } from "@/lib/assistant/run";
import { getDb } from "@/lib/db/client";
import { getDemoRole } from "@/lib/demo/role";

function bad(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  const role = await getDemoRole();
  if (role.kind !== "worker") return bad(403, "Switch to a worker view to use the assistant.");

  const cfg = providerConfig();
  if (!cfg.ok) return bad(503, cfg.reason);

  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > 20_000) return bad(413, "Message too long.");
  let body: { message?: unknown; history?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad(400, "Invalid request.");
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) return bad(400, "Please type a question.");
  if (message.length > LIMITS.maxMessageChars) return bad(400, `Please keep questions under ${LIMITS.maxMessageChars} characters.`);
  const history: ChatTurn[] = Array.isArray(body.history)
    ? body.history
        .filter((t): t is ChatTurn => !!t && typeof t === "object" && ((t as ChatTurn).role === "user" || (t as ChatTurn).role === "assistant") && typeof (t as ChatTurn).content === "string")
        .slice(-LIMITS.maxHistoryMessages)
    : [];
  if (Array.isArray(body.history) && body.history.length > 40) return bad(400, "Conversation is too long — start a new one.");

  const h = await headers();
  const ip = (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "unknown").trim();
  const limit = assistantLimiter.check(`ip:${ip}`);
  if (!limit.allowed) return bad(429, limit.message);

  try {
    const result = await runAssistant({
      db: getDb(),
      workerId: role.workerId,
      workerFirstName: role.name.split(" ")[0],
      history,
      message,
      client: createModelClient(cfg),
      model: cfg.model,
    });
    if (result.fallback) console.warn("assistant fallback", { worker: role.workerId, violations: result.violations, tools: result.toolCalls });
    const { violations: _v, usage: _u, ...safe } = result; // eslint-disable-line @typescript-eslint/no-unused-vars
    return Response.json(safe);
  } catch (err) {
    // Honest failures only: never a partial or made-up answer.
    if (err instanceof AiProviderError) {
      console.error("assistant provider error", err.kind, err.status ?? "", err.message.slice(0, 200));
      if (err.kind === "quota") {
        return bad(429, "The free AI quota for this demo is used up for now. Please try again later — your figures on this page are unaffected.");
      }
      if (err.kind === "auth") return bad(503, "The assistant isn't configured correctly on this server.");
      return bad(502, "The AI service didn't respond properly. Please try again in a moment.");
    }
    const cause = err instanceof Error && err.cause instanceof Error ? ` — cause: ${err.cause.message}` : "";
    console.error("assistant error", (err instanceof Error ? err.message.slice(0, 200) : String(err)) + cause);
    return bad(500, "Something went wrong while checking your records. Please try again.");
  }
}
