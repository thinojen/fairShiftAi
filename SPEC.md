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
