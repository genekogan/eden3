-- T08-U01 (2026-08-08): codify the live-box partial index behind netSpendSince's
-- refund-correlation lateral (RUNBOOK §12 "Missing ledger index" bullet — created
-- live on the eden2 box on 2026-08-05 with CREATE INDEX CONCURRENTLY after the
-- unindexed lateral seq-scanned 1.14M manna_transactions per spend row).
--
-- Catalog-guarded on purpose:
--   * exists + correct + valid  -> return via catalog reads only. No CREATE INDEX
--     is issued, so no lock of any mode is taken on manna_transactions — safe
--     against a live-serving database (the prod box; local canonical eden3 after
--     its concurrent pre-create). Plain CREATE INDEX IF NOT EXISTS would still
--     take the SHARE lock before resolving the name, and never verifies the
--     existing definition.
--   * absent                    -> plain transactional CREATE INDEX (fresh DBs).
--   * exists but wrong/invalid  -> RAISE so the migration fails loudly (and is
--     not journaled) instead of recording success over a broken index.
-- CONCURRENTLY deliberately does not appear here: drizzle runs migrations inside
-- a transaction, and concurrent builds are not transaction-safe. Operational
-- recovery for a failed concurrent pre-create: DROP INDEX CONCURRENTLY, retry.
DO $$
DECLARE
  existing_def text;
  existing_valid boolean;
BEGIN
  -- Pin the deparser so the definition comparison is deterministic even under
  -- quote_all_identifiers=on (set_config with is_local=true reverts at commit).
  PERFORM set_config('quote_all_identifiers', 'off', true);

  SELECT pg_get_indexdef(ix.indexrelid), ix.indisvalid
    INTO existing_def, existing_valid
    FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
   WHERE i.relname = 'idx_manna_tx_refunds_tx'
     AND t.relname = 'manna_transactions'
     AND n.nspname = 'public';

  IF existing_def IS NULL THEN
    -- Schema-qualified so a foreign search_path can never aim this at a shadow
    -- table while the guard above inspects public.
    EXECUTE 'CREATE INDEX "idx_manna_tx_refunds_tx" ON public."manna_transactions" USING btree ("refunds_transaction_id") WHERE "refunds_transaction_id" IS NOT NULL';
    RETURN;
  END IF;

  IF existing_valid AND existing_def =
    'CREATE INDEX idx_manna_tx_refunds_tx ON public.manna_transactions USING btree (refunds_transaction_id) WHERE (refunds_transaction_id IS NOT NULL)'
  THEN
    -- Already the exact live-box index: nothing to do, no lock taken.
    RETURN;
  END IF;

  RAISE EXCEPTION 'idx_manna_tx_refunds_tx exists but does not match the expected definition (valid=%, def=%)',
    existing_valid, existing_def;
END $$;
