# FairShift AI

**Fair, explainable tips for hospitality workers — powered by PayPal and AI.**

A manager closes a service; FairShift flags missing hours, splits the tip pool under a written, versioned tipping policy, and pays every worker through **PayPal Payouts**. Workers can ask *"Why was I paid less this Friday than last Friday?"* and get an answer grounded in their real hours, the policy, and their PayPal payout records.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/). UK context: the Employment (Allocation of Tips) Act 2023 requires employers who handle tips to allocate them fairly, keep a written policy and keep records — FairShift produces that audit trail.

> **Status: Milestone 3.** Manager dashboard, tip engine, approved sandbox payouts, the worker dashboard and the AI assistant are built — see [TASKS.md](TASKS.md). Live demo: https://fairshift-ai.onrender.com/

## What works today
- **Deterministic tip engine** — minutes worked × role weight under a written, versioned policy; whole pence; leftover pennies to the largest remainders; always sums exactly to the pool. Blocks if hours are missing.
- **Manager dashboard** — shifts, tip pools, policy versions, missing-hours warnings, audited hour corrections, and an AG Grid allocation preview.
- **Approval workflow** — lock the allocation, then approve with a server-checked approval code. Payouts go to PayPal Payouts (sandbox) as one idempotent batch per shift.
- **Per-worker payment status** — "Refresh status" reads each payout item from PayPal; a worker shows as **Paid** only when their own item reports SUCCESS.
- **Worker dashboard** — earnings split into *Paid via PayPal*, *Allocated* (locked, not paid) and *Provisional* (may change); a "this Friday vs last Friday" breakdown; shift-by-shift explanations; payment history; pay queries.
- **AI assistant** — ask "Why were my tips lower last Friday?" or "Have I been paid?". It investigates your records with tools and explains — it never calculates, changes records or moves money.
- **AI-assisted pay queries** — say "I actually worked an extra hour" and the assistant prepares a query with evidence. *You* click to create the draft and to send it; the manager reviews it in an inbox.

## How the AI is kept honest
> **AI investigates and explains. Deterministic code calculates. Humans authorise. PayPal moves the money.**

1. **Tools, not guesses.** The assistant (OpenAI Responses API, server-side function calling) can only call 7 read-only tools: `get_worker_shifts`, `get_tip_pool`, `get_policy`, `get_allocation_breakdown`, `get_payout_status`, `compare_periods`, `create_pay_query` (builds a *proposal*; saves nothing). None take a worker id — the server scopes every call to the current demo worker.
2. **A fact ledger.** Every amount, time, status or PayPal id a tool returns is registered with the record it came from. The model must refer to values as `[[fact]]` placeholders in a structured answer.
3. **Answer validation.** Any raw money, percentage, duration, clock time, id — or a "you've been paid" claim without a successful PayPal payout — is rejected. One retry, then a safe fallback. The browser shows values from the ledger as highlighted chips, plus evidence cards built by code.
4. **Precomputed comparisons.** "Why did I earn less?" is answered from a fixed-order counterfactual computed in TypeScript (pool → your points → rest of team). For Sam: −£54.13, −£27.04, −£30.52 = −£111.69.
5. **Humans click.** Drafting and sending a pay query are explicit worker clicks; accepting/resolving are manager actions; none of them change hours or pay.
6. **Spending limits.** Per-IP and global rate limits, a daily cap (`AI_DAILY_LIMIT`), token/tool-call limits and an `AI_ENABLED` kill switch. These counters are in memory: best-effort, and they reset when Render restarts.

