-- Migration: 20240105000000_server_authoritative_billing.sql
-- Dallr Cam: Server-Authoritative Live Session Metering & Lease-Based Bounding
--
-- Replaces client-supplied cumulative seconds with trusted server timestamps.
-- 1. Adds `last_billed_at` column to `live_sessions` to track exact server timestamp up to which usage was billed.
-- 2. Hardens `start_live_session` to strictly serialize sessions and enforce one active session per user.
-- 3. Implements server-authoritative `heartbeat_and_meter_session(p_session_id UUID, p_user_id UUID)`:
--    - Calculates elapsed seconds directly from server clock: `now() - last_billed_at`.
--    - Enforces lease bounding: maximum billable duration per heartbeat interval is capped (e.g. 15 seconds)
--      so that network drops, application crashes, or delayed heartbeats do not overcharge users.
--    - Serializes session and wallet updates with `FOR UPDATE` row-level locks.
--    - Debits wallet atomically at $0.04 USD (4 cents) per billable second.
--    - Prevents negative wallet balances; when funds are depleted, bills only whole affordable seconds,
--      sets balance to 0, terminates session with status 'terminated_insufficient_funds', and requests immediate stop.
--    - Idempotent and duplicate-safe: zero elapsed time yields zero billing.
-- 4. Implements server-authoritative `end_live_session(p_session_id UUID, p_user_id UUID)`:
--    - Bills any remaining unbilled elapsed server time up to termination (bounded by lease policy).
--    - Idempotent: terminates exactly once, subsequent calls return finalized state without charging further.
-- 5. Updates `reconcile_stale_sessions` to clean up abandoned sessions.

-- 0. Drop obsolete client-duration billing stored procedures
DROP FUNCTION IF EXISTS public.heartbeat_and_meter_session(UUID, UUID, BIGINT);
DROP FUNCTION IF EXISTS public.end_live_session(UUID, UUID, BIGINT);

-- 1. Schema modification: add last_billed_at
ALTER TABLE public.live_sessions
  ADD COLUMN IF NOT EXISTS last_billed_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now());

-- Update existing rows if any
UPDATE public.live_sessions
SET last_billed_at = COALESCE(started_at, created_at)
WHERE last_billed_at IS NULL;

-- 2. Procedure: start_live_session
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
  v_last_hb TIMESTAMPTZ;
