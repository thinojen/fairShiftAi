/**
 * Repeatable demo seed. Wipes demo tables and re-inserts the synthetic data from
 * seed-data.ts inside one transaction.
 *
 * Safety: this module imports nothing from lib/paypal. Seeding or resetting the
 * demo can never create, repeat or alter a PayPal transaction. PayPal webhook
 * history (webhook_events) is deliberately preserved.
 */
import type { Db } from "./connect";
import * as s from "./schema";
import {
  DEMO_POLICIES,
  DEMO_SHIFTS,
  DEMO_VENUE_ID,
  demoWorkersWithEmails,
} from "./seed-data";

export async function seedDemo(db: Db, opts: { recipientsCsv?: string } = {}) {
  await db.transaction(async (tx) => {
    // Children first. webhook_events is intentionally NOT cleared.
    await tx.delete(s.auditLog);
    await tx.delete(s.payQueries);
    await tx.delete(s.payouts);
    await tx.delete(s.payoutBatches);
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
