/**
 * Validates the model's final answer against the turn's fact ledger and turns
 * it into render-safe segments. The model may only state numbers, times,
 * statuses and PayPal ids via [[fact_id]] placeholders; anything else that
 * looks like one is rejected.
 */
import type { Fact, FactLedger } from "./facts";

export type Segment = { type: "text"; text: string } | { type: "fact"; factId: string; display: string; kind: Fact["kind"]; label: string; sourceLabel: string };

export type Validation = { ok: true; segments: Segment[]; usedFacts: Fact[] } | { ok: false; violations: string[] };

const PLACEHOLDER = /\[\[\s*(f\d{1,4})\s*\]\]/g;

const RAW_RULES: Array<[RegExp, string]> = [
  [/£|€|\$|\bGBP\b|\bUSD\b/i, "a currency amount written directly"],
  [/\d[\d,]*(?:\.\d+)?\s*(?:pounds?|quid|pence|p)\b/i, "a money amount written directly"],
  [/\d\s*%|\d+\s*per\s?cent/i, "a percentage written directly"],
  [/\d+(?:\.\d+)?\s*(?:h|hrs?|hours?|mins?|minutes?)\b/i, "hours or minutes written directly"],
  [/\b\d{1,2}[:.]\d{2}\s*(?:am|pm)?\b/i, "a clock time written directly"],
  [/\b\d{1,2}\s*(?:am|pm)\b/i, "a clock time written directly"],
  [/\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{10,}\b/, "an ID written directly"],
  [/\d(?:\.\d+)?\s*[×x](?:\s|$|[.,;])/i, "a weight written directly"],
];

const PAID_CLAIMS = [
  /\byou(?:'ve| have)? (?:already )?been paid\b/i,
  /\b(?:was|were|has been|have been) paid\b/i,
  /\bpayment (?:was|has been|is) (?:sent|made|completed|successful)\b/i,
  /\b(?:paid|sent) (?:to you|into your|to your paypal)\b/i,
  /\bpaypal (?:has )?(?:sent|paid|transferred)\b/i,
];

export function validateAnswer(answer: string, ledger: FactLedger): Validation {
  const violations: string[] = [];
  if (!answer.trim()) violations.push("the answer is empty");
  if (answer.length > 3000) violations.push("the answer is too long");

  const used: Fact[] = [];
  for (const m of answer.matchAll(PLACEHOLDER)) {
    const f = ledger.get(m[1]);
    if (!f) violations.push(`[[${m[1]}]] is not a fact returned by a tool in this turn`);
    else if (!used.includes(f)) used.push(f);
  }

  const prose = answer.replace(PLACEHOLDER, " ");
  for (const [re, what] of RAW_RULES) {
    const hit = prose.match(re);
    if (hit) violations.push(`it contains ${what} ("${hit[0].trim()}") instead of a [[fact]] placeholder`);
  }
  // Stray brackets suggest a malformed placeholder.
  if (/\[\[|\]\]/.test(prose)) violations.push("it contains a malformed [[fact]] placeholder");

  if (!ledger.hasSuccessfulPayout()) {
    const withFacts = answer.replace(PLACEHOLDER, (_, id) => ledger.get(id)?.display ?? "");
    for (const re of PAID_CLAIMS) {
      const hit = withFacts.match(re);
      if (hit) violations.push(`it says "${hit[0]}" but no PayPal payout has succeeded`);
    }
  }

  if (violations.length) return { ok: false, violations };

  const segments: Segment[] = [];
  let last = 0;
  for (const m of answer.matchAll(PLACEHOLDER)) {
    if (m.index! > last) segments.push({ type: "text", text: answer.slice(last, m.index) });
    const f = ledger.get(m[1])!;
    segments.push({ type: "fact", factId: f.id, display: f.display, kind: f.kind, label: f.label, sourceLabel: f.source.label });
    last = m.index! + m[0].length;
  }
  if (last < answer.length) segments.push({ type: "text", text: answer.slice(last) });
  return { ok: true, segments, usedFacts: used };
}

export type EvidenceCard = { sourceType: Fact["source"]["type"]; sourceId: string; title: string; items: Array<{ label: string; display: string }> };

/** Evidence cards: built by code from the facts the answer actually used. */
export function evidenceCards(facts: Fact[]): EvidenceCard[] {
  const cards = new Map<string, EvidenceCard>();
  for (const f of facts) {
    const key = `${f.source.type}:${f.source.id}`;
    const card = cards.get(key) ?? { sourceType: f.source.type, sourceId: f.source.id, title: f.source.label, items: [] };
    if (!card.items.some((i) => i.label === f.label && i.display === f.display)) card.items.push({ label: f.label, display: f.display });
    cards.set(key, card);
  }
  return [...cards.values()];
}
