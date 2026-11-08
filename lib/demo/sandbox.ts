/**
 * Isolated PayPal-sandbox demo environment (GitHub Codespaces / a laptop).
 *
 *  - isLocalDatabaseUrl: the demo tools refuse any database that isn't on this
 *    machine, so they can never touch the production Supabase database.
 *  - runDemoSetup: seeds synthetic data and brings Sam's story to the point
 *    where the manager's correction follows the accepted pay query — using the
 *    app's own commands (audited), never hand-written rows.
 *  - runPreflight: READ-ONLY checks before any payout. It never creates a
 *    payout and never writes to the database.
 */
import { and, count, eq, sql } from "drizzle-orm";
import type { Db } from "../db/connect";
import * as s from "../db/schema";
import { seedDemo } from "../db/seed";
import { DEMO_WORKERS } from "../db/seed-data";
import { penceToDecimalString } from "../money";
import { payoutAvailability } from "../payouts/approval";
import { loadPayPalConfig, maskEmail, PAYPAL_SANDBOX_BASE_URL, PayPalConfigError, type PayPalConfig } from "../paypal/config";
import { assertPayoutAllowed, PayoutGuardError, type PayoutItemInput } from "../paypal/guards";
import { createPayQueryDraft, reviewPayQuery, submitPayQuery } from "../payqueries/commands";
import { correctAssignmentTime } from "../shifts/commands";
import { getShiftReview } from "../shifts/queries";
import { demoBannerLabel } from "./banner";

type Env = Record<string, string | undefined>;

export const DEMO_SHIFT_ID = "sh_2026-10-30_dinner";
const SAM_1030 = "sa_1030_sam";
const MANAGER = "demo-manager";

// ---------------------------------------------------------------------------
// Local-only guard

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** True only for a postgres:// URL whose HOST is this machine (not a user/password trick). */
export function isLocalDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return false;
  return LOCAL_HOSTS.has(u.hostname.toLowerCase());
}

export class DemoEnvError extends Error {
  name = "DemoEnvError";
}

/** A plain-English reason for a failed demo command (never prints the database URL). */
export function explainDemoError(e: unknown): string {
  if (e instanceof DemoEnvError) return e.message;
  let c: unknown = e;
  for (let i = 0; i < 5 && c; i++) {
    const code = (c as { code?: unknown }).code;
    if (code === "ECONNREFUSED") return "Can't connect to the local demo database. Start it with: npm run demo:db";
    if (code === "42P01") return "The demo tables don't exist yet. Run: npm run demo:setup";
    c = (c as { cause?: unknown }).cause;
  }
  const msg = e instanceof Error ? ((e as { cause?: Error }).cause?.message ?? e.message) : String(e);
  return msg.replace(/postgres(ql)?:\/\/[^\s]+/g, "[database url]");
}

export function assertLocalDatabase(url: string | undefined) {
  if (!isLocalDatabaseUrl(url)) {
    throw new DemoEnvError(
      "Refusing to run: DATABASE_URL is not a local database (localhost / 127.0.0.1). " +
        "The demo tools only work on the throwaway database inside this Codespace — never on Supabase.",
    );
  }
}


// ---------------------------------------------------------------------------
// Setup

export type DemoQueryState = "none" | "submitted" | "accepted";

/**
 * Brings a FRESH local database to the demo's starting point:
 *  1. synthetic seed (sandbox recipients from PAYPAL_SANDBOX_RECIPIENTS, in worker order)
 *  2. Sam's missing 30 Oct clock-out corrected to the rota end (23:30) — as on the public site
 *  3. Sam's pay query "+1 hour" → submitted → (optionally) accepted by the manager
 * Every step goes through the app's normal, audited commands. No AI summary is
 * invented (it stays empty); no payout is created.
 */
export async function runDemoSetup(db: Db, opts: { recipientsCsv: string | undefined; query?: DemoQueryState }) {
  const query = opts.query ?? "accepted";
  const [{ n }] = await db.select({ n: count() }).from(s.workers);
  if (n > 0) {
    throw new DemoEnvError("This database already has demo data. For a fresh take, reset the local database first (npm run demo:db:reset).");
  }
  await seedDemo(db, { recipientsCsv: opts.recipientsCsv });

  await correctAssignmentTime(db, {
    assignmentId: SAM_1030,
    field: "clock_out",
    value: "2026-10-30T23:30:00Z",
    reason: "No clock-out recorded; set to rota end",
    actor: MANAGER,
  });

  let queryId: string | null = null;
  if (query !== "none") {
    const draft = await createPayQueryDraft(db, "w_sam", {
      shiftAssignmentId: SAM_1030,
      field: "clock_out",
      adjustMinutes: 60,
      workerStatement: "But I actually worked an extra hour!",
      aiSummary: null,
    });
    await submitPayQuery(db, "w_sam", draft.id);
    if (query === "accepted") await reviewPayQuery(db, draft.id, "accepted", MANAGER);
    queryId = draft.id;
  }
  return { queryId, query };
}

