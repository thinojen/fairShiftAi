/**
 * Drizzle schema — the single source of truth for the database (SPEC §4).
 * SQL migrations in /drizzle are GENERATED from this file: `npm run db:generate`.
 *
 * Conventions
 * - Money: integer pence (`*_pence`). Never floats.
 * - Hours: integer minutes (`*_minutes`). Role weights: integer basis points
 *   (1.2 → 120) so tip maths stays in integers. See SPEC "Amendments".
 * - IDs: text. Seed data uses readable, stable IDs (e.g. "w_sam") so reseeding is
 *   repeatable and the AI can cite records; runtime rows use random UUIDs.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

// ---------- enums ----------
export const roleEnum = pgEnum("role", ["bartender", "server", "runner", "host", "kitchen"]);
export const serviceEnum = pgEnum("service", ["lunch", "dinner", "late"]);
export const shiftStatusEnum = pgEnum("shift_status", ["open", "closed", "paid"]);
export const assignmentStatusEnum = pgEnum("assignment_status", [
  "scheduled",
  "worked",
  "no_show",
  "uncovered",
]);
export const tipSourceEnum = pgEnum("tip_source", ["card", "cash", "service_charge"]);
export const batchStatusEnum = pgEnum("payout_batch_status", [
  "created", // row + sender_batch_id persisted, nothing sent to PayPal yet
  "sending", // a request currently holds the send claim (see lib/payouts/service.ts)
  "submitted", // POST accepted by PayPal (does NOT mean anyone is paid)
  "pending",
  "processing",
  "success", // PayPal finished processing the batch (items may still differ)
  "denied",
  "canceled",
  "error", // last send attempt failed; outcome may be uncertain — retry with the SAME sender_batch_id
]);
export const batchKindEnum = pgEnum("payout_batch_kind", ["shift", "correction"]);
export const correctionFieldEnum = pgEnum("correction_field", ["clock_in", "clock_out", "break_minutes"]);
/** Mirrors PayPal payout *item* transaction_status values, lower-cased. */
export const payoutStatusEnum = pgEnum("payout_status", [
  "pending",
  "success",
  "failed",
  "unclaimed",
  "returned",
  "onhold",
  "blocked",
  "refunded",
  "reversed",
]);
export const flagTypeEnum = pgEnum("flag_type", [
  "missing_clock_out",
  "long_shift",
  "rota_mismatch",
  "no_show",
  "break_missing",
]);
export const flagStatusEnum = pgEnum("flag_status", ["open", "resolved"]);
export const payQueryStatusEnum = pgEnum("pay_query_status", [
  "draft",
  "submitted",
  "approved",
  "rejected",
]);

// ---------- core ----------
export const venues = pgTable("venues", {
  id: id(),
  name: text("name").notNull(),
  createdAt: createdAt(),
});

