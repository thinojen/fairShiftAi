import { aiAvailability } from "./assistant/limits";

type Env = Record<string, string | undefined>;

/** What /api/health shows. Pure, so it can be tested. Never includes secrets. */
export function healthReport(env: Env = process.env) {
  const ai = aiAvailability(env);
  return {
    ok: true,
    service: "fairshift-ai",
    payoutsEnabled: env.PAYOUTS_ENABLED === "true",
    ai: ai.enabled
      ? { enabled: true, provider: ai.provider, model: ai.model, apiKeyConfigured: true }
      : { enabled: false, reason: ai.reason, apiKeyConfigured: Boolean(env.GEMINI_API_KEY?.trim() || env.OPENAI_API_KEY?.trim()) },
  };
}