// ---------------------------------------------------------------------------
// Preflight (read-only)

export type CheckResult = { name: string; status: "pass" | "fail" | "info"; detail: string };

export type PreflightOutput = {
  checks: CheckResult[];
  manual: string[];
  items: Array<{ worker: string; email: string; amount: string }>;
  totalPence: number | null;
  ok: boolean;
};

/** Optional live sandbox credential check (OAuth token only — moves no money). */
export type TokenProbe = (cfg: PayPalConfig) => Promise<{ scopes: string[] }>;

export async function runPreflight(db: Db, env: Env, probe?: TokenProbe): Promise<PreflightOutput> {
  const checks: CheckResult[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, status: ok ? "pass" : "fail", detail });
  const info = (name: string, detail: string) => checks.push({ name, status: "info", detail });

  // 1. This environment
  add("Database is local (not Supabase)", isLocalDatabaseUrl(env.DATABASE_URL), isLocalDatabaseUrl(env.DATABASE_URL) ? "DATABASE_URL points at this machine" : "DATABASE_URL is not local");
  add("Demo banner set", Boolean(demoBannerLabel(env)), demoBannerLabel(env) ? `"${demoBannerLabel(env)}"` : "DEMO_ENV_LABEL is empty — the video wouldn't show which environment it is");

  // 2. PayPal sandbox configuration
  let cfg: PayPalConfig | null = null;
  try {
    cfg = loadPayPalConfig(env);
    add("PayPal API is the SANDBOX", cfg.baseUrl === PAYPAL_SANDBOX_BASE_URL, `${cfg.baseUrl} (hard-coded; no setting can change it)`);
  } catch (e) {
    add("PayPal configuration loads", false, e instanceof PayPalConfigError ? e.message : "PayPal configuration error");
  }
  if (cfg && probe) {
    try {
      const t = await probe(cfg);
      add("Sandbox credentials accepted by PayPal sandbox", true, "OAuth token issued by api-m.sandbox.paypal.com (live credentials would be refused here)");
      const hasPayouts = t.scopes.includes("https://uri.paypal.com/payments/payouts");
      add("Token has the Payouts permission", hasPayouts, hasPayouts ? "https://uri.paypal.com/payments/payouts" : "Enable Payouts for this sandbox app in the PayPal Developer Dashboard");
    } catch {
      add("Sandbox credentials accepted by PayPal sandbox", false, "Could not get a sandbox token — check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET (sandbox app)");
    }
  } else if (cfg) {
    info("Sandbox credentials (online check)", "Skipped (--offline)");
  }

  // 3. App payout gate (values never printed)
  const gate = payoutAvailability(env);
  add("Payouts enabled in THIS environment only", gate.enabled, gate.enabled ? "PAYOUTS_ENABLED=true, approval code ≥ 12 chars, PayPal credentials present" : gate.reason);

  // 4. Recipients: every worker on the demo shift
  const allow = cfg?.recipientAllowlist ?? new Set<string>();
  const workers = await db.select({ id: s.workers.id, name: s.workers.name, email: s.workers.paypalEmail }).from(s.workers);
  add("Demo data present", workers.length === DEMO_WORKERS.length, `${workers.length} worker(s) in the local database`);
  const assigned = await db
    .select({ workerId: s.shiftAssignments.workerId })
    .from(s.shiftAssignments)
    .where(and(eq(s.shiftAssignments.shiftId, DEMO_SHIFT_ID), sql`${s.shiftAssignments.workerId} is not null`));
  const onShift = workers.filter((w) => assigned.some((a) => a.workerId === w.id));
  for (const w of onShift) {
    const ok = allow.has(w.email.trim().toLowerCase());
    add(`Recipient allowlisted: ${w.name}`, ok, ok ? maskEmail(w.email) : `${maskEmail(w.email)} is not in PAYPAL_SANDBOX_RECIPIENTS (needs ${DEMO_WORKERS.length} addresses, in worker order)`);
  }
  const distinct = new Set(onShift.map((w) => w.email.toLowerCase())).size;
  if (onShift.length && distinct < onShift.length) {
    info("Shared recipient accounts", `${onShift.length} workers use ${distinct} distinct sandbox account(s) — allowed, payments land in the same sandbox wallet`);
  }

  // 5. The batch Approve & pay would send (computed by the engine; nothing sent)
  const items: PreflightOutput["items"] = [];
  let totalPence: number | null = null;
  const review = await getShiftReview(db, DEMO_SHIFT_ID);
  if (!review) {
    add("Demo shift exists", false, `${DEMO_SHIFT_ID} not found`);
  } else if (review.batch) {
    add("No payout yet for the demo shift (idempotency)", false, `A batch already exists (status ${review.batch.status}). It will never be re-created; use Refresh status, or reset the local database for a fresh take.`);
  } else {
    add("No payout yet for the demo shift (idempotency)", true, "Approve & pay will create exactly one batch; its sender_batch_id is reused on any retry");
    const source = review.saved.length ? "saved (locked) allocation" : "allocation preview — what Save & lock would store now";
    const preview = review.preview;
    const rows: Array<{ workerId: string; sharePence: number; id: string }> = review.saved.length
      ? review.saved.map((a) => ({ workerId: a.workerId, sharePence: a.sharePence, id: a.id }))
      : preview && preview.ok
        ? preview.workers.map((w) => ({ workerId: w.workerId, sharePence: w.sharePence, id: `preview_${w.workerId}` }))
        : [];
    if (!rows.length) {
      add("Allocation can be calculated", false, "The shift is blocked (incomplete hours) — fix it before paying");
    } else {
      const payable = rows.filter((r) => r.sharePence > 0);
      const batch: PayoutItemInput[] = payable.map((r) => ({
        senderItemId: r.id,
        receiverEmail: workers.find((w) => w.id === r.workerId)?.email ?? "",
        amountPence: r.sharePence,
        note: "preflight dry run",
      }));
      totalPence = batch.reduce((n, i) => n + i.amountPence, 0);
      payable.forEach((r, k) => {
        const w = workers.find((x) => x.id === r.workerId);
        items.push({ worker: w?.name ?? "?", email: maskEmail(batch[k].receiverEmail), amount: `£${penceToDecimalString(batch[k].amountPence)}` });
      });
      info("Batch source", source);
      if (cfg) {
        try {
          assertPayoutAllowed(cfg, "fs_preflight_dry_run", batch);
          add(
            "Batch passes the payout guards (dry run — nothing sent)",
            true,
            `${batch.length} item(s), total £${penceToDecimalString(totalPence)} ≤ batch cap £${penceToDecimalString(cfg.maxBatchPence)}; largest £${penceToDecimalString(Math.max(...batch.map((i) => i.amountPence)))} ≤ item cap £${penceToDecimalString(cfg.maxItemPence)}`,
          );
        } catch (e) {
          add("Batch passes the payout guards (dry run — nothing sent)", false, e instanceof PayoutGuardError ? e.message : "guard error");
        }
      }
      info("Lock before paying", review.shift.status === "open" ? "Shift is open: Approve & pay is refused until you click Save & lock" : `Shift is ${review.shift.status}`);
    }
  }

  // 6. Payment-history protections are installed
  const trig = (await db.execute(sql`select count(*)::int as n from pg_trigger where tgname in ('payouts_no_delete','payout_batches_no_delete','audit_log_no_delete','pay_queries_no_delete')`)) as unknown as { rows?: Array<{ n: number }> } | Array<{ n: number }>;
  const nTrig = Number((Array.isArray(trig) ? trig : (trig.rows ?? []))[0]?.n ?? 0);
  add("Payment history & audit log are delete-protected", nTrig === 4, `${nTrig}/4 protection triggers present`);
  const idx = (await db.execute(sql`select count(*)::int as n from pg_indexes where indexname = 'payout_batches_one_per_shift'`)) as unknown as { rows?: Array<{ n: number }> } | Array<{ n: number }>;
  const nIdx = Number((Array.isArray(idx) ? idx : (idx.rows ?? []))[0]?.n ?? 0);
  add("One payout batch per shift (unique index)", nIdx === 1, nIdx === 1 ? "payout_batches_one_per_shift present" : "index missing");

  // 7. Optional extras
  info("Gemini assistant", env.GEMINI_API_KEY ? "API key present (optional for the payout demo)" : "No GEMINI_API_KEY — the assistant will be switched off here (record Gemini on the public site)");

  const manual = [
    "In the PayPal Developer Dashboard (Testing Tools → Sandbox Accounts), each recipient address is a sandbox account of type PERSONAL. An address that isn't a real sandbox account comes back UNCLAIMED (shown as Needs review, never Paid).",
    "Recipients can receive GBP (UK sandbox personal accounts are simplest).",
    `The sandbox BUSINESS account for these API credentials has an available balance of at least ${totalPence !== null ? `£${penceToDecimalString(totalPence)}` : "the batch total"} (or the USD equivalent).`,
    "Port 3000 is Private in the Codespace's PORTS tab (it is by default — never change it to Public).",
    "You will type the manager approval code yourself on screen; it is a password field. Don't show the Codespaces secrets page in the recording.",
  ];

  const ok = checks.every((c) => c.status !== "fail");
  return { checks, manual, items, totalPence, ok };
}
