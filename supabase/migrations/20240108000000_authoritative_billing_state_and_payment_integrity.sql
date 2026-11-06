-- Migration: 20240108000000_authoritative_billing_state_and_payment_integrity.sql
-- Dallr Cam: Explicit server-authoritative billing state + payment integrity hardening
--
-- 1. Adds `live_sessions.billing_state` ('idle' | 'billable' | 'paused' | 'ended').
--    Only sessions explicitly marked 'billable' by the server can accrue charges.
--    Reconnecting / disconnected / idle clients are moved to 'paused' or 'idle' and are
--    never charged while in those states.
-- 2. Rewrites heartbeat_and_meter_session so elapsed time is only billed while the
--    server-side billing_state is exactly 'billable'. Non-billable heartbeats act as a
--    keepalive and reset last_billed_at, guaranteeing paused gaps are never billed later.
-- 3. Adds set_session_billing_state() which meters any billable interval before pausing,
--    and resets last_billed_at when resuming so no paused gap is ever retroactively charged.
-- 4. Rewrites end_live_session so final reconciliation only bills when billable.
-- 5. Rewrites reconcile_stale_sessions so stale non-billable sessions are closed without
--    any additional charge.
-- 6. Hardens credit_verified_payment with mandatory verified amount + currency checks and
--    adds a partial unique index that makes duplicate top-up credits impossible at the
--    database level (defense in depth for duplicate Paystack webhook deliveries).
-- 7. Adds an index used by the payment reconciliation worker.

-- ---------------------------------------------------------------------------
-- 1. Explicit billing state
-- ---------------------------------------------------------------------------
ALTER TABLE public.live_sessions
  ADD COLUMN IF NOT EXISTS billing_state TEXT NOT NULL DEFAULT 'idle';

ALTER TABLE public.live_sessions
  ADD COLUMN IF NOT EXISTS billing_state_updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now());

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'live_sessions_billing_state_check'
  ) THEN
    ALTER TABLE public.live_sessions
      ADD CONSTRAINT live_sessions_billing_state_check
      CHECK (billing_state IN ('idle', 'billable', 'paused', 'ended'));
  END IF;
END;
$$;

-- Existing active sessions were created before billing_state existed.
-- They must not accrue charges until the client explicitly resumes them.
UPDATE public.live_sessions
SET billing_state = 'paused'
WHERE status = 'active'
  AND billing_state = 'idle';

-- Closed sessions are always 'ended'.
UPDATE public.live_sessions
SET billing_state = 'ended'
WHERE status <> 'active'
  AND billing_state <> 'ended';

CREATE INDEX IF NOT EXISTS idx_live_sessions_active_billing_state
  ON public.live_sessions (user_id, billing_state)
  WHERE status = 'active';

-- ---------------------------------------------------------------------------
-- 2. start_live_session: new sessions begin explicitly non-billable
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.start_live_session(
  p_user_id UUID,
  p_decart_session_id TEXT DEFAULT NULL
)
RETURNS TABLE (
  session_id UUID,
  user_id UUID,
  status TEXT,
  started_at TIMESTAMPTZ,
  current_balance BIGINT
) AS $$
DECLARE
  v_balance BIGINT;
  v_session_id UUID;
  v_started_at TIMESTAMPTZ;
  v_existing_id UUID;
  v_existing_started_at TIMESTAMPTZ;
  v_last_hb TIMESTAMPTZ;
