/**
 * Provider-neutral AI errors. The API route turns these into friendly messages;
 * nothing is ever shown that pretends an answer was generated.
 *
 * Diagnostics (`details`, `describeProviderError`) are for server logs and the
 * ai-check / ai-ping scripts only. They are built from an allowlist of safe
 * fields — HTTP status, Google's status code, a sanitised and truncated provider
 * message, timeout flag, stage, request counts and request SHAPE (never request
 * or response bodies, headers, keys or tokens).
 */

export type AiErrorKind =
  | "auth" // authentication / permission
  | "quota" // 429 / RESOURCE_EXHAUSTED
  | "bad_request" // 400 — our request was rejected
  | "model_unavailable" // 404 / model not found or not supported
  | "server" // 5xx or an empty/invalid response from the provider
  | "network" // no HTTP response: DNS, refused, reset, TLS, timeout
  | "internal"; // a bug on OUR side while building/parsing (not an HTTP error)

export const KIND_LABEL: Record<AiErrorKind, string> = {
  auth: "authentication",
  quota: "quota",
  bad_request: "invalid request",
  model_unavailable: "model unavailable",
  server: "server error",
  network: "network failure",
  internal: "internal adapter error (not an HTTP error from the provider)",
};

export type AiErrorDetails = {
  /** Google's status string, e.g. NOT_FOUND, UNAVAILABLE (or a socket code like ECONNRESET). */
  providerCode?: string;
  /** Provider message with keys/tokens/emails redacted, max 160 chars. */
  providerMessage?: string;
  timedOut?: boolean;
  /** Which step of the interaction failed, e.g. "initial request", "follow-up after tool results". */
  stage?: string;
  /** Successful provider requests in this interaction before the failure. */
  requestsCompleted?: number;
  /** Shape of the failing request only (model, counts, flags) — never content. */
  request?: string;
};

export class AiProviderError extends Error {
  name = "AiProviderError";
  details: AiErrorDetails;
  constructor(
    message: string,
    readonly kind: AiErrorKind,
    readonly status?: number,
    details: AiErrorDetails = {},
  ) {
    super(message);
    this.details = { ...details };
  }
}

