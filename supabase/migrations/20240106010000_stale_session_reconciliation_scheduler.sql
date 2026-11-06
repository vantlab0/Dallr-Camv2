-- Migration: 20240106010000_stale_session_reconciliation_scheduler.sql
-- Automatic Stale Live Session Reconciliation & Scheduling:
-- 1. Enables pg_cron and FAILS LOUDLY if it is unavailable or cannot be enabled.
-- 2. Creates public.reconciliation_logs audit table to log reconciliation outcomes and errors safely without secrets.
-- 3. Updates public.reconcile_stale_sessions() to:
--    - Enforce service_role / superuser / postgres execution context.
--    - Lock stale active sessions (no heartbeat in > 45s) using FOR UPDATE SKIP LOCKED.
--    - Finalize billing accurately up to the heartbeat lease cap (15s) without overcharging.
--    - Transition status to 'abandoned' with ended_at = last_heartbeat_at.
--    - Be fully idempotent and safe against concurrent execution.
--    - Record detailed execution metrics in public.reconciliation_logs.
-- 4. Registers/schedules pg_cron job 'reconcile-stale-live-sessions' every minute.
--    Registration failure is a hard deployment error. It is NEVER silently ignored.
-- 5. Provides public.verify_reconciliation_scheduler() for post-deploy verification.

-- ---------------------------------------------------------------------------
-- 1. Enable pg_cron (hard failure if unavailable)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron'
  ) THEN
    RAISE EXCEPTION
      'pg_cron extension is not available in this PostgreSQL instance. Stale session reconciliation cannot be scheduled. Enable the pg_cron extension in the Supabase dashboard (Database > Extensions) and re-run the migration.';
  END IF;
