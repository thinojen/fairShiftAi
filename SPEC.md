# FairShift AI — Build Spec

> Read this file before writing any code. It is the source of truth for the data model, money rules, AI tools and PayPal integration. If a request conflicts with this spec, flag it instead of silently changing the spec.

## 1. Product in one paragraph

FairShift AI manages the money side of hospitality shifts. A manager closes a service, FairShift flags missing or suspicious hours, calculates the tip pool under a **written, versioned tipping policy**, and pays every worker through **PayPal Payouts**. A worker can then ask *"Why was I paid less this Friday than last Friday?"* and an AI assistant explains the difference using their real hours, the policy and their PayPal payout records. If something looks wrong, the worker raises a **pay query** with evidence attached; the manager resolves it and, if owed, a correction payout is sent. The AI also recommends cover for uncovered shifts.

Context for the pitch: the UK Employment (Allocation of Tips) Act 2023 (in force since 1 Oct 2024) requires employers who handle tips to allocate them fairly, keep a written tipping policy and keep records. FairShift produces exactly that audit trail.

## 2. The golden rule (non-negotiable)

**The AI never calculates, approves or changes money.**

- All arithmetic lives in `lib/tips/engine.ts` — pure, deterministic, unit-tested.
- The AI only reads data through the tools in §6 and **explains numbers those tools return**. It must never invent or recompute an amount.
- The only AI write action is `create_pay_query`, which creates a **draft** that a manager must approve.
- Payouts are triggered only by a manager clicking **Approve & Pay** in the UI.
- All money is stored as **integer pence** (`amount_pence`). Never floats.

## 3. Stack

| Layer | Choice |
|---|---|
| App | Next.js (App Router) + TypeScript |
| UI | Tailwind + shadcn/ui |
| Manager tables | AG Grid (Community) |
| DB | Supabase Postgres (no Supabase Auth) |
| AI | OpenAI API with tool calling |
| Payments | PayPal REST — Orders v2, Payouts v1, Webhooks (sandbox) |
| Hosting | Render |
| Tests | Vitest |

### Demo mode instead of auth
No login. A header dropdown: **View as → Manager / Sam (Bartender) / Priya (Server) / Jordan (Runner) / Alex (Host)**. Stored in a cookie. Server routes check the role from the cookie and enforce permissions (workers only see their own data). README states this is a demo-mode simplification.

## 4. Data model

```
venues(id, name)
workers(id, venue_id, name, role, paypal_email, hourly_rate_pence)
  role ∈ {bartender, server, runner, host, kitchen}

tip_policies(id, venue_id, version, effective_from, rules jsonb, text_summary)
  rules = { "method": "hours_x_weight",
            "weights": { "bartender": 1.2, "server": 1.0, "runner": 0.8, "host": 0.7, "kitchen": 0.6 },
            "min_hours_to_qualify": 2,
            "rounding": "largest_remainder" }

shifts(id, venue_id, date, service ∈ {lunch, dinner, late}, status ∈ {open, closed, paid})
shift_assignments(id, shift_id, worker_id, role, scheduled_start, scheduled_end,
                  clock_in, clock_out, break_minutes, status ∈ {scheduled, worked, no_show, uncovered})

tip_pools(id, shift_id, gross_pence, source ∈ {card, cash, service_charge},
          paypal_order_id, funded_at)

allocations(id, tip_pool_id, worker_id, policy_id, hours_decimal, weight, points,
            share_pence, explanation_json)
  -- explanation_json stores the full calculation trace for this worker

payout_batches(id, venue_id, paypal_batch_id, status, created_at)
payouts(id, batch_id, worker_id, allocation_id, amount_pence, paypal_item_id,
        status ∈ {pending, success, failed, unclaimed, returned}, updated_at)

flags(id, shift_assignment_id, type, message, status ∈ {open, resolved})
  type ∈ {missing_clock_out, long_shift, rota_mismatch, no_show, break_missing}

pay_queries(id, worker_id, allocation_id, worker_message, ai_summary, evidence_json,
            status ∈ {draft, submitted, approved, rejected}, resolution_note,
            correction_payout_id)

audit_log(id, actor, action, entity, entity_id, data jsonb, created_at)
```

Every allocation records `policy_id` — this is what lets the AI say "under policy v2…".

## 5. Tip engine (`lib/tips/engine.ts`)

```
hours_i  = (clock_out − clock_in − break) in hours   (excluded if < min_hours_to_qualify)
points_i = hours_i × weight(role_i)
share_i  = floor(gross × points_i / Σ points)
```
Distribute the leftover pence by **largest remainder** so the shares sum exactly to the gross. Return a trace per worker (hours, weight, points, total points, share) — this becomes `explanation_json`.

