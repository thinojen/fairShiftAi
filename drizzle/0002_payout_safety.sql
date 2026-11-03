ALTER TABLE "pay_queries" DROP CONSTRAINT "pay_queries_worker_id_workers_id_fk";
--> statement-breakpoint
ALTER TABLE "payout_batches" DROP CONSTRAINT "payout_batches_venue_id_venues_id_fk";
--> statement-breakpoint
ALTER TABLE "payout_batches" DROP CONSTRAINT "payout_batches_shift_id_shifts_id_fk";
--> statement-breakpoint
ALTER TABLE "payouts" DROP CONSTRAINT "payouts_batch_id_payout_batches_id_fk";
--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "receiver_email" text NOT NULL;--> statement-breakpoint
ALTER TABLE "payouts" ADD COLUMN "reconciliation_issue" text;--> statement-breakpoint
ALTER TABLE "pay_queries" ADD CONSTRAINT "pay_queries_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_batches" ADD CONSTRAINT "payout_batches_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payout_batches" ADD CONSTRAINT "payout_batches_shift_id_shifts_id_fk" FOREIGN KEY ("shift_id") REFERENCES "public"."shifts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_batch_id_payout_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."payout_batches"("id") ON DELETE restrict ON UPDATE no action;