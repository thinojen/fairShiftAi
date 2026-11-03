-- Custom SQL migration file, put your code below! --
-- Payment history and the audit log are permanent.
-- Rows in these tables can be UPDATED (e.g. payout status reconciliation) but
-- never DELETED or TRUNCATED — by the app, the seed, or a stray SQL statement.
-- Removing this protection requires a deliberate migration that drops the triggers.

CREATE OR REPLACE FUNCTION fairshift_block_history_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'FairShift: rows in "%" are permanent payment/audit history and cannot be deleted', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payout_batches_no_delete BEFORE DELETE ON "payout_batches" FOR EACH ROW EXECUTE FUNCTION fairshift_block_history_delete();
--> statement-breakpoint
CREATE TRIGGER payout_batches_no_truncate BEFORE TRUNCATE ON "payout_batches" FOR EACH STATEMENT EXECUTE FUNCTION fairshift_block_history_delete();
--> statement-breakpoint
CREATE TRIGGER payouts_no_delete BEFORE DELETE ON "payouts" FOR EACH ROW EXECUTE FUNCTION fairshift_block_history_delete();
--> statement-breakpoint
CREATE TRIGGER payouts_no_truncate BEFORE TRUNCATE ON "payouts" FOR EACH STATEMENT EXECUTE FUNCTION fairshift_block_history_delete();
--> statement-breakpoint
CREATE TRIGGER pay_queries_no_delete BEFORE DELETE ON "pay_queries" FOR EACH ROW EXECUTE FUNCTION fairshift_block_history_delete();
--> statement-breakpoint
CREATE TRIGGER pay_queries_no_truncate BEFORE TRUNCATE ON "pay_queries" FOR EACH STATEMENT EXECUTE FUNCTION fairshift_block_history_delete();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON "audit_log" FOR EACH ROW EXECUTE FUNCTION fairshift_block_history_delete();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON "audit_log" FOR EACH STATEMENT EXECUTE FUNCTION fairshift_block_history_delete();