**Tests required:** shares sum to gross; zero workers; one worker; worker under min hours excluded; ties in remainders are deterministic (by worker id); a worker with a missing clock-out blocks calculation until resolved.

## 6. AI assistant

### Tools (read-only unless marked)
| Tool | Returns |
|---|---|
| `get_worker_shifts(worker_id, from, to)` | shifts, hours, breaks, flags |
| `get_allocation_breakdown(worker_id, shift_id)` | the engine trace for that shift |
| `get_tip_pool(shift_id)` | gross, source, PayPal order id |
| `get_policy(policy_id \| current)` | rules + plain-English summary |
| `get_payout_status(worker_id, shift_id)` | amount, PayPal batch/item id, status, timestamp |
| `compare_periods(worker_id, shift_a, shift_b)` | **pre-computed** diffs: Δhours, Δpool, Δteam_points, Δshare (computed in code, not by the AI) |
| `create_pay_query(worker_id, allocation_id, message)` ✍️ | creates a **draft** pay query with evidence attached |

Manager-only tools: `list_open_flags`, `suggest_cover(shift_assignment_id)` (returns ranked candidates scored in code by availability, role match, and hours-this-week fairness; the AI explains the ranking).

### System prompt rules
- Answer only about the current viewer's own data (enforced in the tool layer too).
- Every number in an answer must come from a tool result. If a number isn't available, say so.
- Cite the policy version and PayPal payout/batch id when explaining a payment.
- Keep explanations to 3–5 sentences, plain English, no jargon.
- If the worker disagrees, offer to create a pay query; never promise a correction.

## 7. PayPal integration (sandbox)

1. **Setup:** sandbox Business account (the venue) + 5 sandbox Personal accounts (one per worker). Put the personal accounts' emails in `workers.paypal_email` via seed.
2. **Orders v2 — funding the pool:** card tips collected during service are recorded as a PayPal order (`intent: CAPTURE`). Store `paypal_order_id` on `tip_pools`. Keep this to one clear flow.
3. **Payouts v1 — paying staff:** on manager approval, POST one batch with one item per allocation. `sender_item_id = allocation.id` for idempotency. Store `paypal_batch_id` / `paypal_item_id`.
4. **Webhooks:** subscribe to `PAYMENT.PAYOUTSBATCH.SUCCESS`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `.FAILED`, `.UNCLAIMED`, `.RETURNED`. **Verify signatures** via `/v1/notifications/verify-webhook-signature`. Update `payouts.status`. Local dev via ngrok; prod via Render URL.
5. **Correction payouts:** an approved pay query creates a single-item payout linked to the query.
6. Never log or display client secrets. All PayPal calls server-side only.

## 8. Screens

**Manager**
- Dashboard: tonight's shifts, open flags, pool status, recent payouts (AG Grid).
- Close shift: review hours → resolve flags → see calculated allocation (AG Grid) → **Approve & Pay**.
- Pay queries inbox: worker message, AI summary, evidence → approve (correction payout) / reject with note.
- Cover: uncovered shift → AI-ranked suggestions → assign.

**Worker**
- My earnings: recent shifts, share, payout status chips (Pending / Paid / Failed).
- Shift detail: the calculation shown as a simple breakdown.
- Ask FairShift: chat box with suggested prompts ("Why was this Friday lower than last Friday?").
- My queries: status of submitted queries.

## 9. Seed data = the demo script

One venue, 5 workers, 2 weeks of shifts, policy v1 → v2 change in week 2.
Built-in story for **Sam (bartender)**:
- Friday week 1: 7.5h, pool £640 → bigger share.
- Friday week 2: 6h logged (missing clock-out was "fixed" to scheduled end, actually stayed 1h longer), pool £510, an extra runner on shift → smaller share.
- So the AI can explain: fewer hours, smaller pool, more team points — and Sam can query the hour.

Include a **Reset demo** button (manager view) that reseeds everything.

## 10. Build order (layers — each ends submittable)

| Day | Goal |
|---|---|
| **Tue 3** | Repo, LICENSE (MIT), Next.js scaffold, Supabase schema + seed, PayPal sandbox accounts created, **one real sandbox payout sent from a script** |
| **Wed 4** | Tip engine + tests; manager close-shift flow; Approve & Pay → Payouts batch |
| **Thu 5** | Webhooks + signature verification; payout status in UI; deploy to Render early |
| **Fri 6** | Worker views; AI chat with read tools; "why was I paid less" works end-to-end |
| **Sat 7** | Flags (missing hours etc.); pay query flow + correction payout |
| **Sun 8** | Shift cover suggestions; Orders v2 pool funding |
| **Mon 9** | AG Grid polish, UI pass, error states, Reset demo |
| **Tue 10** | **Feature freeze.** Bug fixes, README, architecture diagram |
| **Wed 11** | Record + edit video (< 3 min), Devpost text |
| **Thu 12** | Final checks, submit **before 8pm UK** |

