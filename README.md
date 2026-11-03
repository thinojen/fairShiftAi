# FairShift AI

**Fair, explainable tips for hospitality workers — powered by PayPal and AI.**

A manager closes a service; FairShift flags missing hours, splits the tip pool under a written, versioned tipping policy, and pays every worker through **PayPal Payouts**. Workers can ask *"Why was I paid less this Friday than last Friday?"* and get an answer grounded in their real hours, the policy, and their PayPal payout records.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). UK context: the Employment (Allocation of Tips) Act 2023 requires employers who handle tips to allocate them fairly, keep a written policy and keep records — FairShift produces that audit trail.

> **Status: Milestone 1 (foundation).** Dashboards and the AI assistant are in progress — see [TASKS.md](TASKS.md).

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
| Payouts v1 | batch payouts to workers; per-item status lookups | ✅ built — sandbox test pending |
| Webhooks | signature verification + duplicate-safe event storage | 🟡 verification built; applying events to payouts not yet implemented |
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
- **Webhook processing is incomplete** (see status above).

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

### 2. Run integration tasks
Repo → **Actions → Integration (manual) → Run workflow**, choose a task:
- `paypal-check` — read-only check of auth, Payouts permission and API access. **Moves no money.**
- `paypal-test-payout` — sends one £1.00 **sandbox** payout. Does nothing unless **confirm_payout** is ticked. To retry safely, paste the `sender_batch_id` from the previous run's log into **batch_id**.
- `db-migrate` — applies the database schema.
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
| `npm test` · `npm run lint` · `npm run typecheck` | Checks (also run by CI) |
| `npm run db:generate` | Generate SQL migration from `lib/db/schema.ts` |
| `npm run db:migrate` · `npm run db:seed` | Apply schema · load demo data |
| `npm run paypal:check` | Read-only PayPal feasibility check |
| `npm run paypal:test-payout -- --confirm [--batch-id ID]` | One £1.00 sandbox payout |

## License
[MIT](LICENSE)
