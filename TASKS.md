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

## Milestone 3 — Worker dashboard, AI assistant, pay queries (Tue 3 Nov) ✅ built
- ✅ **Verified by user:** deployed at https://fairshift-ai.onrender.com/ with `PAYOUTS_ENABLED=false`
- ✅ Worker read model: blocked / provisional / allocated / paid / needs-review states; other workers never named
- ✅ Fixed-order counterfactual comparison (Sam −£111.69 = −£54.13 −£27.04 −£30.52), BigInt, exact
- ✅ Worker dashboard: earnings overview, this-Friday-vs-last-Friday card, shifts with breakdowns, payment history, pay queries, mobile layout
- ✅ AI assistant: OpenAI Responses API, 7 scoped read-only tools, structured output, fact ledger, answer validation, evidence cards
- ✅ Pay queries: proposal (AI) → Create draft (worker click) → Send to manager (worker click) → Accept / Not upheld / Resolve (manager); audited; one open query per shift
- ✅ Manager pay-query inbox with code-built evidence
- ✅ Limits + `AI_ENABLED` kill switch; ESLint bans PayPal imports in AI code
- ✅ Tests: 150+ (tools on PGlite, fake-model loop, validation, injection, scoping, duplicates, state machine)
- ✅ Local end-to-end run on real PostgreSQL with a mock Responses API (full Sam flow incl. manager inbox)
- 🟡 **Run `db-migrate`** in Actions (applies `0004_pay_queries_workflow.sql`)
- ↪ AI provider switched to Gemini free tier — see below
- ⬜ Webhook → payout item reconciliation (moved to Milestone 4)

## Gemini migration — free-tier AI (Tue 3 Nov) ✅ built, 🟡 not yet verified against real Gemini
- ✅ Gemini adapter (Chat Completions), thought-signature replay, schema dialect, explicit-rejection format fallback
- ✅ Strict answer-shape validation; fact ledger unchanged
- ✅ Free-tier limits: 5/min global, 100/day; friendly quota/auth errors; no automatic retries
- ✅ 18 new tests (168 total) incl. a full interaction over HTTP against a Gemini-like server that enforces thought signatures
- ✅ Local rehearsals: ai-smoke + ai-check pass against a Gemini-format mock; quota → INCONCLUSIVE; app route → friendly 429; 5/min cap
- ✅ **Verified by user:** real `ai-smoke` reached Gemini — auth, tool call, tool execution and thought signatures OK; verified-answer check FAILED (fallback shown, 6 calls / ~22.8k input tokens)
- ✅ Fix: self-verifying `[[fN|value]]` tokens, compact `compare_periods`, compare-only prompt, token list in retry, 4,096 token floor, per-attempt diagnostics (SPEC 32–34) + regression tests
- ✅ **Verified by user:** re-run on d63c749 crashed after ~6 s with only "AI service unavailable"
- ✅ Specific, sanitised provider error diagnostics + `ai-ping` connectivity task (SPEC 35–37) + regression tests
- ✅ **Verified by user:** `ai-ping` and `ai-smoke` both got HTTP 503 UNAVAILABLE ("high demand") from `gemini-3.1-flash-lite`
- ✅ Default model switched to `gemini-3.5-flash-lite` (SPEC 38)
- ✅ **Verified by user:** real `ai-smoke` PASSED on `gemini-3.5-flash-lite` (tool calling + thought signatures + verified answer)
- ✅ Verified by user: full `ai-check` hit HTTP 503 "high demand" after 3 good responses (provider capacity)
- ✅ Bounded 503 retries, busy message, /api/health AI settings, per-scenario ai-check outcomes (SPEC 39–42) + regression tests
- ✅ Local end-to-end Sam journey on a production build with real PostgreSQL and a Gemini-format MOCK (first request 503 → retried): correction → question → −£111.69 → extra hour → draft → sent → manager inbox with evidence. Not a live test.
- ✅ **Verified by user:** Render `/api/health` shows Gemini enabled with `gemini-3.5-flash-lite`
- ✅ **Verified by user:** live `/worker` crashes — Postgres 42703 `pay_queries.shift_assignment_id` missing (migration 0004 not applied to Supabase)
- ✅ `db-status` (read-only) + hardened `db-migrate` + regression tests (SPEC 43–45); fix rehearsed on real PostgreSQL from 0003 and 0001 states, all rows preserved
- 🟡 **Run `db-status` → `db-migrate` → `db-status`**, then reload https://fairshift-ai.onrender.com/worker (not yet verified live)
- ✅ **Verified by user:** live `/worker` loads after the migration
- ✅ **Verified by user (5 Nov):** dashboard compared 30 Oct with the future 6 Nov (£0) and counted its 5h 30m as worked
- ✅ Fix: clock-based completion (rota end, venue time), comparison eligibility, Gemini tool parity + regression tests (SPEC 46–48)
- ✅ **Verified by user:** live Gemini explanation and pay-query workflow
- ✅ Isolated Codespaces sandbox demo: local-only `demo:setup` (with Sam's accepted query), read-only `paypal:preflight`, banner, devcontainer, docs/SANDBOX_DEMO.md (SPEC 49–53). Rehearsed locally up to the Approve & pay form (not clicked; fake credentials)
- 🟡 Create Codespace + secrets → `demo:setup` → `paypal:preflight` (online) → share results
- 🟡 Real sandbox payout through the manager UI — **only after explicit approval**
- 🟡 Full `ai-check` again (or the unfinished scenarios only)
- 🟡 Render: set `GEMINI_MODEL=gemini-3.5-flash-lite` in the dashboard (existing services keep their old value)
- 🟡 **Run `ai-check`** (7 real scenarios)
- 🟡 **Render: add `GEMINI_API_KEY`, `AI_PROVIDER=gemini`, `GEMINI_MODEL`, `AI_DAILY_LIMIT=100`; remove OpenAI vars**

## Milestone 4 — Webhooks & corrections (Wed 4 – Sat 7 Nov)
- ⬜ Register PayPal webhook on the Render URL; apply verified item events (reuse reconciliation)
- ⬜ Separately authorised correction payouts linked to resolved pay queries

## Milestone 5 — Shift cover, Orders funding, polish (Sun 8 – Mon 9 Nov)
- ⬜ Cover suggestions; Orders v2 pool funding; AG Grid; Reset demo button

## Submission (Tue 10 – Thu 12 Nov)
- ⬜ README final, architecture diagram, video < 3 min, Devpost text, licence visible in About
