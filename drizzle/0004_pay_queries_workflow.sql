ALTER TABLE "pay_queries" DROP CONSTRAINT "pay_queries_allocation_id_allocations_id_fk";
--> statement-breakpoint
ALTER TABLE "pay_queries" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "pay_queries" ALTER COLUMN "status" SET DEFAULT 'draft'::text;--> statement-breakpoint
DROP TYPE "public"."pay_query_status";--> statement-breakpoint
CREATE TYPE "public"."pay_query_status" AS ENUM('draft', 'submitted', 'accepted', 'resolved', 'rejected');--> statement-breakpoint
ALTER TABLE "pay_queries" ALTER COLUMN "status" SET DEFAULT 'draft'::"public"."pay_query_status";--> statement-breakpoint
ALTER TABLE "pay_queries" ALTER COLUMN "status" SET DATA TYPE "public"."pay_query_status" USING "status"::"public"."pay_query_status";--> statement-breakpoint
ALTER TABLE "pay_queries" ALTER COLUMN "allocation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_queries" ADD COLUMN "shift_assignment_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_queries" ADD COLUMN "field" "correction_field" NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_queries" ADD COLUMN "recorded_value" text;--> statement-breakpoint
ALTER TABLE "pay_queries" ADD COLUMN "claimed_value" text NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_queries" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "pay_queries" ADD COLUMN "submitted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pay_queries" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "pay_queries" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "pay_queries" ADD CONSTRAINT "pay_queries_shift_assignment_id_shift_assignments_id_fk" FOREIGN KEY ("shift_assignment_id") REFERENCES "public"."shift_assignments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pay_queries_one_open_per_shift" ON "pay_queries" USING btree ("worker_id","shift_assignment_id") WHERE "pay_queries"."status" in ('draft', 'submitted', 'accepted');