END;
$$;

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
  ) THEN
    RAISE EXCEPTION
      'pg_cron extension could not be enabled. Stale session reconciliation cannot be scheduled and deployment must not continue.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname = 'cron'
  ) THEN
    RAISE EXCEPTION
      'pg_cron was reported as installed but the cron schema is missing. Stale session reconciliation cannot be scheduled.';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Structured audit table for reconciliation runs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.reconciliation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name TEXT NOT NULL DEFAULT 'reconcile-stale-live-sessions',
  started_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  completed_at TIMESTAMPTZ,
  sessions_reconciled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  error_message TEXT,
  duration_ms BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_logs_started_at ON public.reconciliation_logs(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_reconciliation_logs_status ON public.reconciliation_logs(status);

ALTER TABLE public.reconciliation_logs ENABLE ROW LEVEL SECURITY;

-- Revoke write permissions from public/authenticated/anon
REVOKE ALL ON TABLE public.reconciliation_logs FROM PUBLIC, anon, authenticated;
-- Only service_role can view or write reconciliation logs
GRANT ALL ON TABLE public.reconciliation_logs TO service_role;

-- ---------------------------------------------------------------------------
-- 3. Stale session reconciler function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reconcile_stale_sessions()
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER := 0;
  v_start_time TIMESTAMPTZ;
  v_end_time TIMESTAMPTZ;
  v_log_id UUID;
  v_duration_ms BIGINT;
  v_stale_record RECORD;
  v_rate_cents_per_sec CONSTANT BIGINT := 4;
  v_max_lease_seconds CONSTANT BIGINT := 15;
  v_raw_elapsed_seconds BIGINT;
  v_billable_delta_seconds BIGINT;
  v_debit_amount_cents BIGINT;
  v_wallet RECORD;
  v_actual_affordable_seconds BIGINT;
  v_actual_debit_cents BIGINT;
BEGIN
  -- Strict caller verification: service_role or internal postgres cron context
  IF NOT public.check_is_service_role() THEN
    RAISE EXCEPTION 'Access denied: reconcile_stale_sessions can only be invoked by service_role';
  END IF;

  v_start_time := timezone('utc'::text, now());

  -- Initialize running audit log
  INSERT INTO public.reconciliation_logs (
    job_name,
    started_at,
    status
  )
  VALUES (
    'reconcile-stale-live-sessions',
    v_start_time,
    'running'
  )
  RETURNING id INTO v_log_id;

  BEGIN
    -- Iterate over active sessions whose heartbeat lease expired (> 45s since last heartbeat)
    -- SKIP LOCKED ensures multiple concurrent reconcilers never contend or double-process
    FOR v_stale_record IN
      SELECT
        s.id,
        s.user_id,
        s.started_at,
        s.duration_seconds,
        s.billed_amount,
        s.last_billed_at,
        s.last_heartbeat_at
      FROM public.live_sessions s
      WHERE s.status = 'active'
        AND s.last_heartbeat_at < (v_start_time - INTERVAL '45 seconds')
      ORDER BY s.last_heartbeat_at ASC
      FOR UPDATE OF s SKIP LOCKED
    LOOP
      -- Calculate unbilled elapsed seconds between last_billed_at and last_heartbeat_at
      v_raw_elapsed_seconds := FLOOR(EXTRACT(EPOCH FROM (v_stale_record.last_heartbeat_at - v_stale_record.last_billed_at)))::BIGINT;

      IF v_raw_elapsed_seconds > 0 THEN
        -- Cap billable interval to lease bounds to avoid charging for disconnected downtime
        IF v_raw_elapsed_seconds > v_max_lease_seconds THEN
          v_billable_delta_seconds := v_max_lease_seconds;
        ELSE
          v_billable_delta_seconds := v_raw_elapsed_seconds;
        END IF;

        v_debit_amount_cents := v_billable_delta_seconds * v_rate_cents_per_sec;

        -- Lock user's wallet
        SELECT * INTO v_wallet
        FROM public.wallets
        WHERE wallets.user_id = v_stale_record.user_id
        FOR UPDATE;

        IF FOUND AND v_wallet.balance > 0 AND v_debit_amount_cents > 0 THEN
          IF v_wallet.balance >= v_debit_amount_cents THEN
            -- Deduct full delta
            UPDATE public.wallets
            SET
              balance = balance - v_debit_amount_cents,
              updated_at = v_start_time
            WHERE id = v_wallet.id;

            INSERT INTO public.wallet_transactions (
              wallet_id,
              user_id,
              type,
              amount,
              currency,
              status,
              reference,
              description,
              created_at
            )
            VALUES (
              v_wallet.id,
              v_stale_record.user_id,
              'live_session_charge',
              -v_debit_amount_cents,
              'USD',
              'completed',
              'meter_reconcile_' || v_stale_record.id || '_' || (v_stale_record.duration_seconds + v_billable_delta_seconds),
              'Live Video Usage Reconciled (' || v_billable_delta_seconds || 's @ $0.04/s)',
              v_start_time
            );

            UPDATE public.live_sessions
            SET
              duration_seconds = duration_seconds + v_billable_delta_seconds,
              billed_amount = billed_amount + v_debit_amount_cents,
              last_billed_at = last_billed_at + (v_billable_delta_seconds || ' seconds')::INTERVAL,
              status = 'abandoned',
              ended_at = v_stale_record.last_heartbeat_at
            WHERE id = v_stale_record.id;
          ELSE
            -- Deduct affordable seconds
            v_actual_affordable_seconds := v_wallet.balance / v_rate_cents_per_sec;
            v_actual_debit_cents := v_actual_affordable_seconds * v_rate_cents_per_sec;

            IF v_actual_debit_cents > 0 THEN
              UPDATE public.wallets
              SET
                balance = balance - v_actual_debit_cents,
                updated_at = v_start_time
              WHERE id = v_wallet.id;

              INSERT INTO public.wallet_transactions (
                wallet_id,
                user_id,
                type,
                amount,
                currency,
                status,
                reference,
                description,
                created_at
              )
              VALUES (
                v_wallet.id,
                v_stale_record.user_id,
                'live_session_charge',
                -v_actual_debit_cents,
                'USD',
                'completed',
                'meter_reconcile_final_' || v_stale_record.id,
                'Live Video Usage Final Reconciled (' || v_actual_affordable_seconds || 's @ $0.04/s)',
                v_start_time
              );
            END IF;

            UPDATE public.live_sessions
            SET
              duration_seconds = duration_seconds + v_actual_affordable_seconds,
              billed_amount = billed_amount + v_actual_debit_cents,
              last_billed_at = last_billed_at + (v_actual_affordable_seconds || ' seconds')::INTERVAL,
              status = 'abandoned',
              ended_at = v_stale_record.last_heartbeat_at
            WHERE id = v_stale_record.id;
          END IF;
        ELSE
          -- Wallet empty or missing: mark abandoned without debit
          UPDATE public.live_sessions
          SET
            status = 'abandoned',
            ended_at = v_stale_record.last_heartbeat_at
          WHERE id = v_stale_record.id;
        END IF;
      ELSE
        -- No elapsed unbilled seconds: simply transition to abandoned
        UPDATE public.live_sessions
        SET
          status = 'abandoned',
          ended_at = v_stale_record.last_heartbeat_at
        WHERE id = v_stale_record.id;
      END IF;

      v_count := v_count + 1;
    END LOOP;

    v_end_time := timezone('utc'::text, now());
    v_duration_ms := FLOOR(EXTRACT(EPOCH FROM (v_end_time - v_start_time)) * 1000)::BIGINT;

    -- Update audit log with success
    UPDATE public.reconciliation_logs
    SET
      completed_at = v_end_time,
      sessions_reconciled = v_count,
      status = 'success',
      duration_ms = v_duration_ms
    WHERE id = v_log_id;

    RETURN v_count;

  EXCEPTION WHEN OTHERS THEN
    v_end_time := timezone('utc'::text, now());
    v_duration_ms := FLOOR(EXTRACT(EPOCH FROM (v_end_time - v_start_time)) * 1000)::BIGINT;

    -- Log failure safely without exposing secret parameters or tokens
    UPDATE public.reconciliation_logs
    SET
      completed_at = v_end_time,
      sessions_reconciled = v_count,
      status = 'failed',
      error_message = SUBSTRING(SQLERRM FROM 1 FOR 500),
      duration_ms = v_duration_ms
    WHERE id = v_log_id;

    RAISE;
  END;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.reconcile_stale_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_sessions() TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Register the pg_cron job (fail loudly on any registration error)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_existing_job RECORD;
BEGIN
  -- Unschedule any previous job with this name to guarantee zero duplicates across deploys
  FOR v_existing_job IN
    SELECT jobid FROM cron.job WHERE jobname = 'reconcile-stale-live-sessions'
  LOOP
    PERFORM cron.unschedule(v_existing_job.jobid);
  END LOOP;

  PERFORM cron.schedule(
    'reconcile-stale-live-sessions',
    '* * * * *',
    'SELECT public.reconcile_stale_sessions();'
  );
END;
$$;

-- Verify the job was actually created and is active. Deployment must fail otherwise.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM cron.job
    WHERE jobname = 'reconcile-stale-live-sessions'
      AND active = TRUE
  ) THEN
    RAISE EXCEPTION
      'Failed to register the active pg_cron job ''reconcile-stale-live-sessions''. Stale session reconciliation is NOT running. Deployment aborted.';
  END IF;

  IF (
    SELECT count(*) FROM cron.job WHERE jobname = 'reconcile-stale-live-sessions'
  ) <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one pg_cron job named ''reconcile-stale-live-sessions'', but found a different count. Deployment aborted.';
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Post-deploy verification helper (service_role only)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_reconciliation_scheduler()
RETURNS TABLE (
  job_id BIGINT,
  jobname TEXT,
  schedule TEXT,
  active BOOLEAN,
  last_run_status TEXT,
  last_run_at TIMESTAMPTZ,
  last_reconciled_count INTEGER
) AS $$
BEGIN
  IF NOT public.check_is_service_role() THEN
    RAISE EXCEPTION 'Access denied: verify_reconciliation_scheduler can only be invoked by service_role';
  END IF;

  RETURN QUERY
  SELECT
    j.jobid,
    j.jobname,
    j.schedule,
    j.active,
    l.status,
    l.started_at,
    l.sessions_reconciled
  FROM cron.job j
  LEFT JOIN LATERAL (
    SELECT status, started_at, sessions_reconciled
    FROM public.reconciliation_logs
    WHERE job_name = j.jobname
    ORDER BY started_at DESC
    LIMIT 1
  ) l ON TRUE
  WHERE j.jobname = 'reconcile-stale-live-sessions';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.verify_reconciliation_scheduler() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_reconciliation_scheduler() TO service_role;
