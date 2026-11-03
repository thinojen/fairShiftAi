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
- ✅ Fixed Payouts scope to PayPal's documented `https://uri.paypal.com/payments/payouts`; permission now decided only by the token's scopes (the 404 probe is reported as connectivity only)
- 🟡 **Re-run `paypal-check` in GitHub Actions** — auth, webhooks scope and 5 recipients confirmed; Payouts scope to re-verify after the fix
- 🟡 **Run `paypal-test-payout` with confirm** — PayPal integration is unproven until this succeeds
- 🟡 **Run `db-migrate` then `db-seed`** (needs `DATABASE_URL` secret)
- ⬜ Webhook → `payouts` status updates (route stores events but does NOT apply them yet)

## Milestone 2 — Tip engine & manager payouts (Wed 4 – Thu 5 Nov)
- ⬜ `lib/tips/engine.ts` (minutes × weight, largest remainder) + tests from SPEC §5
- ⬜ Role switcher (demo mode) + server-side guard for manager-only actions
- ⬜ Manager close-shift flow → allocations → Approve & Pay → Payouts batch
- ⬜ Apply webhook events to payout items; status chips in UI
- ⬜ Deploy to Render; register webhook; set `PAYPAL_WEBHOOK_ID`

## Milestone 3 — Worker view & AI explanations (Fri 6 Nov)
- ⬜ Worker earnings + shift breakdown
- ⬜ AI chat with read-only tools (SPEC §6); "why was I paid less" end-to-end

## Milestone 4 — Flags & pay queries (Sat 7 Nov)
- ⬜ Missing-hours detection; pay query flow; correction payout

## Milestone 5 — Shift cover, Orders funding, polish (Sun 8 – Mon 9 Nov)
- ⬜ Cover suggestions; Orders v2 pool funding; AG Grid; Reset demo button

## Submission (Tue 10 – Thu 12 Nov)
- ⬜ README final, architecture diagram, video < 3 min, Devpost text, licence visible in About
