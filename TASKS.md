# FairShift AI — Tasks

Deadline: **Thu 12 Nov 2026, 20:00 UK** (12:00 PST). Feature freeze: **Tue 10 Nov**.

Legend: ✅ done & verified · 🟡 built, needs external credentials to verify · ⬜ not started

## Milestone 1 — Foundation & payment feasibility (Tue 3 Nov)
- ✅ Next.js 16 + TypeScript + Tailwind v4 + shadcn/ui (button, card, badge)
- ✅ Drizzle schema (SPEC §4 + amendments) → generated migration `drizzle/0000_init.sql`
- ✅ Pooler-safe DB client (`prepare: false`)
- ✅ Repeatable synthetic seed with the Sam storyline (no PayPal calls; unit-tested)
- ✅ Sandbox-only PayPal client: OAuth caching, idempotent payouts, per-item status, guards
- ✅ `npm run paypal:check` (read-only) and `npm run paypal:test-payout -- --confirm`
- ✅ Webhook route: signature verification + duplicate-safe storage
- ✅ CI workflow + manual Integration workflow (GitHub Actions)
- ✅ Unit tests (27), typecheck, lint, production build all pass locally
- ✅ Fixed Payouts scope to PayPal's documented `https://uri.paypal.com/payments/payouts`
- ✅ **Verified by user (3 Nov):** sandbox auth, a real £1.00 sandbox payout (SUCCESS), Supabase migrate + seed via GitHub Actions
- ⬜ Webhook → `payouts` status updates (moved to Milestone 3; needs a public URL)

## Milestone 2 — Tip engine & manager payouts (Tue 3 Nov) ✅ built
- ✅ `lib/tips/engine.ts`: minutes × weight (BigInt-safe), largest remainder, blockers, traces (26 tests incl. Sam £266.46 / £154.77)
- ✅ `lib/tips/policy.ts` (version by date) and `lib/tips/flags.ts` (missing / suspicious hours)
- ✅ Schema M2 amendments + generated migration `0001_milestone2.sql` (see SPEC Amendments 8–15)
- ✅ Evidence-preserving hour corrections (append-only `time_corrections`, frozen originals)
- ✅ Save & lock allocation (server recalculation; traces + policy refs stored)
- ✅ Payout service: approval code, rate limit, kill switch, 3-phase transaction-safe batches, same-id retries
- ✅ Manual "Refresh status" reconciliation of per-item PayPal statuses (idempotent)
- ✅ Manager dashboard: overview, shifts, shift review (flags, corrections, AG Grid allocation, approval, payouts), staff, policy
- ✅ Demo role switcher (view-only gate; not auth); worker page placeholder
- ✅ PGlite integration tests (25) on the real migrations + seed
- ✅ Local end-to-end browser run (real server actions over the Postgres wire protocol; wrong codes only, no PayPal calls)
- 🟡 **Run `db-migrate` then `db-seed`** in GitHub Actions to apply `0001_milestone2.sql` to Supabase
- 🟡 Real sandbox payout through the UI — only in a controlled environment (not the public Render demo)
- 🟡 Live Supabase + live PayPal for the dashboard flow — untested until deployed

## Pre-deploy hardening (Tue 3 Nov) ✅
- ✅ **Verified by user:** `db-migrate` + `db-seed` (M2) on Supabase
- ✅ Payment history permanent: seed refuses when payouts exist, keeps audit log; FK RESTRICT; DELETE/TRUNCATE triggers (migrations 0002, 0003)
- ✅ Upgrade path rehearsed: DB at 0001 + seeded → apply 0002/0003 → data intact, triggers present
- ✅ Reconciliation checks batch identity, amount, currency and recipient; mismatches = "Needs review", never paid
- ✅ Single role-independent payout gate (`authorisePayout`)
- ✅ Render Blueprint, Node 22 pin, `/api/health`, security headers; production run rehearsed with the public config
- 🟡 **Run `db-migrate`** in Actions (applies 0002 + 0003). Do NOT run `db-seed` unless you want a fresh demo — it is safe, but not needed
- 🟡 **Deploy on Render** (README → "Deploying to Render")

## Milestone 3 — Webhooks, worker view & AI explanations (Wed 4 – Fri 6 Nov)
- ⬜ Register webhook on the Render URL; set `PAYPAL_WEBHOOK_ID`
- ⬜ Webhook → payout item reconciliation (verified, duplicate-safe; reuse `refreshShiftPayoutStatus` logic)
- ⬜ Worker earnings + shift breakdown
- ⬜ AI chat with read-only tools (SPEC §6); "why was I paid less" end-to-end

## Milestone 4 — Flags & pay queries (Sat 7 Nov)
- ⬜ Pay query flow; separately authorised correction payouts (missing-hours detection done in M2)

## Milestone 5 — Shift cover, Orders funding, polish (Sun 8 – Mon 9 Nov)
- ⬜ Cover suggestions; Orders v2 pool funding; AG Grid; Reset demo button

## Submission (Tue 10 – Thu 12 Nov)
- ⬜ README final, architecture diagram, video < 3 min, Devpost text, licence visible in About