## Demo script — Sam's two Fridays
1. **View as → Sam.** Fri 30 Oct is **Blocked** (missing clock-out). Ask *"Why were my tips lower last Friday?"* — the assistant explains it can't compare yet.
2. **View as → Manager → Shifts → Fri 30 Oct → Fix hours** (clock-out 23:30, with a reason). Optionally **Save & lock** both Fridays.
3. **Back to Sam.** The card shows **−£111.69** (£266.46 → £154.77). Ask again — the assistant walks through the pool, hours and team changes, and says whether the figure is provisional or allocated (never "paid").
4. Say *"But I actually worked an extra hour!"* → the assistant prepares a pay query → **Create draft** → **Send to manager**.
5. **Manager → Pay queries** → review the evidence → **Accept** → correct the hours on the shift page → **Mark resolved**.

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
- **OpenAI Responses API** (`gpt-5.4-mini` by default, configurable) with server-side function calling and structured outputs — powers the worker assistant. See "How the AI is kept honest" above.
- **Claude Code** — used as a coding assistant to build the project.

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

## Deploying to Render
The repo includes a Render Blueprint (`render.yaml`) for the **public demo**: payouts are switched off, and no approval code is configured. See the step-by-step guide in this README's "Render step by step" section below.

| Variable | Public demo value | Notes |
|---|---|---|
| `DATABASE_URL` | Supabase **session pooler** URI (port 5432) | secret |
| `PAYPAL_SANDBOX_RECIPIENTS` | your 5 sandbox emails, comma-separated | only used to label allowlisted staff |
| `PAYOUTS_ENABLED` | `false` | set by the Blueprint |
| `PAYOUT_MAX_ITEM_PENCE` / `PAYOUT_MAX_BATCH_PENCE` | `30000` / `100000` | set by the Blueprint |
| `NODE_VERSION` | `22` | set by the Blueprint |
| `MANAGER_APPROVAL_CODE` | **do not set** | the public demo must not be able to pay |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | not needed yet | added in Milestone 4 for webhooks |
| `OPENAI_API_KEY` | your OpenAI key | **secret** — server-side only |
| `OPENAI_MODEL` | `gpt-5.4-mini` | set by the Blueprint |
| `AI_ENABLED` | `true` (`false` = kill switch) | set by the Blueprint |
| `AI_DAILY_LIMIT` | `200` | set by the Blueprint |

### Render step by step
1. Sign in at [render.com](https://render.com) with GitHub.
2. **New → Blueprint**, pick the `fairShiftAi` repository, and confirm the `render.yaml` it finds.
3. Render asks for the two secret values: paste `DATABASE_URL` and `PAYPAL_SANDBOX_RECIPIENTS`. Click **Apply**.
4. Wait for the build (a few minutes). When the service shows **Live**, open its `…onrender.com` URL.
5. Check `…onrender.com/api/health` shows `"payoutsEnabled": false`.

The free plan sleeps after inactivity, so the first page load can take up to a minute.

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
| `OPENAI_API_KEY` | for the `ai-check` task |

The app itself (e.g. on Render) also needs `PAYOUT_MAX_ITEM_PENCE=30000`, and — only where real sandbox payouts should be possible — `PAYOUTS_ENABLED=true` and `MANAGER_APPROVAL_CODE`.

### 2. Run integration tasks
Repo → **Actions → Integration (manual) → Run workflow**, choose a task:
- `paypal-check` — read-only check of auth, Payouts permission and API access. **Moves no money.**
- `paypal-test-payout` — sends one £1.00 **sandbox** payout. Does nothing unless **confirm_payout** is ticked. To retry safely, paste the `sender_batch_id` from the previous run's log into **batch_id**.
- `db-migrate` — applies the database schema. Run it after pulling a new migration (Milestone 2 adds `0001_milestone2.sql`).
- `db-seed` — loads synthetic demo data (no PayPal calls). Refuses once payment history or pay queries exist.
- `ai-check` — the **real OpenAI test**: runs 7 scenarios (blocked shift, provisional and locked comparisons, no payout, extra-hour claim, cross-worker request, prompt injection) on an **in-memory** database. Never touches Supabase or PayPal. Needs the `OPENAI_API_KEY` secret (optional repository *variable* `OPENAI_MODEL`).

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
| `npm run ai:check` | Real OpenAI assistant test on an in-memory database |

## License
[MIT](LICENSE)