/** Redact anything secret-looking and cap the length. */
export function sanitiseProviderText(text: string, max = 160): string {
  return text
    .replace(/AIza[0-9A-Za-z_-]{10,}/g, "[key]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&\s"']+/gi, "$1[redacted]")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")
    .replace(/\b(?:sk|pk|ya29)[-_.][\w.-]{8,}/g, "[token]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

const NET_CODES = /^(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|EPIPE|ETIMEDOUT|CERT_\w+|UNABLE_TO_\w+|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UND_ERR_\w+)$/;
const TIMEOUT_CODES = /^(?:ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/;

/** Walk err.cause (bounded) to find a socket/TLS error code. */
function causeCode(err: unknown): string | undefined {
  let c: unknown = err;
  for (let i = 0; i < 5 && c; i++) {
    const code = (c as { code?: unknown }).code;
    if (typeof code === "string" && NET_CODES.test(code)) return code;
    c = (c as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Google's status string from the error body (works for Gemini's array-shaped bodies too). */
function providerStatusCode(e: { error?: unknown; code?: unknown; type?: unknown }): string | undefined {
  const body = (() => {
    try {
      return JSON.stringify(e.error ?? "");
    } catch {
      return "";
    }
  })();
  const m = /"status"\s*:\s*"([A-Z_]{3,40})"/.exec(body);
  if (m) return m[1];
  for (const v of [e.code, e.type]) if (typeof v === "string" && /^[A-Za-z_]{3,40}$/.test(v)) return v;
  return undefined;
}

/** The provider's own message, from the body if present, sanitised. */
function providerMessage(e: { error?: unknown; message?: unknown }): string | undefined {
  let msg: string | undefined;
  try {
    const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(JSON.stringify(e.error ?? ""));
    if (m) msg = JSON.parse(`"${m[1]}"`) as string;
  } catch {
    /* ignore */
  }
  if (!msg && typeof e.message === "string") msg = e.message.replace(/^\d{3}\s+/, "");
  return msg ? sanitiseProviderText(msg) : undefined;
}

/** Classify an SDK/HTTP error without leaking provider details to users. */
export function classifyProviderError(err: unknown): AiProviderError {
  if (err instanceof AiProviderError) return err;
  const e = (err ?? {}) as { status?: unknown; message?: unknown; error?: unknown; code?: unknown; type?: unknown; name?: unknown };
  const status = typeof e.status === "number" ? e.status : undefined;
  // The OpenAI SDK leaves .name as "Error"; its class name identifies the error type.
  const ctor = (err as { constructor?: { name?: unknown } } | null)?.constructor?.name;
  const name = typeof ctor === "string" && ctor !== "Error" && ctor !== "Object" ? ctor : typeof e.name === "string" ? e.name : "";
  const code = providerStatusCode(e);
  const pmsg = providerMessage(e);
  const text = `${typeof e.message === "string" ? e.message : ""} ${code ?? ""} ${pmsg ?? ""}`;
  const base = { providerCode: code, providerMessage: pmsg, timedOut: false };

  // No HTTP response at all: timeout or network.
  if (status === undefined) {
    const sock = causeCode(err);
    const timedOut = name === "APIConnectionTimeoutError" || name === "TimeoutError" || (sock !== undefined && TIMEOUT_CODES.test(sock)) || /timed? ?out/i.test(text);
    if (timedOut) return new AiProviderError("AI request timed out", "network", undefined, { ...base, providerCode: sock ?? code, timedOut: true });
    if (name === "APIConnectionError" || sock || /fetch failed|connection error|socket hang up|network/i.test(text)) {
      return new AiProviderError("AI service unreachable (network)", "network", undefined, { ...base, providerCode: sock ?? code });
    }
    if (!name.startsWith("API")) {
      // Not from the HTTP client: a bug or unexpected data on our side.
      return new AiProviderError("AI adapter error", "internal", undefined, { providerCode: name || typeof err, providerMessage: pmsg, timedOut: false });
    }
  }

  if (status === 429 || code === "RESOURCE_EXHAUSTED" || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(text)) {
    return new AiProviderError("AI quota exhausted", "quota", status, base);
  }
  if (status === 401 || status === 403 || code === "UNAUTHENTICATED" || code === "PERMISSION_DENIED" || /API key not valid|API_KEY_INVALID|PERMISSION_DENIED|unauthenticated/i.test(text)) {
    return new AiProviderError("AI credentials rejected", "auth", status, base);
  }
  if (status === 404 || code === "NOT_FOUND" || /\bmodels?\/?\S* (?:is )?not found|not supported for generateContent|unexpected model name|model .*(?:does not exist|not available)/i.test(text)) {
    return new AiProviderError("AI model not available", "model_unavailable", status, base);
  }
  if (status === 400 || code === "INVALID_ARGUMENT" || code === "FAILED_PRECONDITION") {
    return new AiProviderError(`AI request rejected: ${pmsg ?? ""}`.trim(), "bad_request", status, base);
  }
  if ((status !== undefined && status >= 500) || code === "UNAVAILABLE" || code === "INTERNAL" || code === "DEADLINE_EXCEEDED") {
    return new AiProviderError("AI service error", "server", status, { ...base, timedOut: code === "DEADLINE_EXCEEDED" || status === 504 });
  }
  if (status !== undefined && status >= 400) return new AiProviderError("AI request rejected", "bad_request", status, base);
  return new AiProviderError("AI service error", "server", status, base);
}

const HINTS: Record<AiErrorKind, string> = {
  auth: "Check the GEMINI_API_KEY secret (a key from Google AI Studio for the right project).",
  quota: "Free-tier quota or rate limit hit. Not a pass or a code failure; wait for the reset and run again.",
  bad_request: "Gemini rejected the request format. The provider message above says which field.",
  model_unavailable: "Check GEMINI_MODEL (repository variable) is an exact model id available to this key, e.g. gemini-3.1-flash-lite.",
  server: "Gemini returned a server error (often temporary overload). Run again later; if it persists, try the ai-ping task.",
  network: "No HTTP response from Gemini (network/DNS/TLS/timeout). Usually transient; run ai-ping to confirm connectivity.",
  internal: "The failure happened in our adapter, not at Gemini. This is a code bug to fix.",
};

/** Safe, multi-line diagnostic for logs/scripts. Never includes keys, headers or bodies. */
export function describeProviderError(err: unknown): string[] {
  const e = classifyProviderError(err);
  const d = e.details;
  const lines = [
    `category: ${KIND_LABEL[e.kind]}${e.status !== undefined ? ` (HTTP ${e.status})` : " (no HTTP response)"}`,
    `provider code: ${d.providerCode ?? "none"}`,
    `provider message (sanitised): ${d.providerMessage ?? "none"}`,
    `timed out: ${d.timedOut ? "yes" : "no"}`,
    `stage: ${d.stage ?? "unknown"}`,
    `requests completed before the error: ${d.requestsCompleted ?? "unknown"}`,
  ];
  if (d.request) lines.push(`failing request shape: ${d.request}`);
  lines.push(`hint: ${HINTS[e.kind]}`);
  return lines;
}
