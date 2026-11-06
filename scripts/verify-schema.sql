-- Clean-database invariant checks. Run after `supabase db reset`.
-- Any failed invariant raises an exception and fails CI.

DO $$
BEGIN
  -- 1. pg_cron must be installed and the reconciliation job must be scheduled and active exactly once.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'INVARIANT FAILED: pg_cron extension is not installed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'reconcile-stale-live-sessions' AND active = TRUE
  ) THEN
    RAISE EXCEPTION 'INVARIANT FAILED: reconcile-stale-live-sessions cron job is missing or inactive';
  END IF;

  IF (SELECT count(*) FROM cron.job WHERE jobname = 'reconcile-stale-live-sessions') <> 1 THEN
    RAISE EXCEPTION 'INVARIANT FAILED: expected exactly one reconcile-stale-live-sessions cron job';
  END IF;

  -- 2. Explicit billing state must exist and be constrained.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'live_sessions'
      AND column_name = 'billing_state'
  ) THEN
    RAISE EXCEPTION 'INVARIANT FAILED: live_sessions.billing_state column is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'live_sessions_billing_state_check'
  ) THEN
    RAISE EXCEPTION 'INVARIANT FAILED: live_sessions billing_state check constraint is missing';
  END IF;

  -- 3. Required functions and signatures.
  IF to_regprocedure('public.set_session_billing_state(uuid,uuid,text)') IS NULL THEN
    RAISE EXCEPTION 'INVARIANT FAILED: set_session_billing_state is missing';
  END IF;

  IF to_regprocedure('public.credit_verified_payment(text,text,bigint,text,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'INVARIANT FAILED: credit_verified_payment does not have the verified amount/currency signature';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.parameters p
    JOIN information_schema.routines r ON r.specific_name = p.specific_name
    WHERE r.routine_schema = 'public'
      AND r.routine_name = 'heartbeat_and_meter_session'
      AND p.parameter_mode = 'OUT'
      AND p.parameter_name = 'billing_state'
  ) THEN
    RAISE EXCEPTION 'INVARIANT FAILED: heartbeat_and_meter_session does not return billing_state';
  END IF;

  -- 4. Duplicate-credit and duplicate-session protection.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_wallet_transactions_unique_top_up_reference'
  ) THEN
    RAISE EXCEPTION 'INVARIANT FAILED: unique top-up reference index is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_unique_active_user_live_session'
  ) THEN
    RAISE EXCEPTION 'INVARIANT FAILED: one-active-session unique index is missing';
  END IF;

  -- 5. Reconciliation audit table must exist and be protected by RLS.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'reconciliation_logs'
  ) THEN
    RAISE EXCEPTION 'INVARIANT FAILED: reconciliation_logs table is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'reconciliation_logs' AND relrowsecurity = TRUE
  ) THEN
    RAISE EXCEPTION 'INVARIANT FAILED: reconciliation_logs must have RLS enabled';
  END IF;
END;
$$;

SELECT 'schema verification passed' AS result;
