/**
 * Provider-neutral AI errors. The API route turns these into friendly messages;
 * nothing is ever shown that pretends an answer was generated.
 */
export class AiProviderError extends Error {
  name = "AiProviderError";
  constructor(
    message: string,
    readonly kind: "quota" | "auth" | "unavailable" | "bad_request",
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Classify an SDK/HTTP error without leaking provider details to users. */
export function classifyProviderError(err: unknown): AiProviderError {
  if (err instanceof AiProviderError) return err;
  const e = err as { status?: number; message?: string; error?: unknown; code?: string | null };
  const status = typeof e?.status === "number" ? e.status : undefined;
  const text = `${e?.message ?? ""} ${JSON.stringify(e?.error ?? "")} ${e?.code ?? ""}`;
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(text)) {
    return new AiProviderError("AI quota exhausted", "quota", status);
  }
  if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID|PERMISSION_DENIED|unauthenticated/i.test(text)) {
    return new AiProviderError("AI credentials rejected", "auth", status);
  }
  if (status === 400) return new AiProviderError(`AI request rejected: ${String(e?.message ?? "").slice(0, 200)}`, "bad_request", status);
  return new AiProviderError("AI service unavailable", "unavailable", status);
}
