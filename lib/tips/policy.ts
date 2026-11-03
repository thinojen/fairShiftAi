/** Choose the tipping policy version in force on a shift date. Pure. */
export type DatedPolicy = { id: string; version: number; effectiveFrom: string };

/**
 * Returns the policy with the latest `effectiveFrom` that is on or before the
 * shift date (both "YYYY-MM-DD"). Ties are broken by the higher version.
 */
export function policyForDate<P extends DatedPolicy>(policies: readonly P[], shiftDate: string): P | null {
  let best: P | null = null;
  for (const p of policies) {
    if (p.effectiveFrom > shiftDate) continue;
    if (!best || p.effectiveFrom > best.effectiveFrom || (p.effectiveFrom === best.effectiveFrom && p.version > best.version)) {
      best = p;
    }
  }
  return best;
}
