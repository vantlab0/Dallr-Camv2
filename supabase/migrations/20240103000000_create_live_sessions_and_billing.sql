-- Phase 7 — Dallr Cam: Authoritative Real-Time Session Billing & Usage Metering Migration
-- 1. Create live_sessions table
-- 2. Configure constraints, indexes, and Row Level Security (RLS)
-- 3. Stored procedures for session initiation, cumulative metering, wallet debiting, and cleanup

-- Table: live_sessions
CREATE TABLE IF NOT EXISTS public.live_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  decart_session_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  ended_at TIMESTAMPTZ,
  duration_seconds BIGINT NOT NULL DEFAULT 0,
  billed_amount BIGINT NOT NULL DEFAULT 0, -- Minor units in USD cents (e.g. 4 cents/sec)
  status TEXT NOT NULL DEFAULT 'active',
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT live_sessions_status_check CHECK (
    status IN ('active', 'completed', 'terminated_insufficient_funds', 'abandoned', 'failed')
  ),
  CONSTRAINT live_sessions_duration_non_negative CHECK (duration_seconds >= 0),
  CONSTRAINT live_sessions_billed_amount_non_negative CHECK (billed_amount >= 0)
);

CREATE INDEX IF NOT EXISTS idx_live_sessions_user_id ON public.live_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_live_sessions_decart_session_id ON public.live_sessions(decart_session_id);
CREATE INDEX IF NOT EXISTS idx_live_sessions_status ON public.live_sessions(status);
CREATE INDEX IF NOT EXISTS idx_live_sessions_started_at ON public.live_sessions(started_at DESC);

-- Enable Row Level Security (RLS)
ALTER TABLE public.live_sessions ENABLE ROW LEVEL SECURITY;

-- Live Sessions RLS Policies:
-- Authenticated users can ONLY SELECT their own sessions.
-- Direct client INSERT, UPDATE, DELETE is prohibited (must go through backend functions / procedures).
CREATE POLICY "Users can view own live sessions"
  ON public.live_sessions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- ----------------------------------------------------
-- DATABASE FUNCTIONS & STORED PROCEDURES
-- ----------------------------------------------------

-- 1. Start Live Session procedure (SECURITY DEFINER)
-- Verifies user has at least 1 billable second (4 cents) before starting session row.
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
BEGIN
  -- Verify wallet has at least 4 cents
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
    created_at
  )
  VALUES (
    p_user_id,
    p_decart_session_id,
    v_started_at,
    'active',
    v_started_at,
    v_started_at
  )
  RETURNING id INTO v_session_id;

  RETURN QUERY SELECT v_session_id, p_user_id, 'active'::TEXT, v_started_at, v_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 2. Heartbeat & Meter Session procedure (SECURITY DEFINER)
