CREATE TYPE "public"."payout_batch_kind" AS ENUM('shift', 'correction');--> statement-breakpoint
CREATE TYPE "public"."correction_field" AS ENUM('clock_in', 'clock_out', 'break_minutes');--> statement-breakpoint
ALTER TYPE "public"."payout_batch_status" ADD VALUE 'sending' BEFORE 'submitted';--> statement-breakpoint
CREATE TABLE "time_corrections" (
	"id" text PRIMARY KEY NOT NULL,
	"shift_assignment_id" text NOT NULL,
	"field" "correction_field" NOT NULL,
	"original_value" text,
	"new_value" text NOT NULL,
	"actor" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payout_batches" ADD COLUMN "shift_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_batches" ADD COLUMN "kind" "payout_batch_kind" DEFAULT 'shift' NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_batches" ADD COLUMN "send_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payout_batches" ADD COLUMN "last_status_check_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD COLUMN "hours_corrected" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD COLUMN "original_clock_in" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "shift_assignments" ADD COLUMN "original_clock_out" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "tip_pools" ADD COLUMN "is_demo" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "time_corrections" ADD CONSTRAINT "time_corrections_shift_assignment_id_shift_assignments_id_fk" FOREIGN KEY ("shift_assignment_id") REFERENCES "public"."shift_assignments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "time_corrections_assignment" ON "time_corrections" USING btree ("shift_assignment_id");--> statement-breakpoint
ALTER TABLE "payout_batches" ADD CONSTRAINT "payout_batches_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payout_batches_one_per_shift" ON "payout_batches" USING btree ("shift_id") WHERE "payout_batches"."kind" = 'shift';