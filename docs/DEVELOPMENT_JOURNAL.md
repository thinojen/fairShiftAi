# FairShift AI — Development Journal

**From a starter specification to a working, AI-explained pay dispute — and what it took to get there.**

| | |
|---|---|
| **Edition** | Interim · 5 November 2026 (after commit `5f669ef`) |
| **Hackathon deadline** | Thursday 12 November 2026, 20:00 UK |
| **Live demo** | https://fairshift-ai.onrender.com — Gemini on, PayPal payouts **off** |
| **Sources** | The repository (14 commits, `SPEC.md` amendments 1–53, `TASKS.md`, 225 automated tests), the project owner's interim PDF report and context handoff, and 21 user-supplied screenshots |

> [!IMPORTANT]
> **Evidence boundary.** As of this edition, no payout has been sent through the FairShift **manager interface** to real PayPal. A separate £1.00 sandbox payout script succeeded on 3 November; the full five-worker manager-UI payout is prepared but **not run**. Nothing below should be read as claiming otherwise.

**How to read the labels.** Every claim is tagged with the kind of evidence behind it:

| Label | Meaning |
|---|---|
| 🖼️ **Observed** | Seen in a screenshot of the live site, GitHub Actions or Render (evidence `E01`–`E21`) |
| 🌐 **Real call** | A real request to Gemini, PayPal sandbox or Supabase, shown in logs |
| 🧪 **Automated test** | Repository tests on in-memory/local databases with **fake** Gemini/PayPal |
| 🔧 **Code** | What the source code does (commit or file), not independently observed |
| 📝 **Planned** | Prepared or intended, not yet done |

---

## Contents