-- Handles periodic cumulative usage accounting.
-- Billing rate: 4 cents per second ($0.04/s).
-- Uses cumulative duration to prevent rounding errors or lost heartbeat drift.
CREATE OR REPLACE FUNCTION public.heartbeat_and_meter_session(
  p_session_id UUID,
  p_user_id UUID,
  p_cumulative_seconds BIGINT
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
  v_delta_seconds BIGINT;
  v_debit_amount_cents BIGINT;
  v_actual_affordable_seconds BIGINT;
  v_actual_debit_cents BIGINT;
  v_new_balance BIGINT;
  v_tx_id UUID;
  v_rate_cents_per_sec CONSTANT BIGINT := 4; -- $0.04 USD / sec
BEGIN
  -- Lock live session row
  SELECT * INTO v_session
  FROM public.live_sessions
  WHERE id = p_session_id AND live_sessions.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Live session % not found for user %', p_session_id, p_user_id;
  END IF;

  -- If session is already completed or terminated, return without charging further
  IF v_session.status <> 'active' THEN
    SELECT balance INTO v_new_balance FROM public.wallets WHERE wallets.user_id = p_user_id;
    RETURN QUERY SELECT
      v_session.id,
      v_session.status,
      v_session.duration_seconds,
      v_session.billed_amount,
      COALESCE(v_new_balance, 0::BIGINT),
      TRUE,
      'Session already ' || v_session.status;
    RETURN;
  END IF;

  -- Lock wallet row
  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE wallets.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found for user %', p_user_id;
  END IF;

  -- Ensure cumulative seconds is not decreasing
  IF p_cumulative_seconds < v_session.duration_seconds THEN
    -- Inconsistent or manipulated report: keep previous duration
    p_cumulative_seconds := v_session.duration_seconds;
  END IF;

  v_delta_seconds := p_cumulative_seconds - v_session.duration_seconds;

  -- No unbilled elapsed seconds: update heartbeat timestamp only
  IF v_delta_seconds <= 0 THEN
    UPDATE public.live_sessions
    SET last_heartbeat_at = timezone('utc'::text, now())
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

  v_debit_amount_cents := v_delta_seconds * v_rate_cents_per_sec;

  -- Check if wallet can cover the entire delta
  IF v_wallet.balance >= v_debit_amount_cents THEN
    -- Sufficient funds: debit full delta
    UPDATE public.wallets
    SET
      balance = balance - v_debit_amount_cents,
      updated_at = timezone('utc'::text, now())
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
      'meter_' || v_session.id || '_' || p_cumulative_seconds,
      'Live Video Usage (' || v_delta_seconds || 's @ $0.04/s)',
      timezone('utc'::text, now())
    )
    RETURNING id INTO v_tx_id;

    -- Update session record
    UPDATE public.live_sessions
    SET
      duration_seconds = p_cumulative_seconds,
      billed_amount = billed_amount + v_debit_amount_cents,
      last_heartbeat_at = timezone('utc'::text, now())
    WHERE id = v_session.id;

    RETURN QUERY SELECT
      v_session.id,
      'active'::TEXT,
      p_cumulative_seconds,
      (v_session.billed_amount + v_debit_amount_cents),
      v_new_balance,
      (v_new_balance < v_rate_cents_per_sec), -- Stop requested if remaining balance cannot cover even 1 more second
      CASE WHEN v_new_balance < v_rate_cents_per_sec THEN 'Balance exhausted after metering' ELSE 'OK' END;
    RETURN;
  ELSE
    -- Insufficient balance: bill only what can be afforded, then terminate session
    v_actual_affordable_seconds := v_wallet.balance / v_rate_cents_per_sec;
    v_actual_debit_cents := v_actual_affordable_seconds * v_rate_cents_per_sec;

    IF v_actual_debit_cents > 0 THEN
      UPDATE public.wallets
      SET
        balance = balance - v_actual_debit_cents,
        updated_at = timezone('utc'::text, now())
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
        timezone('utc'::text, now())
      )
      RETURNING id INTO v_tx_id;
    ELSE
      v_new_balance := v_wallet.balance;
    END IF;

    -- Mark session as terminated due to insufficient funds
    UPDATE public.live_sessions
    SET
      duration_seconds = v_session.duration_seconds + v_actual_affordable_seconds,
      billed_amount = billed_amount + v_actual_debit_cents,
      status = 'terminated_insufficient_funds',
      ended_at = timezone('utc'::text, now()),
      last_heartbeat_at = timezone('utc'::text, now())
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. End Live Session procedure (SECURITY DEFINER)
-- Finalizes duration, settles unbilled delta, marks session completed with ended_at timestamp.
CREATE OR REPLACE FUNCTION public.end_live_session(
  p_session_id UUID,
  p_user_id UUID,
  p_final_seconds BIGINT
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
BEGIN
  -- Meter any remaining unbilled cumulative seconds
  SELECT * INTO v_res
  FROM public.heartbeat_and_meter_session(p_session_id, p_user_id, p_final_seconds);

  -- Set final status to completed if not already marked as terminated
  UPDATE public.live_sessions
  SET
    status = CASE
      WHEN status = 'active' THEN 'completed'
      ELSE status
    END,
    ended_at = COALESCE(ended_at, timezone('utc'::text, now())),
    last_heartbeat_at = timezone('utc'::text, now())
  WHERE id = p_session_id
  RETURNING id, status, duration_seconds, billed_amount INTO v_res.session_id, v_res.status, v_res.cumulative_seconds, v_res.billed_cents;

  RETURN QUERY SELECT
    v_res.session_id,
    v_res.status,
    v_res.cumulative_seconds,
    v_res.billed_cents,
    v_res.new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Stale Session Reconciler (SECURITY DEFINER)
-- Automatically closes sessions with no heartbeat in the last 45 seconds (network drops / app crashes)
CREATE OR REPLACE FUNCTION public.reconcile_stale_sessions()
RETURNS INTEGER AS $$
DECLARE
  v_count INTEGER;
BEGIN
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
$$ LANGUAGE plpgsql SECURITY DEFINER;
