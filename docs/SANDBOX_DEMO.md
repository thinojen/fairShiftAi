# Isolated PayPal sandbox demo (GitHub Codespaces)

This runs a **separate, throwaway copy** of FairShift inside a private GitHub
Codespace so a manager can send a **real PayPal SANDBOX payout** through the UI.

- The database is a temporary Postgres **inside the Codespace**. The demo tools
  refuse any other database, so the public Supabase data can't be touched.
- The public site (Render) is unchanged and keeps `PAYOUTS_ENABLED=false`.
- PayPal is the **sandbox** only (hard-coded `api-m.sandbox.paypal.com`).
- Every page shows the banner **"Isolated sandbox environment · synthetic data · PayPal SANDBOX"**.
- Cost: free (Codespaces' monthly free allowance for personal accounts).

## 1. One-time: Codespaces secrets

GitHub → your avatar → **Settings** → **Codespaces** → **Secrets** → **New secret**.
For each one below, choose **Repository access → fairShiftAi**.

| Name | Value |
|---|---|
| `PAYPAL_CLIENT_ID` | Sandbox app client ID (PayPal Developer Dashboard → Apps & Credentials → **Sandbox**) |
| `PAYPAL_CLIENT_SECRET` | Sandbox app secret |
| `PAYPAL_SANDBOX_RECIPIENTS` | 5 sandbox **personal** account emails, comma-separated, in this order: **Sam, Priya, Jordan, Alex, Casey**. Repeats are allowed (e.g. the same account 5 times). |
| `MANAGER_APPROVAL_CODE` | A **new** code, 12+ characters, used only here |
| `GEMINI_API_KEY` | Optional — lets the assistant work in the Codespace too |

**Never** add `DATABASE_URL` as a Codespaces secret.

## 2. Start the Codespace

Repo page → green **Code** button → **Codespaces** tab → **Create codespace on main**.
Wait until the terminal at the bottom finishes `npm ci` (a few minutes the first time).

## 3. Prepare (in the Codespace terminal)

```bash
npm run demo:db          # start the throwaway local database
npm run demo:setup       # seed + Sam's 23:30 fix + Sam's accepted "+1 hour" query
npm run paypal:preflight # READ-ONLY safety checks — sends nothing
```

All automatic checks must show ✓. Then confirm the **manual** checks it prints
(sandbox account type, GBP, business balance, port privacy).

## 4. Run the app

```bash
npm run demo:app         # builds, then serves on port 3000
```

A pop-up offers **Open in Browser**. In the **PORTS** tab, port 3000 must show
**Private** (the default). Never switch it to Public.

## 5. Before pressing "Approve & pay"

After correcting Sam to 00:30 and **Save & lock**, open a second terminal
(**+** in the terminal panel) and run `npm run paypal:preflight` again. It reads
the locked amounts. Only press **Approve & pay** when it passes.

## A new take

A payout can't be repeated for the same shift (by design). For a fresh take:

```bash
npm run demo:db:reset && npm run demo:setup
```

(Stop `demo:app` with Ctrl+C first, and start it again afterwards.)

## When finished

Codespaces page (github.com/codespaces) → **⋯** → **Delete**. Nothing persists.
