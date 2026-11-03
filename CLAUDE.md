@AGENTS.md

# FairShift AI — rules for coding agents

Read `SPEC.md` (source of truth) and `TASKS.md` (current milestone) before writing code.
Do not silently change SPEC's architecture, financial rules, data model or security
requirements — propose the change and record it under "Amendments" in SPEC.md.

## Money rules (non-negotiable)
- The AI never calculates, approves or changes money. Arithmetic lives in `lib/tips/` and is unit-tested; the AI only explains tool results.
- Money is integer pence (`*_pence`). Use `lib/money.ts` for conversion/formatting. No floats.
- Hours are integer minutes; role weights are integer basis points (1.2 → 120).
- Payouts happen only after an explicit manager approval, through `createPayoutBatch`, which always runs `assertPayoutAllowed`.
- Every payout batch has a `sender_batch_id` generated once and reused on retry (also sent as `PayPal-Request-Id`).
- Track per-item payout status. A batch being accepted/SUCCESS does not mean every worker was paid.
- Never display a simulated or pending payment as paid.

## PayPal
- Sandbox only. The base URL is hard-coded; do not add a way to change it.
- App code imports PayPal only from `@/lib/paypal/server` (ESLint enforces this). Scripts may import the core modules directly.
- Recipients must be in `PAYPAL_SANDBOX_RECIPIENTS`.
- Webhooks must be signature-verified and stored idempotently by event id.
- Never log tokens, secrets or full emails (use `maskEmail`).

## Demo mode
- The role switcher is a demo convenience, NOT auth. Financial endpoints must enforce their own server-side checks.
- All data is synthetic. Seeding/reset must never call PayPal.

## Workflow
- Schema changes: edit `lib/db/schema.ts`, then `npm run db:generate`. Never hand-edit `/drizzle`.
- Before committing: `npm run lint && npm run typecheck && npm test && npm run build`.
- Update `TASKS.md` when a milestone task is done.
- Next.js here is v16 — check `node_modules/next/dist/docs/` before using unfamiliar APIs.