## 11. Submission checklist

- [ ] Public repo, MIT LICENSE visible in About
- [ ] README: problem, demo link, screenshots, setup steps, env vars, architecture, **"AI tools used and how"**, **"PayPal APIs used and how"**, demo-mode note, tests
- [ ] `.env.example` (no secrets committed)
- [ ] Hosted demo on Render works in a fresh incognito window
- [ ] Video < 3 min on YouTube (public), no copyrighted music
- [ ] Devpost description + tools list

## Amendments

Changes made during implementation. Each is additive or a representation detail; none changes the financial rules.

**M1 (3 Nov 2026)**
1. **Integer units for tip maths.** `allocations.hours_decimal` → `worked_minutes` (integer) and `weight` → `weight_bp` (basis points, 1.2 → 120); `points = minutes × weight_bp`. Keeps every calculation in integers. Policy `rules` use `weightsBp` and `minMinutesToQualify`.
2. **Payout idempotency columns.** `payout_batches.sender_batch_id` (unique), `approved_by`, `last_error`, `updated_at`; `payouts.sender_item_id` (unique), `paypal_transaction_id`, `error_message`. Payout statuses extended to all PayPal item statuses (`onhold`, `blocked`, `refunded`, `reversed`); batch statuses `created/submitted/pending/processing/success/denied/canceled/error`.
3. **`webhook_events` table** keyed by PayPal event id, for duplicate-safe webhook handling.
4. **Uncovered slots.** `shift_assignments.worker_id` is nullable (status `uncovered`).
5. **Database access** via Drizzle ORM (schema in `lib/db/schema.ts` is the source of truth; migrations generated into `/drizzle`).
6. **Sandbox safety controls:** hard-coded sandbox base URL, recipient allowlist, per-item/per-batch caps with hard ceilings.
7. **Integration testing** runs from a manual GitHub Actions workflow, as the build environment cannot reach PayPal or Supabase.

**M2 (3 Nov 2026)**
8. **Hours corrections are evidence-preserving.** New append-only `time_corrections` table (field, original value, new value, actor, reason, timestamp). `shift_assignments` gains `hours_corrected`, `original_clock_in`, `original_clock_out`, frozen at the first correction. Corrections are refused once a payout batch exists; a correction to a locked (closed) shift discards its allocation and reopens it.
9. **One payout batch per shift.** `payout_batches.shift_id` + `kind` (`shift` | `correction`), with a partial unique index on `shift_id` where `kind = 'shift'`. Correction batches (M4) are separate.
10. **Send-claim status.** Batch status `sending` plus `send_attempts` and `last_status_check_at`. Payout creation is three-phase (prepare + atomic claim in a locked transaction → send → record); see `lib/payouts/service.ts`.
11. **Demo pools are labelled.** `tip_pools.is_demo` (seeded pools = true; none funded through PayPal Orders). Seeded shifts all start `open`: nothing is pre-calculated or pre-paid.
12. **Shift lifecycle.** `open` (hours editable) → `closed` (allocation saved/locked) → `paid` (only when EVERY payout item reports SUCCESS).
13. **Payout authorisation** (replaces "manager clicks Approve & Pay" in §2): requires `PAYOUTS_ENABLED=true`, a server-checked `MANAGER_APPROVAL_CODE` (≥ 12 chars, constant-time compare), and an attempt rate limit (5 per client / 20 global per 15 min, in-memory). The demo role cookie only controls which views are shown.
14. **Re-verification before paying.** The saved allocation must equal a fresh engine run on current data, and all PayPal guards (allowlist, per-item cap, batch total) run before anything is persisted.
15. **Status reconciliation** is manual ("Refresh status", via GET payout batch) in M2. Webhook-driven reconciliation is scheduled for M3 once there is a public URL.