1. [The project in one page](#1-the-project-in-one-page)
2. [Architecture and the rules we never broke](#2-architecture-and-the-rules-we-never-broke)
3. [Key decisions — and why](#3-key-decisions--and-why)
4. [Timeline](#4-timeline)
5. [Where we got stuck, and how we got out](#5-where-we-got-stuck-and-how-we-got-out)
6. [What is verified, simulated, or still pending](#6-what-is-verified-simulated-or-still-pending)
7. [The PayPal payout: readiness and the isolated environment](#7-the-paypal-payout-readiness-and-the-isolated-environment)
8. [Discrepancies between sources](#8-discrepancies-between-sources)
9. [Open issues and next steps](#9-open-issues-and-next-steps)
10. [Evidence archive](#10-evidence-archive)

---

## 1. The project in one page

**The problem.** Hospitality workers are paid a share of a tip pool by a formula they rarely see. When the number drops, they can't tell whether the pool shrank, their hours changed, the policy changed — or someone made a mistake.

**What FairShift does.** A manager records hours and tips; a deterministic engine allocates the pool in whole pence; the worker sees exactly how their share was worked out; an AI assistant explains *changes* using only verified records; a worker can raise a pay query with code-built evidence; and payouts go through PayPal (sandbox) only after explicit manager approval.

**The golden rule** (unchanged since the first spec):

> **AI investigates and explains. Deterministic code calculates. Humans authorise. PayPal moves the money.**

### The demo story: Sam's two Fridays

Sam is a synthetic bartender at *The Copper Lantern* (all people and amounts are fictional).

| | Fri 23 Oct 2026 | Fri 30 Oct 2026 |
|---|---|---|
| Tip pool | £640.00 | £510.00 |
| Sam's hours | 7h 30m | 6h (clock-out was missing; manager set it to the 23:30 rota end) |
| Policy | v1 | v2 (host weight 0.6× → 0.7×; bartender stays 1.2×) |
| Sam's share | **£266.46** (provisional) | **£154.77** (provisional) |

**Difference: −£111.69**, split by a fixed-order counterfactual (pool first, then Sam's points, then the rest of the team):

| Step | Effect |
|---|---|
| Smaller tip pool | −£54.13 |
| Sam's points (minutes × role weight) | −£27.04 |
| Rest of the team (staffing, hours, policy weights, rounding) | −£30.52 |
| **Total** | **−£111.69** |

This is *one* fair way to attribute the change, not the only one — the app and the AI both say so. 🖼️ Observed live (E14, E15).

Sam then says he worked an extra hour (clock-out 23:30 → 00:30). Gemini prepares a pay query — **not saved** until Sam clicks — and the manager reviews it with evidence built by code. 🖼️ Observed live (E17–E19, E21).

---

## 2. Architecture and the rules we never broke

```mermaid
flowchart LR
  B["Browser<br/>(demo role switcher — not a login)"] --> N["Next.js 16 on Render<br/>server actions + API routes"]
  N --> E["Tip engine<br/>integer pence, BigInt,<br/>largest remainder"]
  N <--> D[("PostgreSQL<br/>Supabase · Drizzle migrations")]
  N --> A["Gemini adapter<br/>7 read-only, worker-scoped tools"]
  A -- "values as [[fN|£x.xx]] tokens" --> V["Fact-ledger validator<br/>rejects any unverified figure"]
  V --> B
  N -- "approval code + guards<br/>(PAYOUTS_ENABLED)" --> P["PayPal Payouts<br/>SANDBOX only"]
  P -- "per-item status on Refresh" --> N
```

| Invariant | How it is enforced | Evidence |
|---|---|---|
| Money is never a float | Integer pence everywhere; minutes for hours; basis points for weights | 🔧 `lib/money.ts`, `lib/tips/engine.ts` · 🧪 engine tests |
| The AI never calculates or moves money | AI code can't import PayPal modules (ESLint); tools are read-only; `create_pay_query` only *proposes* | 🔧 `eslint.config.mjs`, `lib/assistant/tools.ts` · 🧪 injection tests |
| No unverified number reaches the worker | Tool results give values as tokens; the validator rejects raw amounts, times, %, IDs, edited tokens and unsupported "you've been paid" claims; otherwise a safe fallback | 🖼️ E02 (it rejected a real answer) · 🧪 validator tests |
| Provisional ≠ allocated ≠ paid | A worker is "Paid" only when **their own** PayPal item is SUCCESS with no reconciliation issue | 🔧 `lib/worker/queries.ts` · 🖼️ E19 (£0 paid) |
| Payment history is permanent | DB triggers block DELETE/TRUNCATE on payouts, batches, pay queries, audit log; seed refuses once history exists | 🔧 migration `0003` · 🧪 integration tests |
| A payout can't happen twice | One batch per shift; `sender_batch_id` created once, reused on retry and sent as `PayPal-Request-Id`; atomic claim | 🔧 `lib/payouts/service.ts` · 🧪 idempotency tests |
| Sandbox only | PayPal base URL hard-coded to `api-m.sandbox.paypal.com`; `PAYPAL_ENV` must be `sandbox` | 🔧 `lib/paypal/config.ts` · 🌐 E20 |
| The public site can't pay | `PAYOUTS_ENABLED=false` on Render; no approval code configured there | 🔧 `render.yaml` |

---

## 3. Key decisions — and why

| Decision | Why | Trade-off we accepted |
|---|---|---|
| **Integer pence + largest-remainder rounding** | Shares must always sum *exactly* to the pool; floats drift by pennies | Slightly more code (BigInt intermediates) |
| **Fixed-order counterfactual for "why did I earn less?"** | Gives steps that add up exactly to the difference and can be explained in plain English | Order-dependent; we say "one fair way, not the only one" |
| **The AI only explains; code calculates** | An LLM that does arithmetic on pay is a liability; a deterministic engine is testable | The AI can't answer "what if" maths on its own |
| **Fact ledger + self-verifying tokens** | Lets the model *refer* to a verified value without typing it; the server renders the trusted value | The model must copy tokens exactly; first real run failed until we changed the format (§5-C) |
| **Gemini free tier instead of OpenAI** (3 Nov) | No money spent on AI for a hackathon | Free-tier capacity errors (503) and quotas (§5-D, §5-E) |
| **Bounded 503-only retries, no fallback model** | Survive "high demand" spikes without burning quota or silently switching to a paid model | A busy Google still means "please try again shortly" |
| **Demo role switcher, not authentication** | Judges can see both sides instantly | Every financial action re-checks on the server; payouts need an approval code regardless of role |
| **Payouts off on the public site** | A public "Approve & pay" button is an abuse risk and would lock the demo data | The real payout must be shown in a separate environment (§7) |
| **GitHub Actions for integration tasks** | Secrets stay in GitHub; no local setup; every run is logged | Learning curve: green job ≠ the step you wanted ran (§5-F) |
| **Drizzle migrations as the only schema path** | Reproducible, reviewable schema; no hand-edited SQL | Production must actually *run* the migrations (§5-G) |
| **Shift completion by the clock, not by recorded times** (5 Nov) | Recorded times can be entered early or wrong; the rota end is authoritative | A finished shift with no tips recorded shows as "awaiting tip pool" |
| **Isolated GitHub Codespace for the payout demo** (5 Nov) | Prove a real sandbox payout through the UI without touching the public demo's records | Extra setup; must be clearly labelled in the video |

---

## 4. Timeline

Commit times are UK time (GMT). Test counts are the repository's automated tests at that commit.

### Tuesday 3 November — foundation to AI assistant

| Time | Commit | What happened | Tests |
|---|---|---|---|
| 14:24 | `4d2420d` | Build spec (`SPEC.md`) committed | — |
| 14:41 | `41c042a` | **Milestone 1:** Next.js 16, Drizzle schema, synthetic seed, sandbox-only PayPal client with idempotent payouts and guards, GitHub Actions | 27 |
| 15:40 | `4e2dc00` | **Fix:** wrong OAuth scope for Payouts; permission check now uses token scopes only (§5-A) | |
| — | — | 🌐 User ran a real **£1.00 sandbox payout** via GitHub Actions → item SUCCESS (reported; not the manager UI) | |
| 17:46 | `8e38e72` | **Milestone 2:** tip engine, manager dashboard, hour corrections, save & lock, approval-code payouts, status refresh | |
| 18:32 | `6fb7188` | Payment history made permanent (DB triggers), stricter reconciliation, Render Blueprint | |
| 20:05 | `8f4cf3c` | **Milestone 3:** worker dashboard, comparison card, AI assistant (OpenAI Responses API at first), pay queries | 150+ |
| 20:31 | `8573dcb` | **Switched AI to Gemini free tier** via a small Chat Completions adapter that preserves Gemini thought signatures | 168 |
| ~20:40 | — | 🖼️ **First real Gemini smoke test:** tools and thought signatures worked; the final answer was **rejected** by the validator (E02) | |
| 21:04 | `d63c749` | **Fix:** self-verifying `[[fN\|value]]` tokens, compact comparison tool, per-attempt diagnostics (§5-C) | 178 |

### Wednesday 4 November — provider outages and a production crash

| Time | Commit | What happened | Tests |
|---|---|---|---|
| morning | — | Re-run crashed after ~6 s with only "AI service unavailable" | |
| 12:35 | `5c9bd6e` | **Fix:** precise, sanitised error categories; `ai-ping` connectivity task (§5-D) | 189 |
| — | — | 🌐 Diagnostics revealed **HTTP 503 "This model is currently experiencing high demand"** from `gemini-3.1-flash-lite` — even for a one-line ping | |
| 14:20 | `b9ca0b6` | Default model → `gemini-3.5-flash-lite` (stable, free tier) | |
| ~14:27 | — | 🖼️ `ai-ping` **passed** (E03); 🖼️ `ai-smoke` **passed** (E04) — first verified real tool-calling interaction | |
| ~14:31 | — | 🖼️ Full 7-scenario `ai-check` interrupted by another 503 after 3 responses (E05) | |
| 14:54 | `5c974e2` | **Fix:** bounded 503-only retries, "Gemini is temporarily busy" message, per-scenario ai-check outcomes (§5-E) | 199 |
| ~15:00 | — | 🖼️ Render deploys `5c974e2` (E06) | |
| ~15:04 | — | 🖼️ **Live `/worker` page crashes** (E07); Render log shows PostgreSQL **42703** missing column (E08) | |
| 15:18 | `286561a` | **Fix:** read-only `db-status`, guarded `db-migrate` (§5-G) | 204 |
| ~22:18 | — | 🖼️ `db-status`: 4 migrations applied, `0004` pending, 8 columns missing (E09) | |
| ~22:40 | — | 🖼️ `db-migrate` applied `0004`, row counts unchanged (E10); 🖼️ worker page back (E11) | |
| ~22:52 | — | 🖼️ **First live verified Gemini explanation** (23 Oct, £266.46) (E12) | |

### Thursday 5 November — accuracy, disputes and payout preparation

| Time | Commit | What happened | Tests |
|---|---|---|---|
| ~00:28 | — | 🖼️ **Bug:** dashboard compares 30 Oct with the *future* 6 Nov (£0) as "−£154.77" and counts 26h 40m worked (E13) | |
| 00:38 | `b9a5c3a` | **Fix:** shift completion by rota end in UK time; comparison only between completed shifts with recorded tips (§5-H) | 211 |
| ~00:43 | — | 🖼️ Live: 21h 10m, 23 Oct vs 30 Oct, **−£111.69** (E14); 🖼️ Gemini explains the three steps (E15) and refuses to call 6 Nov "lost money" (E16) | |
| ~00:49–01:15 | — | 🖼️ Sam's extra-hour **pay query**: proposal "NOT SAVED YET" (E17) → submitted → manager inbox with evidence (E18) → accepted; hours and pay **unchanged** (E19) | |
| ~01:35 | — | 🖼️ 🌐 Read-only `paypal-check`: sandbox auth, Payouts permission, 5 allowlisted recipients, no money moved (E20) | |
| ~01:38 | — | 🖼️ Query marked **Resolved** ("Completed"); clock-out still 23:30 (E21) — see §5-I | |
| ~01:45 | — | Payout-readiness audit of the code (§7) | |
| 02:09 | `5f669ef` | Isolated Codespaces payout demo: local-only `demo:setup`, read-only `paypal:preflight`, environment banner (§7) | 225 |

---

## 5. Where we got stuck, and how we got out

### A · PayPal said "no permission" — but we were asking the wrong question (3 Nov)
**Symptom.** The Payouts permission check failed with valid sandbox credentials.
**Cause.** The code looked for the wrong OAuth scope, and an API "probe" returning 404 had been treated as proof of permission.
**Fix (`4e2dc00`).** Check for the documented scope `https://uri.paypal.com/payments/payouts` on the token only; a 404 probe now only proves reachability (it says so in E20).
**Lesson.** A permission check must test the permission, not a side effect.

### B · Sam's real share was bigger than our safety cap (3 Nov)
Sam's £266.46 exceeded the default £200 per-item payout cap, so a legitimate payout would have been refused. We raised the public config to `PAYOUT_MAX_ITEM_PENCE=30000` (£300) — still under a hard ceiling of £500 that no setting can raise — rather than weakening the guard.

### C · The validator rejected Gemini's first real answer — correctly (3 Nov)
🖼️ **E02.** Gemini called the right tool and returned thought signatures, but the final answer failed verification, so the worker saw a safe fallback instead of an unverified figure.
**Cause (from code review).** Tool results showed values as `{"fact":"f12","display":"−£111.69"}`. The model re-typed the amounts in plain text, and the validator rejects raw amounts by design.
**Fix (`d63c749`).** Tool results now present each value as one token — `[[f12|−£111.69]]` — that the model copies. The validator checks the copied value against the ledger; an *edited* token is rejected. Validation was **not** weakened. We also cut the comparison payload and recorded per-attempt diagnostics, because that run used 6 model calls and ~22.8k input tokens.
**Lesson.** When a safeguard blocks you, change the interface so the model can comply — not the safeguard.

### D · "AI service unavailable" told us nothing (4 Nov)
The next run crashed in ~6 s with a generic message: the error classifier folded 404s, 5xx, network errors, empty responses and even our own bugs into one bucket.
**Fix (`5c9bd6e`).** Sanitised categories (auth, quota, invalid request, model unavailable, server, network, internal), HTTP status, Google's error code, timeout flag, the stage that failed and how many requests had completed — never keys or bodies. Plus `ai-ping`: one text-only request to separate *connectivity* from *tool-calling*.
**Result.** 🌐 The real cause was **HTTP 503 UNAVAILABLE — "This model is currently experiencing high demand"**, even for a ping. Not a bug in our code.

### E · Google's free tier was simply busy (4 Nov)
We switched to `gemini-3.5-flash-lite` (`b9ca0b6`); 🖼️ ping and smoke passed (E03, E04). 🖼️ The 7-scenario suite was still interrupted by a 503 after three good responses (E05).
**Fix (`5c974e2`).** Retry **HTTP 503 only**, at most 2 retries per request and 3 per question, with jittered backoff (1–2 s, 2–4 s), honouring short Retry-After. A retry resends the *identical* request (signatures intact); tools run only after a successful response, so nothing can execute twice. Never retried: quota (429), auth, bad requests. No paid fallback. If still busy, the worker sees *"Gemini is temporarily busy. Your financial records are safe. Please try again shortly."* `ai-check` now reports provider outages as **INCONCLUSIVE**, never PASS.
**Note.** `AI_ENABLED=false` on Render (set at one point) disables the public chat; it was unrelated to the GitHub Actions 503s, which caused some confusion. It was later set back to `true`.

### F · A green workflow is not a green step
GitHub Actions marks a job green even when the step you care about was **skipped** (🖼️ E03 and E04 show the skipped-step icons). Conversely, a **red** `db-status` job (🖼️ E09) was the tool working as designed: it exits non-zero to flag an out-of-date schema. We learned to expand the named step and read its output.

### G · The live worker page crashed while health checks were green (4 Nov)
🖼️ E07: "This page couldn't load", while `/api/health` was fine. 🖼️ E08: Render logs showed PostgreSQL **42703 — column `shift_assignment_id` does not exist**.
**Cause.** Migration `0004_pay_queries_workflow` (Milestone 3) had never been applied to Supabase.
**Approach (`286561a`).** No manual SQL, no reseed. We added a **read-only** `db-status` (applied vs pending migrations, missing columns, row counts) and made `db-migrate` list what's pending, refuse if existing rows would block a `NOT NULL` column, apply in one transaction, then re-check columns and that no table lost rows. Rehearsed first on a real local PostgreSQL built with the *old* code, including manager activity: every pre-existing row was byte-identical afterwards (🧪).
**Result.** 🖼️ `db-status` found exactly 8 missing columns (E09); 🖼️ `db-migrate` applied `0004` with row counts unchanged (E10); 🖼️ the page recovered (E11).
**Operational lesson.** A connection string belongs in GitHub **Secrets** (never ordinary Variables), and an existing secret looks empty when you open it to edit — that's normal.

### H · A future shift was counted as lost pay (5 Nov)
🖼️ **E13 (before):** the dashboard compared 30 Oct with **Fri 6 Nov** — a shift that hadn't happened — showing "−£154.77" and 26h 40m worked. Clock times had been recorded on the 6 Nov shift ahead of time (E13 shows two staff with hours), and the app decided "upcoming" by *missing clock times*, not by the clock.
**Fix (`b9a5c3a`).** A shift is finished only after its latest **rota end** (UK time, BST-aware). Unfinished shifts are "Upcoming": no hours worked, no share, never compared; recorded times are kept as evidence. Comparisons use the latest *completed* shift **with recorded tips**, so after 6 Nov passes without a tip pool the demo still compares 23 vs 30 Oct. Gemini's tools share the same read model. No production data was changed.
**Result.** 🖼️ **E14 (after):** 21h 10m, −£111.69. 🖼️ **E16:** Gemini: *"You haven't lost any money for Fri 6 Nov 2026 because that shift is an upcoming shift and hasn't happened yet."*

### I · A manager's decision is not a pay correction (5 Nov) — open UX issue
🖼️ E19, E21: after the manager accepted and then **resolved** Sam's query (note "Completed"), Sam's recorded clock-out stayed 23:30 and his share £154.77.
This is **by design** — accepting a query changes nothing; the manager must correct hours, re-lock and approve — but the word *Resolved* reads as "fixed". Separately, the manager card's **AI-written summary** said *"Worked an extra hour on clock-out"* (🖼️ E18), stating Sam's claim as fact. Both are listed in §9.

### J · Smaller snags worth recording
| Snag | Resolution |
|---|---|
| A later ESLint `no-restricted-imports` block silently replaced an earlier one | Ordered the AI block last and repeated both patterns |
| The identity-argument filter rejected the harmless field `worker_statement` | Replaced with an exact identity-key regex |
| Drizzle runs all pending migrations in one transaction, so a new enum value couldn't be used in the same run | Redefined the enum's full value list so the type is recreated |
| A foreign key from pay queries to allocations would block legitimate corrections | `allocation_id` became a plain historical reference; evidence is a frozen snapshot |
| Our own test expectations for the comparison steps were off by 1p | Hand-verified the engine (−£27.04 / −£30.52) and fixed the tests, not the engine |
| Gemini's "response mime type" wording wasn't recognised as a structured-output rejection | Extended the detector; fallback still only on an explicit rejection |
| In the local end-to-end harness, our *mock* Gemini returned malformed tool calls | The new diagnostics pinpointed `EMPTY_RESPONSE` at "reading Gemini's response"; fixed the mock, and the label now reports HTTP 200 correctly |
| Per-attempt AI diagnostics were being returned to the browser | Stripped server-side |
| Next.js rejects Server Actions coming through a Codespaces forwarded URL | Allow exactly that Codespace's own host (no wildcard); Render unaffected |

---

## 6. What is verified, simulated, or still pending

| Check | Status | Evidence |
|---|---|---|
| Real Gemini connectivity (`ai-ping`) | ✅ PASS | 🖼️ 🌐 E03 |
| Real Gemini tool call + signature replay + verified answer (`ai-smoke`) | ✅ PASS | 🖼️ 🌐 E04 |
| All 7 real Gemini scenarios in one run (`ai-check`) | ⚠️ INCOMPLETE — interrupted by 503 | 🖼️ 🌐 E05 |
| Supabase migration `0004`, rows preserved | ✅ PASS | 🖼️ 🌐 E09, E10 |
| Live worker page | ✅ PASS (after migration) | 🖼️ E07 → E11, E14 |
| £266.46 explanation, live | ✅ PASS | 🖼️ 🌐 E12 |
| −£111.69 comparison and breakdown, live | ✅ PASS | 🖼️ 🌐 E14, E15 |
| Future-shift guardrail, live | ✅ PASS | 🖼️ 🌐 E16 |
| Pay query proposal → draft → submit → manager evidence, live | ✅ PASS | 🖼️ E17, E18 |
| Accept/resolve doesn't change hours or pay, live | ✅ PASS | 🖼️ E19, E21 |
| PayPal sandbox credentials + Payouts permission (read-only) | ✅ PASS | 🖼️ 🌐 E20 |
| Standalone £1.00 sandbox payout (script, not UI) | ✅ Reported | 🌐 3 Nov run, no screenshot in this archive |
| 225 automated tests, typecheck, lint, build | ✅ Reported | 🧪 local runs at `5f669ef` |
| Full payout sequence with a **fake** PayPal (correct → lock → pay once → refresh → Sam paid; UNCLAIMED → Needs review) | ✅ Simulated | 🧪 `tests/demo-sandbox.test.ts` |
| Codespaces demo mode up to the Approve & pay form (fake credentials, **not clicked**) | ✅ Local rehearsal | 🧪 L01, L02 |
| **Five-worker payout through the manager UI → real PayPal sandbox → Refresh → Sam "Paid"** | ⛔ **NOT RUN** | 📝 needs Codespace setup, preflight review and explicit approval |
| Webhook-driven payout status | ⛔ Not implemented | 🔧 status comes from "Refresh status" |
| Separately authorised pay-query correction payouts | ⛔ Not implemented | 🔧 only an unused `correction_payout_id` column |

---

## 7. The PayPal payout: readiness and the isolated environment

### What the code does (🔧, with 🧪 tests against a fake PayPal)

1. **Correct hours** — audited; refused once a payout batch exists for the shift.
2. **Save & lock** — re-runs the engine on the server and stores each share with its calculation trace.
3. **Approve & pay** — requires `PAYOUTS_ENABLED=true`, a ≥12-character approval code (constant-time compare, rate-limited) and an "I have reviewed" tick; the demo role is not an input.
4. **Batch creation** — re-verifies the saved allocation against a fresh engine run, runs the guards (allowlist, per-item and per-batch caps) *before* saving, claims the batch atomically, sends exactly what was saved.
5. **Refresh status** — checks PayPal returned *our* batch; each item is checked for amount, currency and recipient; mismatches show "Needs review", never "Paid".

### Why a second environment

Sending a real batch from the public site would lock Sam's 30 Oct shift permanently (payment history can't be deleted, by design), ending the public dispute story — and the public site must never have payouts enabled. So the payout is demonstrated in **Environment B**:

| | Environment A — public | Environment B — isolated |
|---|---|---|
| Where | Render + Supabase | Private GitHub Codespace + throwaway local PostgreSQL |
| Payouts | **Off** | On, sandbox only, approval code required |
| Data | Sam's −£111.69 story and resolved query, preserved | Fresh synthetic seed; resettable for each take |
| Label in the video | Public URL | Yellow banner: *"Isolated sandbox environment · synthetic data · PayPal SANDBOX"* (L01) |
| Status | ✅ Live | 📝 Code pushed (`5f669ef`); Codespace not yet created |

**Safety built into Environment B (🔧 + 🧪):** `demo:setup`, `paypal:preflight` and `demo:app` refuse any database that isn't `localhost`; the preflight uses a read-only connection and only requests a sandbox sign-in token (no money); it checks the sandbox URL, credentials and Payouts permission, all five recipients, the exact batch against the caps, no existing batch, and the history protections — and it lists what only a human can check (Personal sandbox accounts, GBP, business balance, private port).

### Projected batch (🧪 local prediction from the tip engine — **not** a PayPal result)

| Worker | Before (23:30) | After the extra hour (00:30) |
|---|---|---|
| Sam | £154.77 | **£171.88** |
| Priya | £128.98 | £122.77 |
| Jordan | £77.39 | £73.66 |
| Casey | £77.39 | £73.66 |
| Alex | £71.47 | £68.03 |
| **Total** | **£510.00** | **£510.00** |

The pool is fixed, so Sam's extra hour slightly reduces everyone else's share. Largest item £171.88 ≤ £200 cap; batch £510 ≤ £1,000 cap.

---

## 8. Discrepancies between sources

These were found while combining the interim PDF/handoff with the repository. None changes a conclusion.

| # | Item | PDF / handoff | Repository / screenshots | Resolution |
|---|---|---|---|---|
| 1 | Sign of the difference (PDF p.6) | "Sam **+**£111.69 story" | E14/E15: **−**£111.69 | Typo in the PDF |
| 2 | Dates of `8573dcb` and `d63c749` | Listed under the 4 Nov chronology | Committed 3 Nov at 20:31 and 21:04 | 3 Nov; the 503 outage was 4 Nov |
| 3 | Payout caps "£200 per item, £1,000 per batch" | Stated generally | True for GitHub Actions (E20) and the Codespace config; `render.yaml` sets **£300** per item | Correct for the environments that can pay; Render's cap is moot (payouts off) |
| 4 | E05 (ai-check 503) | "Seven-scenario run failed" | Run on `b9ca0b6`, *before* retries existed (`5c974e2`) | The retry logic has not yet been exercised by a full real `ai-check` |
| 5 | E11 role selector reads "Priya (server)" while the page greets Sam | Not mentioned | The dropdown changes only on **Switch**; the screenshot likely caught it mid-selection | Not a data leak; not investigated further |
| 6 | Who recorded 6 Nov clock times | "Supplied clock times before the shift" | The seed never sets them; E13 shows times for two staff | Entered on the live site after seeding; the production audit log (`hours.corrected`) would show by whom — not checked |
| 7 | Early milestones | Summarised as "built in milestones" | Commits `4d2420d`–`8f4cf3c` and the OAuth-scope fix `4e2dc00` | Added to §4 and §5-A |
| 8 | Starter spec | "The Garden Bistro", OpenAI | Live demo: The Copper Lantern, Gemini | Scope evolved; the starter spec was initial intent |

---

## 9. Open issues and next steps

**Before the payout recording**
1. 📝 Create Codespaces secrets (not Actions Variables; never `DATABASE_URL`) → create the Codespace → `demo:db`, `demo:setup`, `paypal:preflight` → review results, including the manual checks.
2. 📝 Correct Sam to 00:30, resolve, **Save & lock**, re-run the preflight on the locked amounts.
3. 📝 Only with explicit approval: one **Approve & pay**, then **Refresh status** until each item has a final PayPal status. Show whatever PayPal reports; never present pending or unclaimed as paid.

**Product polish (small, worthwhile)**
4. Rename or explain **Resolved** when the claim was accepted but hours weren't corrected (e.g. "Closed — no change to records" vs "Closed — records corrected").
5. Make the AI's manager summary describe claims as claims: *"Worker claims an extra hour after the recorded clock-out."*
6. Re-run the full 7-scenario `ai-check` now that retries exist (or run the unfinished scenarios individually).

**Submission**
7. Record the video in two clearly labelled parts (public ≈ 60 s, isolated ≈ 90 s), finish the README and Devpost text, then stop/delete the Codespace to protect the free allowance.

**Never:** enable payouts on the public site, reseed or reset Supabase, or present a simulated payment as real.

---

## 10. Evidence archive

All screenshots are the project owner's captures. Browser tab strips and address bars were cropped from E01, E03, E06, E07, E10 and E18 to remove personal tab titles and internal service IDs; the database endpoint was already redacted in E09 and E10. Recipient emails in E20 are masked by the app itself. No secrets appear in any image.

### Early build and AI integration

**E01 · 3 Nov · Early manager controls (Fri 6 Nov shift, before any hours)**
Blocked hours, "Fix hours" buttons, a disabled Save & lock and a separate PayPal panel. *Does not show a payout.*
![E01](journal/e01-early-manager-controls.jpg)

**E02 · 3 Nov · First real Gemini smoke: tools worked, answer rejected**
Approved tool called, thought signature replayed, but "verified answer grounded in tool results" failed → safe fallback. 6 model calls, 22,791 input tokens.
![E02](journal/e02-ai-smoke-validation-fail.jpg)

**E03 · 4 Nov · `ai-ping` passes**
The AI ping step ran (10 s) — note the other steps are skipped.
![E03](journal/e03-ai-ping-pass.jpg)

**E04 · 4 Nov · `ai-smoke` passes on gemini-3.5-flash-lite**
The smoke step ran (34 s) and succeeded.
![E04](journal/e04-ai-smoke-pass.jpg)

**E05 · 4 Nov · 7-scenario `ai-check` interrupted by HTTP 503**
Sanitised diagnostics: server error (HTTP 503), `UNAVAILABLE`, "high demand", stage "follow-up after tool results", 3 requests completed. *An availability failure, not wrong arithmetic.*
![E05](journal/e05-ai-check-503.jpg)

**E06 · 4 Nov · Render deploys the bounded-retry commit `5c974e2`**
![E06](journal/e06-render-deploy-retries.jpg)

### Production schema drift

**E07 · 4 Nov · Live `/worker` fails to load**
![E07](journal/e07-worker-page-crash.jpg)

**E08 · 4 Nov · Root cause in Render logs: PostgreSQL 42703**
`column "shift_assignment_id" does not exist` while reading `pay_queries` for `w_sam`.
![E08](journal/e08-render-log-42703.jpg)

**E09 · 4 Nov · Read-only `db-status`: migration 0004 pending, 8 columns missing**
Red by design. Row counts: 0 allocations, 0 time corrections, 0 pay queries.
![E09](journal/e09-db-status-pending-0004.jpg)

**E10 · 4 Nov · `db-migrate` applies 0004; row counts unchanged**
No `db-seed` was run.
![E10](journal/e10-db-migrate-success.jpg)

**E11 · 4 Nov · Worker page recovers; 30 Oct correctly "Blocked"**
![E11](journal/e11-worker-recovered-blocked.jpg)

**E12 · 4 Nov · First live verified Gemini explanation (23 Oct)**
7h 30m × 1.2 = 54,000 of 129,700 points = 41.63% of £640.00 = £266.46, "Provisional — calculated, not locked, not paid". Every highlighted value is a verified token.
![E12](journal/e12-gemini-23-oct-explanation.jpg)

### Accuracy: the future-shift bug

**E13 · 5 Nov · BEFORE: future 6 Nov compared as "−£154.77", 26h 40m worked**
*Preserved as a bug record — not current behaviour.*
![E13](journal/e13-future-shift-bug.jpg)

**E14 · 5 Nov · AFTER `b9a5c3a`: 21h 10m; 23 Oct vs 30 Oct; −£111.69**
![E14](journal/e14-future-shift-fixed.jpg)

**E15 · 5 Nov · Gemini's verified breakdown: −£54.13, −£27.04, −£30.52**
![E15](journal/e15-gemini-111-69-breakdown.jpg)

**E16 · 5 Nov · Gemini refuses to call the upcoming 6 Nov shift "lost money"**
![E16](journal/e16-gemini-future-shift-refusal.jpg)

### The pay-query workflow

**E17 · 5 Nov · AI-prepared pay query — "NOT SAVED YET"**
Recorded 30 Oct 23:30 → claimed 31 Oct 00:30 (+1h); evidence built by code.
![E17](journal/e17-pay-query-proposal.jpg)

**E18 · 5 Nov · Manager inbox: submitted query with evidence**
Note the AI-written summary states the claim as fact (§9 item 5).
![E18](journal/e18-manager-inbox-submitted.jpg)

**E19 · 5 Nov · After Accept: still 6h, £154.77 provisional, £0 allocated, £0 paid**
![E19](journal/e19-after-accept-unchanged.jpg)

**E20 · 5 Nov · Read-only `paypal-check` passes — no money moved**
Sandbox environment, client-credential auth, Payouts permission, 5 masked allowlisted recipients, limits £200/£1,000.
![E20](journal/e20-paypal-check-readonly.jpg)

**E21 · 5 Nov · Query "Resolved" — recorded clock-out still 23:30**
![E21](journal/e21-query-resolved.jpg)

### Local rehearsals (🧪 fake credentials — not live evidence)

**L01 · 5 Nov · Isolated-environment banner; Sam's accepted query, seeded by `demo:setup`**
![L01](journal/l01-local-sandbox-banner-accepted-query.jpg)

**L02 · 5 Nov · After the 00:30 correction and Save & lock, "Approve & pay" is available (£510.00 to 5 workers) — not clicked**
![L02](journal/l02-local-approve-form-available.jpg)

### Screen recordings (kept outside the repository)

- *Screen Recording 2026-11-04 at 23.38.35* — ~2 min, early manager/shift interactions
- *Screen Recording 2026-11-05 at 00.49.12* — ~13 s, pay-query proposal
- *Screen Recording 2026-11-05 at 01.10.46* — ~17 s, Gemini/dispute workflow

---

*Provenance: this journal combines the repository (commits, `SPEC.md`, `TASKS.md`, tests), the project owner's interim report and handoff (5 Nov 2026), and the screenshots above. It is a curated record, not a full chat export. The final edition will be written after the isolated sandbox payout and the submission.*
