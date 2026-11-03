/**
 * The fact ledger. Every value the assistant may state (money, hours, times,
 * percentages, statuses, PayPal IDs, policy versions) is registered here by
 * deterministic code, with its display string and the record it came from.
 * The model can only refer to facts by id; the server substitutes the trusted
 * display value when rendering.
 */

export type FactKind = "money" | "minutes" | "time" | "percent" | "status" | "policy" | "paypal_id" | "date" | "weight" | "count";

export type FactSource = {
  type: "shift" | "tip_pool" | "policy" | "allocation" | "payout" | "comparison" | "pay_query";
  /** The database record id (or comparison key) this value comes from. */
  id: string;
  /** Human label, e.g. "Fri 30 Oct 2026 dinner". */
  label: string;
};

export type Fact = {
  id: string;
  kind: FactKind;
  /** Deterministic display text, e.g. "£154.77", "6h", "Provisional (not locked, not paid)". */
  display: string;
  /** What this value is, e.g. "Your share", "Tip pool". */
  label: string;
  source: FactSource;
  /** Machine value for checks (pence, minutes, status code…). */
  value?: string | number | boolean | null;
};

export class FactLedger {
  private facts = new Map<string, Fact>();
  private n = 0;

  add(f: Omit<Fact, "id">): { fact: string; display: string } {
    // Same value from the same record → same id (keeps references stable within a turn).
    for (const existing of this.facts.values()) {
      if (existing.kind === f.kind && existing.label === f.label && existing.display === f.display && existing.source.id === f.source.id) {
        return { fact: existing.id, display: existing.display };
      }
    }
    const id = `f${++this.n}`;
    this.facts.set(id, { ...f, id });
    return { fact: id, display: f.display };
  }

  get(id: string) {
    return this.facts.get(id);
  }

  all() {
    return [...this.facts.values()];
  }

  hasSuccessfulPayout() {
    return this.all().some((f) => f.kind === "status" && f.source.type === "payout" && f.value === "success");
  }
}

/** The single-string form the MODEL sees for a fact: [[f12|−£111.69]]. */
export function factToken(id: string, display: string) {
  return `[[${id}|${display}]]`;
}

/**
 * Serialise a tool result for the model: every {fact, display} pair becomes one
 * self-verifying token string, so the model can copy it verbatim instead of
 * re-typing the value. The validator checks the text after "|" against the ledger.
 */
export function toModelPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toModelPayload);
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 2 && typeof o.fact === "string" && typeof o.display === "string") return factToken(o.fact, o.display);
    return Object.fromEntries(keys.map((k) => [k, toModelPayload(o[k])]));
  }
  return value;
}
