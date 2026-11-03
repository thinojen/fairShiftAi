/**
 * Demo seed / reset. Re-inserts the synthetic data from seed-data.ts in one
 * transaction.
 *
 * Safety
 * - Imports nothing from lib/paypal: seeding can never create, repeat or alter
 *   a PayPal transaction.
 * - REFUSES to run if any payment history exists (payout batches, payouts or
 *   pay queries). It will not delete them, and there is no override flag.
 * - NEVER deletes the audit log or PayPal webhook events. It only appends a
 *   "demo.seed" entry.
 * - The database also blocks DELETE/TRUNCATE on those tables (migration 0003),
 *   so even a bug here could not erase them.
 */
import { count } from "drizzle-orm";
import type { Db } from "./connect";
import * as s from "./schema";
import {
  DEMO_POLICIES,
  DEMO_SHIFTS,
  DEMO_VENUE_ID,
  demoWorkersWithEmails,
} from "./seed-data";

export class SeedRefusedError extends Error {
  name = "SeedRefusedError";
}

export async function paymentHistoryCounts(db: Db) {
  const [[b], [p], [q]] = await Promise.all([
    db.select({ n: count() }).from(s.payoutBatches),
    db.select({ n: count() }).from(s.payouts),
    db.select({ n: count() }).from(s.payQueries),
  ]);
  return { payoutBatches: b.n, payouts: p.n, payQueries: q.n };
}

export async function seedDemo(db: Db, opts: { recipientsCsv?: string } = {}) {
  await db.transaction(async (tx) => {
    // Checked inside the transaction so nothing can slip in between check and wipe.
    const history = await paymentHistoryCounts(tx as unknown as Db);
    if (history.payoutBatches + history.payouts + history.payQueries > 0) {
      throw new SeedRefusedError(
        `Refusing to reseed: payment history exists (${history.payoutBatches} payout batch(es), ` +
          `${history.payouts} payout(s), ${history.payQueries} pay query(ies)). ` +
          "Payout records are permanent and are never deleted by the seed.",
      );
    }

    // Demo shift data only. audit_log, webhook_events, payout_batches,
    // payouts and pay_queries are never touched here.
    await tx.delete(s.allocations);
    await tx.delete(s.flags);
    await tx.delete(s.timeCorrections);
    await tx.delete(s.tipPools);
    await tx.delete(s.shiftAssignments);
    await tx.delete(s.shifts);
    await tx.delete(s.tipPolicies);
    await tx.delete(s.workers);
    await tx.delete(s.venues);

    await tx.insert(s.venues).values({ id: DEMO_VENUE_ID, name: "The Copper Lantern (demo)" });
    await tx.insert(s.workers).values([...demoWorkersWithEmails(opts.recipientsCsv)]);
    await tx.insert(s.tipPolicies).values(
      DEMO_POLICIES.map((p) => ({ ...p, venueId: DEMO_VENUE_ID, rules: p.rules })),
    );

    for (const sh of DEMO_SHIFTS) {
      await tx.insert(s.shifts).values({
        id: sh.id,
        venueId: DEMO_VENUE_ID,
        date: sh.date,
        service: sh.service,
        status: sh.status,
      });
      await tx.insert(s.shiftAssignments).values(
        sh.assignments.map((a) => ({
          ...a,
          shiftId: sh.id,
          scheduledStart: new Date(a.scheduledStart),
          scheduledEnd: new Date(a.scheduledEnd),
          clockIn: a.clockIn ? new Date(a.clockIn) : null,
          clockOut: a.clockOut ? new Date(a.clockOut) : null,
        })),
      );
      await tx.insert(s.tipPools).values({ ...sh.tipPool, shiftId: sh.id, isDemo: true });
    }

    await tx.insert(s.auditLog).values({
      actor: "system",
      action: "demo.seed",
      entity: "venue",
      entityId: DEMO_VENUE_ID,
    });
  });
}