BEGIN
  -- Strict caller verification
  IF NOT public.check_is_service_or_owner(p_user_id) THEN
    RAISE EXCEPTION 'Unauthorized: Caller does not own user_id %', p_user_id;
  END IF;

  -- Check for existing active session for this user
  SELECT id, last_heartbeat_at INTO v_existing_id, v_last_hb
  FROM public.live_sessions
  WHERE live_sessions.user_id = p_user_id
    AND live_sessions.status = 'active'
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    -- If active session heartbeat is older than 45s, mark it abandoned
    IF v_last_hb < (timezone('utc'::text, now()) - INTERVAL '45 seconds') THEN
      UPDATE public.live_sessions
      SET
        status = 'abandoned',
        ended_at = v_last_hb
      WHERE id = v_existing_id;
    ELSE
      RAISE EXCEPTION 'A live session (%) is already active for user %', v_existing_id, p_user_id;
    END IF;
  END IF;

  -- Verify wallet has at least 4 cents ($0.04 USD)
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

  v_started_at := timezone('utc'::text, now());

  INSERT INTO public.live_sessions (
    user_id,
    decart_session_id,
    started_at,
    status,
    last_heartbeat_at,
    last_billed_at,
    created_at
  )
  VALUES (
    p_user_id,
    p_decart_session_id,
    v_started_at,
    'active',
    v_started_at,
    v_started_at,
    v_started_at
  )
  RETURNING id INTO v_session_id;

  RETURN QUERY SELECT v_session_id, p_user_id, 'active'::TEXT, v_started_at, v_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.start_live_session(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_live_session(UUID, TEXT) TO authenticated, service_role;

-- 3. Procedure: heartbeat_and_meter_session
-- Server-authoritative: calculates billable elapsed time strictly from server timestamps.
-- Client cannot pass or manipulate duration or cumulative seconds.
CREATE OR REPLACE FUNCTION public.heartbeat_and_meter_session(
  p_session_id UUID,
  p_user_id UUID
)
RETURNS TABLE (
  session_id UUID,
  status TEXT,
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
  -- Heartbeat lease timeout policy: clients heartbeat every 5s.
  -- To bound billable usage safely during disconnections, network delays, or client freezes,
  -- the maximum interval billed in a single heartbeat step is capped at 15 seconds.
  v_max_lease_seconds CONSTANT BIGINT := 15;
  -- If heartbeat gap exceeds stale timeout (45s), stream was abandoned/disconnected
  v_stale_disconnect_seconds CONSTANT BIGINT := 45;
BEGIN
  -- Strict caller verification
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

  -- If session is already completed or terminated, return without charging further
  IF v_session.status <> 'active' THEN
    RETURN QUERY SELECT
      v_session.id,
      v_session.status,
      v_session.duration_seconds,
      v_session.billed_amount,
      v_wallet.balance,
      TRUE,
      'Session already ' || v_session.status;
    RETURN;
  END IF;

  -- Calculate server elapsed time since last billed timestamp
  v_raw_elapsed_seconds := FLOOR(EXTRACT(EPOCH FROM (v_now - v_session.last_billed_at)))::BIGINT;

  -- If no billable whole seconds have elapsed (e.g. duplicate or rapid concurrent heartbeats)
  IF v_raw_elapsed_seconds <= 0 THEN
    UPDATE public.live_sessions
    SET last_heartbeat_at = v_now
    WHERE id = v_session.id;

    RETURN QUERY SELECT
      v_session.id,
      v_session.status,
      v_session.duration_seconds,
      v_session.billed_amount,
      v_wallet.balance,
      (v_wallet.balance < v_rate_cents_per_sec),
      CASE WHEN v_wallet.balance < v_rate_cents_per_sec THEN 'Balance exhausted' ELSE 'Heartbeat acknowledged' END;
    RETURN;
  END IF;

  -- Apply heartbeat lease timeout policy:
  -- If elapsed time exceeds v_max_lease_seconds, cap billable seconds to v_max_lease_seconds
  -- and reset last_billed_at to v_now so unreceived/dead connection time is never charged in future steps.
  IF v_raw_elapsed_seconds > v_max_lease_seconds THEN
    v_billable_delta_seconds := v_max_lease_seconds;
  ELSE
    v_billable_delta_seconds := v_raw_elapsed_seconds;
  END IF;

  v_debit_amount_cents := v_billable_delta_seconds * v_rate_cents_per_sec;

  -- Check if wallet can cover the entire billable delta
  IF v_wallet.balance >= v_debit_amount_cents THEN
    -- Sufficient funds: debit full delta
    UPDATE public.wallets
    SET
      balance = balance - v_debit_amount_cents,
      updated_at = v_now
    WHERE id = v_wallet.id
    RETURNING balance INTO v_new_balance;

    -- Record transaction
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

    -- Update session record:
    -- If elapsed time exceeded max lease, advance last_billed_at directly to v_now to eliminate dead lag backlog;
    -- otherwise advance last_billed_at by the exact billable delta.
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

    -- Mark session as terminated due to insufficient funds
    UPDATE public.live_sessions
    SET
      duration_seconds = duration_seconds + v_actual_affordable_seconds,
      billed_amount = billed_amount + v_actual_debit_cents,
      status = 'terminated_insufficient_funds',
      last_billed_at = last_billed_at + (v_actual_affordable_seconds || ' seconds')::INTERVAL,
      ended_at = v_now,
      last_heartbeat_at = v_now
    WHERE id = v_session.id;

    RETURN QUERY SELECT
      v_session.id,
      'terminated_insufficient_funds'::TEXT,
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

-- 4. Procedure: end_live_session
-- Finalizes session cleanly, billing any final server-elapsed interval up to termination.
-- Subsequent invocations are idempotent and perform zero additional billing.
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
  v_res RECORD;
  v_session public.live_sessions%ROWTYPE;
  v_wallet public.wallets%ROWTYPE;
BEGIN
  -- Strict caller verification
  IF NOT public.check_is_service_or_owner(p_user_id) THEN
    RAISE EXCEPTION 'Unauthorized: Caller does not own user_id %', p_user_id;
  END IF;

  -- Lock session row
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

  -- Idempotency check: if already completed or terminated, return immediately with zero additional charges
  IF v_session.status <> 'active' THEN
    RETURN QUERY SELECT
      v_session.id,
      v_session.status,
      v_session.duration_seconds,
      v_session.billed_amount,
      v_wallet.balance;
    RETURN;
  END IF;

  -- Meter any remaining unbilled elapsed time
  SELECT * INTO v_res
  FROM public.heartbeat_and_meter_session(p_session_id, p_user_id);

  -- Set final status to completed if not already marked as terminated_insufficient_funds
  UPDATE public.live_sessions
  SET
    status = CASE
      WHEN live_sessions.status = 'active' THEN 'completed'
      ELSE live_sessions.status
    END,
    ended_at = COALESCE(live_sessions.ended_at, timezone('utc'::text, now())),
    last_heartbeat_at = timezone('utc'::text, now())
  WHERE live_sessions.id = p_session_id
  RETURNING
    live_sessions.id,
    live_sessions.status,
    live_sessions.duration_seconds,
    live_sessions.billed_amount
  INTO v_res.session_id, v_res.status, v_res.cumulative_seconds, v_res.billed_cents;

  RETURN QUERY SELECT
    v_res.session_id,
    v_res.status,
    v_res.cumulative_seconds,
    v_res.billed_cents,
    v_res.new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.end_live_session(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_live_session(UUID, UUID) TO authenticated, service_role;

-- 5. Stale Session Reconciler
CREATE OR REPLACE FUNCTION public.reconcile_stale_sessions()
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF NOT public.check_is_service_role() THEN
    RAISE EXCEPTION 'Access denied: reconcile_stale_sessions can only be invoked by service_role';
  END IF;

  WITH terminated AS (
    UPDATE public.live_sessions
    SET
      status = 'abandoned',
      ended_at = last_heartbeat_at
    WHERE status = 'active'
      AND last_heartbeat_at < (timezone('utc'::text, now()) - INTERVAL '45 seconds')
    RETURNING id
  )
  SELECT count(*) INTO v_count FROM terminated;

  RETURN v_count;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.reconcile_stale_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_sessions() TO service_role;
