/**
 * Minimal typed PayPal REST client (fetch-based, no SDK).
 * Never logs or returns the client secret or access token.
 */
import type { PayPalConfig } from "./config";

export type FetchLike = typeof fetch;

export class PayPalApiError extends Error {
  name = "PayPalApiError";
  constructor(
    message: string,
    readonly status: number,
    readonly paypalName: string | undefined,
    readonly debugId: string | undefined,
    readonly details: unknown,
  ) {
    super(message);
  }
}

type TokenInfo = { accessToken: string; expiresAt: number; scopes: string[]; appId?: string };

export type PayPalResponse<T> = { status: number; data: T; debugId: string | undefined };

export class PayPalClient {
  private token: TokenInfo | undefined;

  constructor(
    private readonly cfg: PayPalConfig,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  get baseUrl() {
    return this.cfg.baseUrl;
  }

  /** OAuth2 client-credentials token, cached until 60s before expiry. */
  async getToken(): Promise<Omit<TokenInfo, "accessToken"> & { accessToken: string }> {
    if (this.token && this.token.expiresAt - 60_000 > this.now()) return this.token;

    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString("base64");
    const res = await this.fetchImpl(`${this.cfg.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: "grant_type=client_credentials",
      signal: AbortSignal.timeout(20_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new PayPalApiError(
        `PayPal authentication failed (${res.status}): ${String(body.error_description ?? body.error ?? "unknown error")}`,
        res.status,
        typeof body.error === "string" ? body.error : undefined,
        res.headers.get("paypal-debug-id") ?? undefined,
        undefined, // never echo the auth response body
      );
    }
    this.token = {
      accessToken: String(body.access_token),
      expiresAt: this.now() + Number(body.expires_in ?? 0) * 1000,
      scopes: String(body.scope ?? "").split(" ").filter(Boolean),
      appId: typeof body.app_id === "string" ? body.app_id : undefined,
    };
    return this.token;
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: { body?: unknown; requestId?: string } = {},
  ): Promise<PayPalResponse<T>> {
    const { accessToken } = await this.getToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    // PayPal-Request-Id makes POSTs idempotent: a retry returns the original result.
    if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;

    const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(30_000),
    });
    const debugId = res.headers.get("paypal-debug-id") ?? undefined;
    const text = await res.text();
    const data = text ? (JSON.parse(text) as unknown) : undefined;

    if (!res.ok) {
      const err = (data ?? {}) as { name?: string; message?: string; details?: unknown };
      throw new PayPalApiError(
        `PayPal ${method} ${path} failed (${res.status}${err.name ? ` ${err.name}` : ""}): ${err.message ?? "no message"}`,
        res.status,
        err.name,
        debugId,
        err.details,
      );
    }
    return { status: res.status, data: data as T, debugId };
  }
}