export const workers = pgTable("workers", {
  id: id(),
  venueId: text("venue_id").notNull().references(() => venues.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  role: roleEnum("role").notNull(),
  /** Must be an allowlisted PayPal SANDBOX personal account email. */
  paypalEmail: text("paypal_email").notNull(),
  hourlyRatePence: integer("hourly_rate_pence").notNull(),
  createdAt: createdAt(),
});

export const tipPolicies = pgTable(
  "tip_policies",
  {
    id: id(),
    venueId: text("venue_id").notNull().references(() => venues.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    /** See TipPolicyRules in lib/tips/policy.ts */
    rules: jsonb("rules").$type<TipPolicyRules>().notNull(),
    textSummary: text("text_summary").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("tip_policies_venue_version").on(t.venueId, t.version)],
);

export type TipPolicyRules = {
  method: "minutes_x_weight";
  /** Role weights in basis points: 120 = 1.2× */
  weightsBp: Record<"bartender" | "server" | "runner" | "host" | "kitchen", number>;
  minMinutesToQualify: number;
  rounding: "largest_remainder";
};

export const shifts = pgTable("shifts", {
  id: id(),
  venueId: text("venue_id").notNull().references(() => venues.id, { onDelete: "cascade" }),
  date: date("date").notNull(),
  service: serviceEnum("service").notNull(),
  status: shiftStatusEnum("status").notNull().default("open"),
  createdAt: createdAt(),
});

export const shiftAssignments = pgTable(
  "shift_assignments",
  {
    id: id(),
    shiftId: text("shift_id").notNull().references(() => shifts.id, { onDelete: "cascade" }),
    /** Null when the slot is uncovered. */
    workerId: text("worker_id").references(() => workers.id, { onDelete: "set null" }),
    role: roleEnum("role").notNull(),
    scheduledStart: timestamp("scheduled_start", { withTimezone: true }).notNull(),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true }).notNull(),
    clockIn: timestamp("clock_in", { withTimezone: true }),
    clockOut: timestamp("clock_out", { withTimezone: true }),
    breakMinutes: integer("break_minutes").notNull().default(0),
    status: assignmentStatusEnum("status").notNull().default("scheduled"),
    /**
     * Evidence: the values as first recorded, captured on the first manual
     * correction and never changed afterwards. Full history: time_corrections.
     */
    hoursCorrected: boolean("hours_corrected").notNull().default(false),
    originalClockIn: timestamp("original_clock_in", { withTimezone: true }),
    originalClockOut: timestamp("original_clock_out", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("shift_assignments_shift").on(t.shiftId), index("shift_assignments_worker").on(t.workerId)],
);

export const tipPools = pgTable("tip_pools", {
  id: id(),
  shiftId: text("shift_id").notNull().references(() => shifts.id, { onDelete: "cascade" }),
  grossPence: integer("gross_pence").notNull(),
  source: tipSourceEnum("source").notNull(),
  /** Seeded demonstration pool — NOT funded through PayPal Orders. */
  isDemo: boolean("is_demo").notNull().default(false),
  paypalOrderId: text("paypal_order_id"),
  fundedAt: timestamp("funded_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const allocations = pgTable(
  "allocations",
  {
    id: id(),
    tipPoolId: text("tip_pool_id").notNull().references(() => tipPools.id, { onDelete: "cascade" }),
    workerId: text("worker_id").notNull().references(() => workers.id, { onDelete: "cascade" }),
    policyId: text("policy_id").notNull().references(() => tipPolicies.id),
    workedMinutes: integer("worked_minutes").notNull(),
    weightBp: integer("weight_bp").notNull(),
    points: integer("points").notNull(),
    sharePence: integer("share_pence").notNull(),
    /** Full deterministic calculation trace from the tip engine. */
    explanationJson: jsonb("explanation_json").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("allocations_pool_worker").on(t.tipPoolId, t.workerId)],
);

// ---------- payouts ----------
export const payoutBatches = pgTable(
  "payout_batches",
  {
  id: id(),
  venueId: text("venue_id").notNull().references(() => venues.id, { onDelete: "cascade" }),
  shiftId: text("shift_id").notNull().references(() => shifts.id, { onDelete: "cascade" }),
  kind: batchKindEnum("kind").notNull().default("shift"),
  /** Idempotency key sent to PayPal. Generated once, reused on every retry. */
  senderBatchId: text("sender_batch_id").notNull().unique(),
  paypalBatchId: text("paypal_batch_id").unique(),
  status: batchStatusEnum("status").notNull().default("created"),
  /** Who approved it (demo role label) — payouts always need manager approval. */
  approvedBy: text("approved_by").notNull(),
  lastError: text("last_error"),
  /** Number of times this batch was sent to PayPal (always with the same sender_batch_id). */
  sendAttempts: integer("send_attempts").notNull().default(0),
  lastStatusCheckAt: timestamp("last_status_check_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // At most ONE tip-pool payout batch per shift. Correction batches (Milestone 4) are separate.
  (t) => [uniqueIndex("payout_batches_one_per_shift").on(t.shiftId).where(sql`${t.kind} = 'shift'`)],
);

export const payouts = pgTable(
  "payouts",
  {
    id: id(),
    batchId: text("batch_id").notNull().references(() => payoutBatches.id, { onDelete: "cascade" }),
    workerId: text("worker_id").notNull().references(() => workers.id),
    /** Null for correction payouts (those link from pay_queries instead). */
    allocationId: text("allocation_id").references(() => allocations.id),
    amountPence: integer("amount_pence").notNull(),
    /** Per-item idempotency key sent to PayPal (allocation id or pay query id). */
    senderItemId: text("sender_item_id").notNull().unique(),
    paypalItemId: text("paypal_item_id").unique(),
    paypalTransactionId: text("paypal_transaction_id"),
    /** Per-recipient status — a successful batch does not mean every item succeeded. */
    status: payoutStatusEnum("status").notNull().default("pending"),
    errorMessage: text("error_message"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("payouts_worker").on(t.workerId)],
);

/** Every PayPal webhook we receive, keyed by PayPal's event id for duplicate safety. */
export const webhookEvents = pgTable("webhook_events", {
  id: text("id").primaryKey(), // PayPal event id
  eventType: text("event_type").notNull(),
  resourceId: text("resource_id"),
  verified: boolean("verified").notNull(),
  payload: jsonb("payload").notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

// ---------- review & disputes ----------
/** Append-only history of manual hour corrections. Nothing here is ever updated or deleted. */
export const timeCorrections = pgTable(
  "time_corrections",
  {
    id: id(),
    shiftAssignmentId: text("shift_assignment_id")
      .notNull()
      .references(() => shiftAssignments.id, { onDelete: "cascade" }),
    field: correctionFieldEnum("field").notNull(),
    /** ISO timestamp, minutes as a string, or null if the value was missing. */
    originalValue: text("original_value"),
    newValue: text("new_value").notNull(),
    actor: text("actor").notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("time_corrections_assignment").on(t.shiftAssignmentId)],
);

export const flags = pgTable("flags", {
  id: id(),
  shiftAssignmentId: text("shift_assignment_id")
    .notNull()
    .references(() => shiftAssignments.id, { onDelete: "cascade" }),
  type: flagTypeEnum("type").notNull(),
  message: text("message").notNull(),
  status: flagStatusEnum("status").notNull().default("open"),
  createdAt: createdAt(),
});

export const payQueries = pgTable("pay_queries", {
  id: id(),
  workerId: text("worker_id").notNull().references(() => workers.id, { onDelete: "cascade" }),
  allocationId: text("allocation_id").notNull().references(() => allocations.id),
  workerMessage: text("worker_message").notNull(),
  aiSummary: text("ai_summary"),
  evidenceJson: jsonb("evidence_json"),
  status: payQueryStatusEnum("status").notNull().default("draft"),
  resolutionNote: text("resolution_note"),
  correctionPayoutId: text("correction_payout_id").references(() => payouts.id),
  createdAt: createdAt(),
});

export const auditLog = pgTable("audit_log", {
  id: id(),
  actor: text("actor").notNull(),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id").notNull(),
  data: jsonb("data"),
  createdAt: createdAt(),
});
