# FairShift AI

**Fair, explainable tips for hospitality workers — powered by PayPal and AI.**

A manager closes a service; FairShift flags missing hours, splits the tip pool under a written, versioned tipping policy, and pays every worker through **PayPal Payouts**. Workers can ask *"Why was I paid less this Friday than last Friday?"* and get an answer grounded in their real hours, the policy, and their PayPal payout records.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). UK context: the Employment (Allocation of Tips) Act 2023 requires employers who handle tips to allocate them fairly, keep a written policy and keep records — FairShift produces that audit trail.

> **Status: Milestone 2.** Manager dashboard, tip engine and approved sandbox payouts are built. The worker view and AI assistant are next — see [TASKS.md](TASKS.md).

## What works today
- **Deterministic tip engine** — minutes worked × role weight under a written, versioned policy; whole pence; leftover pennies to the largest remainders; always sums exactly to the pool. Blocks if hours are missing.
- **Manager dashboard** — shifts, tip pools, policy versions, missing-hours warnings, audited hour corrections, and an AG Grid allocation preview.
- **Approval workflow** — lock the allocation, then approve with a server-checked approval code. Payouts go to PayPal Payouts (sandbox) as one idempotent batch per shift.
- **Per-worker payment status** — "Refresh status" reads each payout item from PayPal; a worker shows as **Paid** only when their own item reports SUCCESS.

## Design principles
- **The AI never touches the money.** All tip maths is deterministic, integer-pence code with unit tests. The AI reads records through tools and explains them.
- **Every payout needs a manager's approval** and is idempotent (`sender_batch_id` + `PayPal-Request-Id`).
- **Per-worker payment status.** An accepted batch isn't treated as "paid" — each payout item's PayPal status is tracked.

## Tech stack
Next.js 16 · TypeScript · Tailwind + shadcn/ui · Drizzle ORM · Supabase Postgres · PayPal REST (Payouts v1, Webhooks; Orders v2 planned) · OpenAI (planned) · Render · Vitest

## PayPal APIs used
| API | Use | Status |
|---|---|---|
| OAuth2 | client-credentials token, cached | ✅ built |
| Payouts v1 | batch payouts to workers; per-item status lookups | ✅ £1.00 sandbox payout verified · dashboard flow built |
| Webhooks | signature verification + duplicate-safe event storage | 🟡 verification built; applying events to payouts is next (manual Refresh status works now) |
| Orders v2 | funding the tip pool | ⬜ planned |

## AI tools used
*To be completed in Milestone 3* (OpenAI tool calling, read-only tools listed in [SPEC.md §6](SPEC.md)). This project is also being built with Claude Code as a coding assistant.

## ⚠️ Demo mode & limitations
This is a hackathon demo, not production software.
- **No real authentication.** A "View as" role switcher is a demo convenience. Financial endpoints enforce their own server-side checks, independent of the role cookie.
- **Synthetic data only.** Every venue, worker and amount is fictional.
- **PayPal sandbox only.** The API base URL is hard-coded to the sandbox; `PAYPAL_ENV` other than `sandbox` is refused. No real money can move.
- **Allowlisted recipients.** Payouts only go to sandbox emails in `PAYPAL_SANDBOX_RECIPIENTS`, with per-item (default £200) and per-batch (default £1,000) caps, plus hard ceilings no setting can raise.
- **Idempotent payouts.** Retrying with the same `sender_batch_id` returns the original batch rather than paying twice.
- **Reset is safe.** Reseeding the demo never calls PayPal and never repeats a transaction.
- **Payouts are off by default.** They need `PAYOUTS_ENABLED=true` *and* a server-checked `MANAGER_APPROVAL_CODE` (rate-limited). On the public demo they are switched off: anyone can explore, correct hours and calculate allocations, but nobody can pay.
- **Demo tip pools** are seeded amounts, labelled as such. They were not funded through PayPal Orders.
- **The approval rate limiter is in-memory** (fine for one server instance; resets on restart).
- **Webhook processing is incomplete** (see status above).

## For judges: running sandbox payouts yourself
The public demo has payouts disabled, and the approval code is never published. To try real sandbox payouts, run your own copy:
1. In the [PayPal Developer dashboard](https://developer.paypal.com) (Sandbox), create an app with **Payouts** enabled and 5 sandbox *personal* accounts.
2. Create a free Supabase project and copy its **session pooler** URI.
3. Set the environment variables from `.env.example` (locally in `.env.local`, or on Render):
   `DATABASE_URL`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_SANDBOX_RECIPIENTS` (your 5 sandbox emails), `PAYOUT_MAX_ITEM_PENCE=30000`, `PAYOUTS_ENABLED=true`, and a `MANAGER_APPROVAL_CODE` of your choice (12+ characters).
4. `npm install && npm run db:migrate && npm run db:seed && npm run build && npm start`
5. Open **Shifts → Fri 23 Oct** → **Save & lock** → enter your approval code → **Approve & pay** → **Refresh status**.

## Running it — no local install needed

### 1. Add GitHub secrets
Repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Value |
|---|---|
| `PAYPAL_CLIENT_ID` | Sandbox app client ID |
| `PAYPAL_CLIENT_SECRET` | Sandbox app secret |
| `PAYPAL_SANDBOX_RECIPIENTS` | Comma-separated sandbox personal emails (Sam, Priya, Jordan, Alex, Casey) |
| `DATABASE_URL` | Supabase **session pooler** URI (port 5432) |
| `PAYPAL_WEBHOOK_ID` | *(later, after deploying)* |

The app itself (e.g. on Render) also needs `PAYOUT_MAX_ITEM_PENCE=30000`, and — only where real sandbox payouts should be possible — `PAYOUTS_ENABLED=true` and `MANAGER_APPROVAL_CODE`.

### 2. Run integration tasks
Repo → **Actions → Integration (manual) → Run workflow**, choose a task:
- `paypal-check` — read-only check of auth, Payouts permission and API access. **Moves no money.**
- `paypal-test-payout` — sends one £1.00 **sandbox** payout. Does nothing unless **confirm_payout** is ticked. To retry safely, paste the `sender_batch_id` from the previous run's log into **batch_id**.
- `db-migrate` — applies the database schema. Run it after pulling a new migration (Milestone 2 adds `0001_milestone2.sql`).
- `db-seed` — loads synthetic demo data (no PayPal calls).

Open the run and click the job to read the output. Secrets are masked in logs.

### Local development (optional)
```bash
cp .env.example .env.local   # fill in values
npm install
npm run dev
npm run paypal:check
npm run paypal:test-payout -- --confirm
```

## Scripts
| Command | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm test` · `npm run lint` · `npm run typecheck` | Checks (also run by CI). `npm test` includes database integration tests on PGlite (in-process Postgres) — no credentials needed. They prove SQL and constraints, not the live Supabase setup. |
| `npm run db:generate` | Generate SQL migration from `lib/db/schema.ts` |
| `npm run db:migrate` · `npm run db:seed` | Apply schema · load demo data |
| `npm run paypal:check` | Read-only PayPal feasibility check |
| `npm run paypal:test-payout -- --confirm [--batch-id ID]` | One £1.00 sandbox payout |

## License
[MIT](LICENSE)