BEGIN
  -- Strict caller verification: service_role or owner
  IF NOT public.check_is_service_or_owner(p_user_id) THEN
    RAISE EXCEPTION 'Unauthorized: Caller does not own user_id %', p_user_id;
  END IF;

  -- Verify wallet exists and lock wallet row for update
  SELECT balance INTO v_balance
  FROM public.wallets
  WHERE wallets.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found for user %', p_user_id;
  END IF;

  IF v_balance < 4 THEN
    RAISE EXCEPTION 'Insufficient balance to start live stream. Current balance: % cents', v_balance;
  END IF;

  -- Check for existing active session for this user
  SELECT id, live_sessions.started_at, last_heartbeat_at
  INTO v_existing_id, v_existing_started_at, v_last_hb
  FROM public.live_sessions
  WHERE live_sessions.user_id = p_user_id
    AND live_sessions.status = 'active'
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    -- If active session heartbeat is older than 45s, mark it abandoned and proceed to create new session
    IF v_last_hb < (timezone('utc'::text, now()) - INTERVAL '45 seconds') THEN
      UPDATE public.live_sessions
      SET
        status = 'abandoned',
        billing_state = 'ended',
        billing_state_updated_at = timezone('utc'::text, now()),
        ended_at = v_last_hb
      WHERE id = v_existing_id;
    ELSE
      -- Active session is still alive: return existing session record idempotently
      IF p_decart_session_id IS NOT NULL THEN
        UPDATE public.live_sessions
        SET decart_session_id = COALESCE(live_sessions.decart_session_id, p_decart_session_id)
        WHERE id = v_existing_id;
      END IF;

      RETURN QUERY SELECT v_existing_id, p_user_id, 'active'::TEXT, v_existing_started_at, v_balance;
      RETURN;
    END IF;
  END IF;

  v_started_at := timezone('utc'::text, now());

  INSERT INTO public.live_sessions (
    user_id,
    decart_session_id,
    started_at,
    status,
    last_heartbeat_at,
    last_billed_at,
    billing_state,
    billing_state_updated_at,
    created_at
  )
  VALUES (
    p_user_id,
    p_decart_session_id,
    v_started_at,
    'active',
    v_started_at,
    v_started_at,
    'idle',
    v_started_at,
    v_started_at
  )
  RETURNING id INTO v_session_id;

  RETURN QUERY SELECT v_session_id, p_user_id, 'active'::TEXT, v_started_at, v_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.start_live_session(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_live_session(UUID, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. heartbeat_and_meter_session: bill only in explicit 'billable' state
-- ---------------------------------------------------------------------------
-- Return type is changing (adds billing_state), so drop the old signature first.
DROP FUNCTION IF EXISTS public.end_live_session(UUID, UUID);
DROP FUNCTION IF EXISTS public.heartbeat_and_meter_session(UUID, UUID);

CREATE OR REPLACE FUNCTION public.heartbeat_and_meter_session(
  p_session_id UUID,
  p_user_id UUID
)
RETURNS TABLE (
  session_id UUID,
  status TEXT,
  billing_state TEXT,
  cumulative_seconds BIGINT,
  billed_cents BIGINT,
  new_balance BIGINT,
  stop_requested BOOLEAN,
  reason TEXT
) AS $$
DECLARE
  v_session public.live_sessions%ROWTYPE;
  v_wallet public.wallets%ROWTYPE;
  v_now TIMESTAMPTZ;
  v_raw_elapsed_seconds BIGINT;
  v_billable_delta_seconds BIGINT;
  v_debit_amount_cents BIGINT;
  v_actual_affordable_seconds BIGINT;
  v_actual_debit_cents BIGINT;
  v_new_balance BIGINT;
  v_tx_id UUID;
  v_rate_cents_per_sec CONSTANT BIGINT := 4; -- $0.04 USD / sec
  -- Maximum billable interval per heartbeat step. Protects against delayed heartbeats,
  -- suspended processes, and network stalls.
  v_max_lease_seconds CONSTANT BIGINT := 15;
BEGIN
  IF NOT public.check_is_service_or_owner(p_user_id) THEN
    RAISE EXCEPTION 'Unauthorized: Caller does not own user_id %', p_user_id;
  END IF;

  v_now := timezone('utc'::text, now());

  -- Lock live session row
  SELECT * INTO v_session
  FROM public.live_sessions
  WHERE id = p_session_id AND live_sessions.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Live session % not found for user %', p_session_id, p_user_id;
  END IF;

  -- Lock wallet row
  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE wallets.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found for user %', p_user_id;
  END IF;

  -- Closed sessions never bill again
  IF v_session.status <> 'active' THEN
    RETURN QUERY SELECT
      v_session.id,
      v_session.status,
      v_session.billing_state,
      v_session.duration_seconds,
      v_session.billed_amount,
      v_wallet.balance,
      TRUE,
      'Session already ' || v_session.status;
    RETURN;
  END IF;

  -- -------------------------------------------------------------------------
  -- CRITICAL: only explicitly billable sessions may accrue charges.
  -- A disconnecting / reconnecting / idle client is 'paused' or 'idle'.
  -- We still acknowledge the heartbeat (keepalive) but never bill, and we
  -- continuously reset last_billed_at so the paused gap can never be billed
  -- later when the session resumes.
  -- -------------------------------------------------------------------------
  IF v_session.billing_state <> 'billable' THEN
    UPDATE public.live_sessions
    SET
      last_heartbeat_at = v_now,
      last_billed_at = v_now
    WHERE id = v_session.id;

    RETURN QUERY SELECT
      v_session.id,
      v_session.status,
      v_session.billing_state,
      v_session.duration_seconds,
      v_session.billed_amount,
      v_wallet.balance,
      (v_wallet.balance < v_rate_cents_per_sec),
      CASE
        WHEN v_wallet.balance < v_rate_cents_per_sec THEN 'Balance exhausted'
        ELSE 'Heartbeat acknowledged (not billable: ' || v_session.billing_state || ')'
      END;
    RETURN;
  END IF;

  -- Calculate server elapsed time since last billed timestamp
  v_raw_elapsed_seconds := FLOOR(EXTRACT(EPOCH FROM (v_now - v_session.last_billed_at)))::BIGINT;

  -- Duplicate / rapid concurrent heartbeats bill zero
  IF v_raw_elapsed_seconds <= 0 THEN
    UPDATE public.live_sessions
    SET last_heartbeat_at = v_now
    WHERE id = v_session.id;

    RETURN QUERY SELECT
      v_session.id,
      v_session.status,
      v_session.billing_state,
      v_session.duration_seconds,
      v_session.billed_amount,
      v_wallet.balance,
      (v_wallet.balance < v_rate_cents_per_sec),
      CASE WHEN v_wallet.balance < v_rate_cents_per_sec THEN 'Balance exhausted' ELSE 'Heartbeat acknowledged' END;
    RETURN;
  END IF;

  -- Apply heartbeat lease policy
  IF v_raw_elapsed_seconds > v_max_lease_seconds THEN
    v_billable_delta_seconds := v_max_lease_seconds;
  ELSE
    v_billable_delta_seconds := v_raw_elapsed_seconds;
  END IF;

  v_debit_amount_cents := v_billable_delta_seconds * v_rate_cents_per_sec;

  IF v_wallet.balance >= v_debit_amount_cents THEN
    -- Sufficient funds: debit full delta
    UPDATE public.wallets
    SET
      balance = balance - v_debit_amount_cents,
      updated_at = v_now
    WHERE id = v_wallet.id
    RETURNING balance INTO v_new_balance;

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
      p_user_id,
      'live_session_charge',
      -v_debit_amount_cents,
      'USD',
      'completed',
      'meter_' || v_session.id || '_' || (v_session.duration_seconds + v_billable_delta_seconds),
      'Live Video Usage (' || v_billable_delta_seconds || 's @ $0.04/s)',
      v_now
    )
    RETURNING id INTO v_tx_id;

    UPDATE public.live_sessions
    SET
      duration_seconds = duration_seconds + v_billable_delta_seconds,
      billed_amount = billed_amount + v_debit_amount_cents,
      last_billed_at = CASE
        WHEN v_raw_elapsed_seconds > v_max_lease_seconds THEN v_now
        ELSE last_billed_at + (v_billable_delta_seconds || ' seconds')::INTERVAL
      END,
      last_heartbeat_at = v_now
    WHERE id = v_session.id;

    RETURN QUERY SELECT
      v_session.id,
      'active'::TEXT,
      v_session.billing_state,
      (v_session.duration_seconds + v_billable_delta_seconds),
      (v_session.billed_amount + v_debit_amount_cents),
      v_new_balance,
      (v_new_balance < v_rate_cents_per_sec),
      CASE WHEN v_new_balance < v_rate_cents_per_sec THEN 'Balance exhausted after metering' ELSE 'OK' END;
    RETURN;
  ELSE
    -- Insufficient balance: bill only affordable whole seconds, then terminate session
    v_actual_affordable_seconds := v_wallet.balance / v_rate_cents_per_sec;
    v_actual_debit_cents := v_actual_affordable_seconds * v_rate_cents_per_sec;

    IF v_actual_debit_cents > 0 THEN
      UPDATE public.wallets
      SET
        balance = balance - v_actual_debit_cents,
        updated_at = v_now
      WHERE id = v_wallet.id
      RETURNING balance INTO v_new_balance;

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
        p_user_id,
        'live_session_charge',
        -v_actual_debit_cents,
        'USD',
        'completed',
        'meter_final_' || v_session.id,
        'Live Video Final Usage (' || v_actual_affordable_seconds || 's @ $0.04/s)',
        v_now
      )
      RETURNING id INTO v_tx_id;
    ELSE
      v_new_balance := v_wallet.balance;
    END IF;

    UPDATE public.live_sessions
    SET
      duration_seconds = duration_seconds + v_actual_affordable_seconds,
      billed_amount = billed_amount + v_actual_debit_cents,
      status = 'terminated_insufficient_funds',
      billing_state = 'ended',
      billing_state_updated_at = v_now,
      last_billed_at = last_billed_at + (v_actual_affordable_seconds || ' seconds')::INTERVAL,
      ended_at = v_now,
      last_heartbeat_at = v_now
    WHERE id = v_session.id;

    RETURN QUERY SELECT
      v_session.id,
      'terminated_insufficient_funds'::TEXT,
      'ended'::TEXT,
      (v_session.duration_seconds + v_actual_affordable_seconds),
      (v_session.billed_amount + v_actual_debit_cents),
      v_new_balance,
      TRUE,
      'Session terminated due to insufficient balance';
    RETURN;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.heartbeat_and_meter_session(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.heartbeat_and_meter_session(UUID, UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. set_session_billing_state: explicit pause / resume / idle transitions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_session_billing_state(
  p_session_id UUID,
  p_user_id UUID,
  p_billing_state TEXT
)
RETURNS TABLE (
  session_id UUID,
  billing_state TEXT,
  status TEXT,
  cumulative_seconds BIGINT,
  billed_cents BIGINT,
  new_balance BIGINT,
  changed BOOLEAN
) AS $$
DECLARE
  v_session public.live_sessions%ROWTYPE;
  v_wallet public.wallets%ROWTYPE;
  v_now TIMESTAMPTZ;
  v_changed BOOLEAN := FALSE;
  v_meter_assigned BOOLEAN := FALSE;
  v_meter RECORD;
BEGIN
  IF p_billing_state NOT IN ('billable', 'paused', 'idle') THEN
    RAISE EXCEPTION 'Invalid billing state: %. Expected billable, paused, or idle.', p_billing_state;
  END IF;

  IF NOT public.check_is_service_or_owner(p_user_id) THEN
    RAISE EXCEPTION 'Unauthorized: Caller does not own user_id %', p_user_id;
  END IF;

  v_now := timezone('utc'::text, now());

  SELECT * INTO v_session
  FROM public.live_sessions
  WHERE id = p_session_id AND live_sessions.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Live session % not found for user %', p_session_id, p_user_id;
  END IF;

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE wallets.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found for user %', p_user_id;
  END IF;

  IF v_session.status <> 'active' THEN
    RETURN QUERY SELECT
      v_session.id,
      v_session.billing_state,
      v_session.status,
      v_session.duration_seconds,
      v_session.billed_amount,
      v_wallet.balance,
      FALSE;
    RETURN;
  END IF;

  -- Resuming: reset the billing clock so the paused gap is never charged.
  IF p_billing_state = 'billable' THEN
    IF v_session.billing_state <> 'billable' THEN
      UPDATE public.live_sessions
      SET
        billing_state = 'billable',
        billing_state_updated_at = v_now,
        last_billed_at = v_now,
        last_heartbeat_at = v_now
      WHERE id = v_session.id;
      v_changed := TRUE;
    ELSE
      UPDATE public.live_sessions
      SET last_heartbeat_at = v_now
      WHERE id = v_session.id;
    END IF;

    SELECT * INTO v_wallet FROM public.wallets WHERE wallets.user_id = p_user_id;
    SELECT * INTO v_session FROM public.live_sessions WHERE live_sessions.id = p_session_id;

    RETURN QUERY SELECT
      v_session.id,
      v_session.billing_state,
      v_session.status,
      v_session.duration_seconds,
      v_session.billed_amount,
      v_wallet.balance,
      v_changed;
    RETURN;
  END IF;

  -- Pausing / idling: meter only the billable interval that elapsed up to this instant,
  -- then freeze the clock. This is the last moment a charge may occur for that interval.
  IF v_session.billing_state = 'billable' THEN
    SELECT * INTO v_meter
    FROM public.heartbeat_and_meter_session(p_session_id, p_user_id);
    v_meter_assigned := TRUE;
  END IF;

  UPDATE public.live_sessions
  SET
    billing_state = p_billing_state,
    billing_state_updated_at = v_now,
    last_billed_at = v_now,
    last_heartbeat_at = v_now
  WHERE id = v_session.id
    AND status = 'active';

  SELECT * INTO v_session FROM public.live_sessions WHERE live_sessions.id = p_session_id;
  SELECT * INTO v_wallet FROM public.wallets WHERE wallets.user_id = p_user_id;

  IF v_meter_assigned THEN
    RETURN QUERY SELECT
      v_session.id,
      v_session.billing_state,
      v_session.status,
      v_meter.cumulative_seconds,
      v_meter.billed_cents,
      v_meter.new_balance,
      v_changed;
  ELSE
    RETURN QUERY SELECT
      v_session.id,
      v_session.billing_state,
      v_session.status,
      v_session.duration_seconds,
      v_session.billed_amount,
      v_wallet.balance,
      v_changed;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.set_session_billing_state(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_session_billing_state(UUID, UUID, TEXT) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 5. end_live_session: final billing only when billable
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.end_live_session(
  p_session_id UUID,
  p_user_id UUID
)
RETURNS TABLE (
  session_id UUID,
  status TEXT,
  total_seconds BIGINT,
  total_billed_cents BIGINT,
  final_balance BIGINT
) AS $$
DECLARE
  v_session public.live_sessions%ROWTYPE;
  v_wallet public.wallets%ROWTYPE;
  v_meter RECORD;
  v_meter_assigned BOOLEAN := FALSE;
  v_now TIMESTAMPTZ;
BEGIN
  IF NOT public.check_is_service_or_owner(p_user_id) THEN
    RAISE EXCEPTION 'Unauthorized: Caller does not own user_id %', p_user_id;
  END IF;

  v_now := timezone('utc'::text, now());

  SELECT * INTO v_session
  FROM public.live_sessions
  WHERE id = p_session_id AND live_sessions.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Live session % not found for user %', p_session_id, p_user_id;
  END IF;

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE wallets.user_id = p_user_id
  FOR UPDATE;

  -- Idempotency: already closed sessions never bill again
  IF v_session.status <> 'active' THEN
    UPDATE public.live_sessions
    SET billing_state = 'ended', billing_state_updated_at = v_now
    WHERE id = v_session.id
      AND billing_state <> 'ended';

    RETURN QUERY SELECT
      v_session.id,
      v_session.status,
      v_session.duration_seconds,
      v_session.billed_amount,
      v_wallet.balance;
    RETURN;
  END IF;

  -- Meter only if explicitly billable. A paused/idle session ends with zero additional charge.
  IF v_session.billing_state = 'billable' THEN
    SELECT * INTO v_meter
    FROM public.heartbeat_and_meter_session(p_session_id, p_user_id);
    v_meter_assigned := TRUE;
  END IF;

  UPDATE public.live_sessions
  SET
    status = CASE
      WHEN live_sessions.status = 'active' THEN 'completed'
      ELSE live_sessions.status
    END,
    billing_state = 'ended',
    billing_state_updated_at = v_now,
    last_billed_at = v_now,
    ended_at = COALESCE(ended_at, v_now),
    last_heartbeat_at = v_now
  WHERE live_sessions.id = p_session_id
  RETURNING
    live_sessions.id,
    live_sessions.status,
    live_sessions.duration_seconds,
    live_sessions.billed_amount
  INTO v_session.id, v_session.status, v_session.duration_seconds, v_session.billed_amount;

  SELECT balance INTO v_wallet.balance FROM public.wallets WHERE wallets.user_id = p_user_id;

  RETURN QUERY SELECT
    v_session.id,
    v_session.status,
    v_session.duration_seconds,
    v_session.billed_amount,
    COALESCE(v_wallet.balance, 0::BIGINT);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.end_live_session(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_live_session(UUID, UUID) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. reconcile_stale_sessions: never bill stale non-billable sessions
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
  IF NOT public.check_is_service_role() THEN
    RAISE EXCEPTION 'Access denied: reconcile_stale_sessions can only be invoked by service_role';
  END IF;

  v_start_time := timezone('utc'::text, now());

  INSERT INTO public.reconciliation_logs (job_name, started_at, status)
  VALUES ('reconcile-stale-live-sessions', v_start_time, 'running')
  RETURNING id INTO v_log_id;

  BEGIN
    FOR v_stale_record IN
      SELECT
        s.id,
        s.user_id,
        s.started_at,
        s.duration_seconds,
        s.billed_amount,
        s.last_billed_at,
        s.last_heartbeat_at,
        s.billing_state
      FROM public.live_sessions s
      WHERE s.status = 'active'
        AND s.last_heartbeat_at < (v_start_time - INTERVAL '45 seconds')
      ORDER BY s.last_heartbeat_at ASC
      FOR UPDATE OF s SKIP LOCKED
    LOOP
      -- Non-billable stale sessions are closed with no additional charge.
      IF v_stale_record.billing_state <> 'billable' THEN
        UPDATE public.live_sessions
        SET
          status = 'abandoned',
          billing_state = 'ended',
          billing_state_updated_at = v_start_time,
          ended_at = v_stale_record.last_heartbeat_at
        WHERE id = v_stale_record.id;

        v_count := v_count + 1;
        CONTINUE;
      END IF;

      v_raw_elapsed_seconds := FLOOR(
        EXTRACT(EPOCH FROM (v_stale_record.last_heartbeat_at - v_stale_record.last_billed_at))
      )::BIGINT;

      IF v_raw_elapsed_seconds > 0 THEN
        IF v_raw_elapsed_seconds > v_max_lease_seconds THEN
          v_billable_delta_seconds := v_max_lease_seconds;
        ELSE
          v_billable_delta_seconds := v_raw_elapsed_seconds;
        END IF;

        v_debit_amount_cents := v_billable_delta_seconds * v_rate_cents_per_sec;

        SELECT * INTO v_wallet
        FROM public.wallets
        WHERE wallets.user_id = v_stale_record.user_id
        FOR UPDATE;

        IF FOUND AND v_wallet.balance > 0 AND v_debit_amount_cents > 0 THEN
          IF v_wallet.balance >= v_debit_amount_cents THEN
            UPDATE public.wallets
            SET balance = balance - v_debit_amount_cents, updated_at = v_start_time
            WHERE id = v_wallet.id;

            INSERT INTO public.wallet_transactions (
              wallet_id, user_id, type, amount, currency, status, reference, description, created_at
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
              billing_state = 'ended',
              billing_state_updated_at = v_start_time,
              ended_at = v_stale_record.last_heartbeat_at
            WHERE id = v_stale_record.id;
          ELSE
            v_actual_affordable_seconds := v_wallet.balance / v_rate_cents_per_sec;
            v_actual_debit_cents := v_actual_affordable_seconds * v_rate_cents_per_sec;

            IF v_actual_debit_cents > 0 THEN
              UPDATE public.wallets
              SET balance = balance - v_actual_debit_cents, updated_at = v_start_time
              WHERE id = v_wallet.id;

              INSERT INTO public.wallet_transactions (
                wallet_id, user_id, type, amount, currency, status, reference, description, created_at
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
              billing_state = 'ended',
              billing_state_updated_at = v_start_time,
              ended_at = v_stale_record.last_heartbeat_at
            WHERE id = v_stale_record.id;
          END IF;
        ELSE
          UPDATE public.live_sessions
          SET
            status = 'abandoned',
            billing_state = 'ended',
            billing_state_updated_at = v_start_time,
            ended_at = v_stale_record.last_heartbeat_at
          WHERE id = v_stale_record.id;
        END IF;
      ELSE
        UPDATE public.live_sessions
        SET
          status = 'abandoned',
          billing_state = 'ended',
          billing_state_updated_at = v_start_time,
          ended_at = v_stale_record.last_heartbeat_at
        WHERE id = v_stale_record.id;
      END IF;

      v_count := v_count + 1;
    END LOOP;

    v_end_time := timezone('utc'::text, now());
    v_duration_ms := FLOOR(EXTRACT(EPOCH FROM (v_end_time - v_start_time)) * 1000)::BIGINT;

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
-- 7. Payment integrity: verified amount + currency are mandatory
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.credit_verified_payment(TEXT, TEXT, JSONB);

CREATE OR REPLACE FUNCTION public.credit_verified_payment(
  p_reference TEXT,
  p_gateway_status TEXT,
  p_verified_amount BIGINT DEFAULT NULL,
  p_verified_currency TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT NULL
)
RETURNS TABLE (
  success BOOLEAN,
  already_processed BOOLEAN,
  credited_amount_cents BIGINT,
  new_balance BIGINT,
  message TEXT
) AS $$
DECLARE
  v_record public.payment_records%ROWTYPE;
  v_wallet_id UUID;
  v_new_balance BIGINT;
  v_tx_id UUID;
BEGIN
  -- Strict caller verification: only service_role can verify/credit payments
  IF NOT public.check_is_service_role() THEN
    RAISE EXCEPTION 'Access denied: credit_verified_payment can only be invoked by service_role';
  END IF;

  IF p_reference IS NULL OR trim(p_reference) = '' THEN
    RETURN QUERY SELECT FALSE, FALSE, 0::BIGINT, 0::BIGINT, 'Missing payment reference';
    RETURN;
  END IF;

  -- Lock payment record row for update to serialize concurrent calls
  SELECT * INTO v_record
  FROM public.payment_records
  WHERE reference = p_reference
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, FALSE, 0::BIGINT, 0::BIGINT, 'Payment record not found';
    RETURN;
  END IF;

  -- Idempotency check: a successfully credited reference can never be credited again
  IF v_record.status = 'success' THEN
    SELECT balance INTO v_new_balance FROM public.wallets WHERE user_id = v_record.user_id;
    RETURN QUERY SELECT TRUE, TRUE, v_record.usd_credit_amount, COALESCE(v_new_balance, 0::BIGINT), 'Payment already credited';
    RETURN;
  END IF;

  -- Non-success gateway status: record failure, never credit
  IF p_gateway_status <> 'success' THEN
    UPDATE public.payment_records
    SET
      status = CASE WHEN p_gateway_status = 'abandoned' THEN 'abandoned' ELSE 'failed' END,
      verified_at = timezone('utc'::text, now()),
      metadata = CASE
        WHEN p_metadata IS NOT NULL THEN COALESCE(metadata, '{}'::jsonb) || p_metadata
        ELSE metadata
      END,
      updated_at = timezone('utc'::text, now())
    WHERE id = v_record.id;

    SELECT balance INTO v_new_balance FROM public.wallets WHERE user_id = v_record.user_id;
    RETURN QUERY SELECT FALSE, FALSE, 0::BIGINT, COALESCE(v_new_balance, 0::BIGINT), 'Payment gateway status is ' || p_gateway_status;
    RETURN;
  END IF;

  -- -------------------------------------------------------------------------
  -- SECURITY: verify amount and currency server-side before any credit.
  -- A caller that cannot prove the exact expected NGN amount and currency
  -- must never be able to credit a wallet.
  -- -------------------------------------------------------------------------
  IF p_verified_amount IS NULL
     OR p_verified_currency IS NULL
     OR upper(trim(p_verified_currency)) <> 'NGN'
     OR p_verified_amount <> v_record.ngn_amount THEN
    UPDATE public.payment_records
    SET
      status = 'failed',
      verified_at = timezone('utc'::text, now()),
      metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
        'verification_failure', 'amount_or_currency_mismatch',
        'verified_amount', p_verified_amount,
        'verified_currency', p_verified_currency,
        'expected_amount', v_record.ngn_amount,
        'expected_currency', 'NGN'
      ) || COALESCE(p_metadata, '{}'::jsonb),
      updated_at = timezone('utc'::text, now())
    WHERE id = v_record.id;

    SELECT balance INTO v_new_balance FROM public.wallets WHERE user_id = v_record.user_id;
    RETURN QUERY SELECT FALSE, FALSE, 0::BIGINT, COALESCE(v_new_balance, 0::BIGINT), 'Payment verification failed: amount or currency mismatch';
    RETURN;
  END IF;

  -- Mark payment record as successful before crediting
  UPDATE public.payment_records
  SET
    status = 'success',
    verified_at = timezone('utc'::text, now()),
    metadata = CASE
      WHEN p_metadata IS NOT NULL THEN COALESCE(metadata, '{}'::jsonb) || p_metadata
      ELSE metadata
    END,
    updated_at = timezone('utc'::text, now())
  WHERE id = v_record.id;

  -- Atomically credit user wallet. The partial unique index on
  -- wallet_transactions(reference) WHERE type = 'top_up' is a second line of defense
  -- against duplicate credits from replayed webhooks.
  SELECT cw.wallet_id, cw.new_balance, cw.transaction_id INTO v_wallet_id, v_new_balance, v_tx_id
  FROM public.credit_wallet(
    v_record.user_id,
    v_record.usd_credit_amount,
    'top_up',
    v_record.reference,
    'Paystack Top Up: $' || TRIM(TO_CHAR(v_record.usd_credit_amount / 100.0, '999999990.00'))
  ) AS cw;

  RETURN QUERY SELECT TRUE, FALSE, v_record.usd_credit_amount, v_new_balance, 'Payment credited successfully';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.credit_verified_payment(TEXT, TEXT, BIGINT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_verified_payment(TEXT, TEXT, BIGINT, TEXT, JSONB) TO service_role;

-- ---------------------------------------------------------------------------
-- 8. Database-level duplicate-credit protection + reconciliation index
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transactions_unique_top_up_reference
  ON public.wallet_transactions (reference)
  WHERE type = 'top_up' AND reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_records_reconciliation
  ON public.payment_records (status, created_at)
  WHERE status IN ('initialized', 'pending');
