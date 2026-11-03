/**
 * Spending and abuse limits for the public assistant. Best-effort: counters are
 * in memory, so they reset when the server restarts (documented).
 *
 * Keys are the client IP AND a fixed global key — switching the demo worker
 * does not reset anything.
 */
import { providerConfig } from "./providers";

type Env = Record<string, string | undefined>;

export const LIMITS = {
  maxMessageChars: 500,
  maxHistoryMessages: 8,
  maxHistoryChars: 6000,
  maxToolRounds: 6,
  maxToolCalls: 10,
  maxOutputTokens: 1200,
  perClientPerWindow: 15,
  windowMs: 10 * 60_000,
  /** Free-tier protection: at most 5 questions per minute across ALL users. */
  globalPerMinute: 5,
};

/** UI helper: is the assistant usable on this server? (Details come from providers/index.ts.) */
export function aiAvailability(env: Env = process.env): { enabled: true; model: string; provider: string } | { enabled: false; reason: string } {
  const cfg = providerConfig(env);
  return cfg.ok ? { enabled: true, model: cfg.model, provider: cfg.provider } : { enabled: false, reason: cfg.reason };
}

export class UsageLimiter {
  private perClient = new Map<string, number[]>();
  private minute: number[] = [];
  private day = "";
  private dayCount = 0;

  constructor(
    private readonly dailyLimit: () => number,
    private readonly now: () => number = Date.now,
  ) {}

  check(clientKey: string): { allowed: true } | { allowed: false; message: string } {
    const t = this.now();
    const today = new Date(t).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.dayCount = 0;
    }
    if (this.dayCount >= this.dailyLimit()) {
      return { allowed: false, message: "The assistant has reached today's demo usage limit. Please try again tomorrow." };
    }
    this.minute = this.minute.filter((x) => t - x < 60_000);
    if (this.minute.length >= LIMITS.globalPerMinute) {
      return { allowed: false, message: "The assistant is busy. Please try again in a minute." };
    }
    const mine = (this.perClient.get(clientKey) ?? []).filter((x) => t - x < LIMITS.windowMs);
    if (mine.length >= LIMITS.perClientPerWindow) {
      return { allowed: false, message: "You've asked a lot of questions in a short time. Please wait a few minutes." };
    }
    mine.push(t);
    this.perClient.set(clientKey, mine);
    this.minute.push(t);
    this.dayCount++;
    return { allowed: true };
  }
}

export function dailyLimitFromEnv(env: Env = process.env) {
  const n = Number(env.AI_DAILY_LIMIT);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, 5000) : 100;
}

export const assistantLimiter = new UsageLimiter(() => dailyLimitFromEnv());