**Pre-deploy (3 Nov 2026)**
16. **Payment history is permanent.** `payout_batches`, `payouts`, `pay_queries` and `audit_log` cannot be deleted or truncated: foreign keys into them use `ON DELETE RESTRICT`, and database triggers (`0003_protect_payment_history.sql`, a Drizzle custom migration) reject DELETE/TRUNCATE. Updates (status reconciliation) are allowed. The seed refuses to run if any payout batch, payout or pay query exists, and never deletes the audit log or webhook events.
17. **Payout rows record the exact recipient** (`payouts.receiver_email`). Retries send exactly the persisted amounts and recipients.
18. **Stricter reconciliation.** PayPal's response must be for our batch (PayPal batch id and sender_batch_id). Each item is checked for amount, currency (GBP) and recipient; any mismatch is stored in `payouts.reconciliation_issue` and the item is shown as "Needs review", never as paid. Unknown, duplicate and missing items are surfaced. A shift is `paid` only when every item is SUCCESS with no issue.
19. **Single payout gate.** `authorisePayout()` (lib/payouts/approval.ts) is the only authorisation check. Its inputs do not include the demo role.
20. **Deployment.** Render Blueprint (`render.yaml`): Node 22, Frankfurt, `PAYOUTS_ENABLED=false`, no `MANAGER_APPROVAL_CODE` on the public service. Liveness at `/api/health`.

**M3 (3 Nov 2026) — worker dashboard, AI assistant, pay queries**
21. **Pay queries** (`0004_pay_queries_workflow.sql`): `shift_assignment_id` (FK, restrict), `field`, `recorded_value`, `claimed_value`, `reviewed_by`, `submitted_at`, `reviewed_at`, `updated_at`; `allocation_id` is optional and a plain historical reference (not a FK) because a manager correction replaces the allocation — a snapshot lives in `evidence_json`. Status enum recreated as `draft → submitted → accepted → resolved` / `submitted → rejected`; transitions validated in `lib/payqueries/commands.ts` and audited. Partial unique index: one open (draft/submitted/accepted) query per worker per shift record. Nothing in the workflow changes hours, allocations or payments.
22. **Worker states** (deterministic, `lib/worker/queries.ts`): upcoming, blocked, provisional, allocated, paid, needs_review. Worker views never name other workers.
23. **Comparison** (`lib/tips/compare.ts`): fixed-order counterfactual (pool → your points → rest of team), BigInt, steps sum exactly to the difference. Sam: −£54.13, −£27.04, −£30.52 = −£111.69.
24. **AI assistant** (`lib/assistant/`): OpenAI Responses API, server-side function calling, `store: false`, strict tool schemas, structured JSON answer. Tools take no worker id (server context only); shift ids outside the worker's records return "not found"; identity-like arguments are refused; no tool writes; `create_pay_query` only builds a proposal. ESLint forbids PayPal/payout imports in AI code.
25. **Fact ledger + answer validation**: every value a tool returns is registered with a source record; the model must write `[[fN]]` placeholders; raw money, %, durations, clock times, ids and unsupported "you've been paid" claims are rejected (one corrective retry, then a deterministic fallback). The UI renders values from the ledger and evidence cards from code.
26. **Limits** (`lib/assistant/limits.ts`, in-memory, best-effort, reset on restart): 500-char messages, 8-message history, 6 model rounds, 10 tool calls, 1,200 output tokens, 15 questions / 10 min per IP, 30 / min global, `AI_DAILY_LIMIT` per UTC day, `AI_ENABLED` kill switch.

**Gemini migration (3 Nov 2026) — free-tier AI**
27. **Provider**: `AI_PROVIDER=gemini` (default) with `GEMINI_MODEL=gemini-3.1-flash-lite` on Google's free API tier; no billing, no automatic fallback to a paid provider/model. OpenAI remains selectable (`AI_PROVIDER=openai`) but is not used by default.
28. **Adapter** (`lib/assistant/providers/gemini.ts`): Gemini's OpenAI-compatible endpoint supports Chat Completions, not the Responses API, so a small adapter translates the loop's protocol. Raw assistant messages are replayed verbatim so Gemini 3 thought signatures (`tool_calls[].extra_content.google.thought_signature`) survive. Tool schemas are converted to Gemini's dialect (nullable unions; no `additionalProperties`/`strict`); server-side argument checks are unchanged. `response_format: json_schema` is sent with tools and dropped only after an explicit rejection. No automatic retries (free quota).
29. **Answer shape**: the final JSON must have exactly `answer`, `cited_fact_ids`, `offer_pay_query` with correct types, then pass the fact-ledger checks; otherwise one corrective retry, then the deterministic fallback.
30. **Free-tier protection**: 5 questions/minute globally, `AI_DAILY_LIMIT=100`; HTTP 429 / RESOURCE_EXHAUSTED → friendly "free AI quota used up" (never a fabricated answer); bad key → "not configured". Free-tier prompts may be used by Google to improve products — acceptable because all data is synthetic.
31. **Real-API checks**: `ai-smoke` (one interaction, raw-traffic signature check) and `ai-check` (7 scenarios, paced). Quota exhaustion = INCONCLUSIVE (exit 2), never a pass.
