CREATE TYPE "public"."assignment_status" AS ENUM('scheduled', 'worked', 'no_show', 'uncovered');--> statement-breakpoint
CREATE TYPE "public"."payout_batch_status" AS ENUM('created', 'submitted', 'pending', 'processing', 'success', 'denied', 'canceled', 'error');--> statement-breakpoint
CREATE TYPE "public"."flag_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."flag_type" AS ENUM('missing_clock_out', 'long_shift', 'rota_mismatch', 'no_show', 'break_missing');--> statement-breakpoint
CREATE TYPE "public"."pay_query_status" AS ENUM('draft', 'submitted', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."payout_status" AS ENUM('pending', 'success', 'failed', 'unclaimed', 'returned', 'onhold', 'blocked', 'refunded', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('bartender', 'server', 'runner', 'host', 'kitchen');--> statement-breakpoint
CREATE TYPE "public"."service" AS ENUM('lunch', 'dinner', 'late');--> statement-breakpoint
CREATE TYPE "public"."shift_status" AS ENUM('open', 'closed', 'paid');--> statement-breakpoint
CREATE TYPE "public"."tip_source" AS ENUM('card', 'cash', 'service_charge');--> statement-breakpoint
CREATE TABLE "allocations" (
	"id" text PRIMARY KEY NOT NULL,
	"tip_pool_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"policy_id" text NOT NULL,
	"worked_minutes" integer NOT NULL,
	"weight_bp" integer NOT NULL,
	"points" integer NOT NULL,
	"share_pence" integer NOT NULL,
	"explanation_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flags" (
	"id" text PRIMARY KEY NOT NULL,
	"shift_assignment_id" text NOT NULL,
	"type" "flag_type" NOT NULL,
	"message" text NOT NULL,
	"status" "flag_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pay_queries" (
	"id" text PRIMARY KEY NOT NULL,
	"worker_id" text NOT NULL,
	"allocation_id" text NOT NULL,
	"worker_message" text NOT NULL,
	"ai_summary" text,
	"evidence_json" jsonb,
	"status" "pay_query_status" DEFAULT 'draft' NOT NULL,
	"resolution_note" text,
	"correction_payout_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payout_batches" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_id" text NOT NULL,
	"sender_batch_id" text NOT NULL,
	"paypal_batch_id" text,
	"status" "payout_batch_status" DEFAULT 'created' NOT NULL,
	"approved_by" text NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payout_batches_sender_batch_id_unique" UNIQUE("sender_batch_id"),
	CONSTRAINT "payout_batches_paypal_batch_id_unique" UNIQUE("paypal_batch_id")
);
--> statement-breakpoint
CREATE TABLE "payouts" (
	"id" text PRIMARY KEY NOT NULL,
	"batch_id" text NOT NULL,
	"worker_id" text NOT NULL,
	"allocation_id" text,
	"amount_pence" integer NOT NULL,
	"sender_item_id" text NOT NULL,
	"paypal_item_id" text,
	"paypal_transaction_id" text,
	"status" "payout_status" DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_sender_item_id_unique" UNIQUE("sender_item_id"),
	CONSTRAINT "payouts_paypal_item_id_unique" UNIQUE("paypal_item_id")
);
--> statement-breakpoint
CREATE TABLE "shift_assignments" (
	"id" text PRIMARY KEY NOT NULL,
	"shift_id" text NOT NULL,
	"worker_id" text,
	"role" "role" NOT NULL,
	"scheduled_start" timestamp with time zone NOT NULL,
	"scheduled_end" timestamp with time zone NOT NULL,
	"clock_in" timestamp with time zone,
	"clock_out" timestamp with time zone,
	"break_minutes" integer DEFAULT 0 NOT NULL,
	"status" "assignment_status" DEFAULT 'scheduled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shifts" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_id" text NOT NULL,
	"date" date NOT NULL,
	"service" "service" NOT NULL,
	"status" "shift_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tip_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_id" text NOT NULL,
	"version" integer NOT NULL,
	"effective_from" date NOT NULL,
	"rules" jsonb NOT NULL,
	"text_summary" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tip_pools" (
	"id" text PRIMARY KEY NOT NULL,
	"shift_id" text NOT NULL,
	"gross_pence" integer NOT NULL,
	"source" "tip_source" NOT NULL,
	"paypal_order_id" text,
	"funded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"resource_id" text,
	"verified" boolean NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" text PRIMARY KEY NOT NULL,
	"venue_id" text NOT NULL,
	"name" text NOT NULL,
	"role" "role" NOT NULL,
	"paypal_email" text NOT NULL,
	"hourly_rate_pence" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_tip_pool_id_tip_pools_id_fk" FOREIGN KEY ("tip_pool_id") REFERENCES "public"."tip_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "allocations" ADD CONSTRAINT "allocations_policy_id_tip_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."tip_policies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flags" ADD CONSTRAINT "flags_shift_assignment_id_shift_assignments_id_fk" FOREIGN KEY ("shift_assignment_id") REFERENCES "public"."shift_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_queries" ADD CONSTRAINT "pay_queries_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_queries" ADD CONSTRAINT "pay_queries_allocation_id_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_queries" ADD CONSTRAINT "pay_queries_correction_payout_id_payouts_id_fk" FOREIGN KEY ("correction_payout_id") REFERENCES "public"."payouts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_batches" ADD CONSTRAINT "payout_batches_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_batch_id_payout_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payout_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_allocation_id_allocations_id_fk" FOREIGN KEY ("allocation_id") REFERENCES "public"."allocations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD CONSTRAINT "shift_assignments_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_policies" ADD CONSTRAINT "tip_policies_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tip_pools" ADD CONSTRAINT "tip_pools_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "allocations_pool_worker" ON "allocations" USING btree ("tip_pool_id","worker_id");--> statement-breakpoint
CREATE INDEX "payouts_worker" ON "payouts" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "shift_assignments_shift" ON "shift_assignments" USING btree ("shift_id");--> statement-breakpoint
CREATE INDEX "shift_assignments_worker" ON "shift_assignments" USING btree ("worker_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tip_policies_venue_version" ON "tip_policies" USING btree ("venue_id","version");