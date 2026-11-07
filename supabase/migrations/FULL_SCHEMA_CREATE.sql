-- ============================================================================
-- Dallr Cam — Complete Database Schema (Fresh Create)
-- ============================================================================
-- Run this in Supabase Dashboard → SQL Editor
-- Works on completely empty databases. Drops everything first with CASCADE,
-- then recreates all tables, functions, triggers, RLS policies, and indexes.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 0. Enable required extensions
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ----------------------------------------------------------------------------
-- 1. Drop all tables (CASCADE removes triggers, indexes, policies, functions)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.reconciliation_logs CASCADE;
DROP TABLE IF EXISTS public.live_sessions CASCADE;
DROP TABLE IF EXISTS public.payment_records CASCADE;
DROP TABLE IF EXISTS public.wallet_transactions CASCADE;
DROP TABLE IF EXISTS public.wallets CASCADE;
DROP TABLE IF EXISTS public.profiles CASCADE;

-- ----------------------------------------------------------------------------
-- 2. Remove pg_cron job if it exists
-- ----------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'reconcile-stale-live-sessions') THEN
    PERFORM cron.unschedule('reconcile-stale-live-sessions');
  END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 3. Drop all standalone functions
-- ----------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.check_is_service_role() CASCADE;
DROP FUNCTION IF EXISTS public.check_is_service_or_owner(UUID) CASCADE;
DROP FUNCTION IF EXISTS public.handle_new_user_wallet() CASCADE;
DROP FUNCTION IF EXISTS public.handle_wallet_updated_at() CASCADE;
DROP FUNCTION IF EXISTS public.credit_wallet(UUID, BIGINT, TEXT, TEXT, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.start_live_session(UUID, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.heartbeat_and_meter_session(UUID, UUID) CASCADE;
DROP FUNCTION IF EXISTS public.end_live_session(UUID, UUID) CASCADE;
DROP FUNCTION IF EXISTS public.set_session_billing_state(UUID, UUID, TEXT) CASCADE;
DROP FUNCTION IF EXISTS public.reconcile_stale_sessions() CASCADE;
DROP FUNCTION IF EXISTS public.verify_reconciliation_scheduler() CASCADE;
DROP FUNCTION IF EXISTS public.credit_verified_payment(TEXT, TEXT, BIGINT, TEXT, JSONB) CASCADE;

-- ----------------------------------------------------------------------------
-- 4. Create tables
-- ----------------------------------------------------------------------------

-- Table: profiles
CREATE TABLE public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  email TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Table: wallets
CREATE TABLE public.wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'USD',
  balance BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT wallets_user_id_unique UNIQUE (user_id),
  CONSTRAINT wallets_currency_check CHECK (currency = 'USD'),
  CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0)
);

CREATE INDEX idx_wallets_user_id ON public.wallets(user_id);

ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;

-- Table: wallet_transactions
CREATE TABLE public.wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES public.wallets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'completed',
  reference TEXT,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT wallet_transactions_type_check CHECK (
    type IN ('top_up', 'live_session_charge', 'refund', 'adjustment')
  ),
  CONSTRAINT wallet_transactions_currency_check CHECK (currency = 'USD'),
  CONSTRAINT wallet_transactions_status_check CHECK (
    status IN ('pending', 'completed', 'failed', 'reversed')
  )
);

CREATE INDEX idx_wallet_transactions_wallet_id ON public.wallet_transactions(wallet_id);
CREATE INDEX idx_wallet_transactions_user_id ON public.wallet_transactions(user_id);
CREATE INDEX idx_wallet_transactions_created_at ON public.wallet_transactions(created_at DESC);
CREATE INDEX idx_wallet_transactions_reference ON public.wallet_transactions(reference);

ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;

-- Table: payment_records
CREATE TABLE public.payment_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reference TEXT NOT NULL UNIQUE,
  ngn_amount BIGINT NOT NULL,
  usd_credit_amount BIGINT NOT NULL,
  exchange_rate_used BIGINT NOT NULL DEFAULT 1550,
  status TEXT NOT NULL DEFAULT 'initialized',
  paystack_access_code TEXT,
  authorization_url TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX idx_payment_records_user_id ON public.payment_records(user_id);
CREATE INDEX idx_payment_records_reference ON public.payment_records(reference);
CREATE INDEX idx_payment_records_status ON public.payment_records(status);

ALTER TABLE public.payment_records ENABLE ROW LEVEL SECURITY;

-- Table: live_sessions
CREATE TABLE public.live_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  decart_session_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  ended_at TIMESTAMPTZ,
  duration_seconds BIGINT NOT NULL DEFAULT 0,
  billed_amount BIGINT NOT NULL DEFAULT 0,
  billing_state TEXT NOT NULL DEFAULT 'idle' CHECK (billing_state IN ('idle', 'billable', 'paused', 'ended')),
  billing_state_updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'completed', 'terminated_insufficient_funds', 'abandoned', 'failed')
  ),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX idx_live_sessions_user_id ON public.live_sessions(user_id);
CREATE INDEX idx_live_sessions_active_billing_state ON public.live_sessions(user_id, billing_state) WHERE status = 'active';
CREATE UNIQUE INDEX idx_unique_active_user_live_session ON public.live_sessions(user_id) WHERE status = 'active';

ALTER TABLE public.live_sessions ENABLE ROW LEVEL SECURITY;

-- Table: reconciliation_logs
CREATE TABLE public.reconciliation_logs (
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

CREATE INDEX idx_reconciliation_logs_started_at ON public.reconciliation_logs(started_at DESC);
CREATE INDEX idx_reconciliation_logs_status ON public.reconciliation_logs(status);

ALTER TABLE public.reconciliation_logs ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- 5. Row Level Security Policies
-- ----------------------------------------------------------------------------

CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT TO authenticated USING (auth.uid() = id);

CREATE POLICY "Users can view own wallet" ON public.wallets
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can view own transactions" ON public.wallet_transactions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can view own payment records" ON public.payment_records
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

CREATE POLICY "Users can view own live sessions" ON public.live_sessions
  FOR SELECT TO authenticated USING (auth.uid() = user_id);

REVOKE ALL ON TABLE public.reconciliation_logs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.reconciliation_logs TO service_role;

-- ----------------------------------------------------------------------------
-- 6. Security helper functions
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.check_is_service_role()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jwt_claims JSONB;
BEGIN
  IF current_setting('request.jwt.claims', true) IS NOT NULL THEN
    v_jwt_claims := current_setting('request.jwt.claims', true)::JSONB;
    IF v_jwt_claims ->> 'role' = 'service_role' THEN
      RETURN TRUE;
    END IF;
  END IF;

  IF session_user = 'service_role' THEN
    RETURN TRUE;
  END IF;

  IF session_user = 'postgres' AND auth.role() IS NULL AND auth.uid() IS NULL THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.check_is_service_role() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_is_service_role() TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.check_is_service_or_owner(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_jwt_claims JSONB;
  v_uid UUID;
BEGIN
  IF public.check_is_service_role() THEN
    RETURN TRUE;
  END IF;

  IF current_setting('request.jwt.claims', true) IS NOT NULL THEN
    v_jwt_claims := current_setting('request.jwt.claims', true)::JSONB;
    v_uid := (v_jwt_claims ->> 'sub')::UUID;
    IF v_uid IS NOT NULL AND v_uid = p_user_id THEN
      RETURN TRUE;
    END IF;
  END IF;

  RETURN FALSE;
END;
$$;

REVOKE ALL ON FUNCTION public.check_is_service_or_owner(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_is_service_or_owner(UUID) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 7. Wallet triggers and functions
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_new_user_wallet()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO public.wallets (user_id, currency, balance, created_at, updated_at)
  VALUES (NEW.id, 'USD', 0, timezone('utc'::text, now()), timezone('utc'::text, now()))
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_wallet_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created_wallet
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_wallet();

CREATE TRIGGER on_wallet_updated
  BEFORE UPDATE ON public.wallets
  FOR EACH ROW EXECUTE FUNCTION public.handle_wallet_updated_at();

CREATE TRIGGER on_payment_record_updated
  BEFORE UPDATE ON public.payment_records
  FOR EACH ROW EXECUTE FUNCTION public.handle_wallet_updated_at();

-- Atomic credit_wallet procedure
CREATE OR REPLACE FUNCTION public.credit_wallet(
  p_user_id UUID,
  p_amount_cents BIGINT,
  p_type TEXT,
  p_reference TEXT,
  p_description TEXT
)
RETURNS TABLE (
  wallet_id UUID,
  new_balance BIGINT,
  transaction_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_wallet_id UUID;
  v_new_balance BIGINT;
  v_tx_id UUID;
BEGIN
  SELECT id INTO v_wallet_id
  FROM public.wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found for user %', p_user_id;
  END IF;

  UPDATE public.wallets
  SET balance = balance + p_amount_cents,
      updated_at = timezone('utc'::text, now())
  WHERE id = v_wallet_id
  RETURNING balance INTO v_new_balance;

  INSERT INTO public.wallet_transactions (
    wallet_id, user_id, type, amount, currency, status, reference, description, created_at
  )
  VALUES (
    v_wallet_id, p_user_id, p_type, p_amount_cents, 'USD', 'completed',
    p_reference, p_description, timezone('utc'::text, now())
  )
  RETURNING id INTO v_tx_id;

  RETURN QUERY SELECT v_wallet_id, v_new_balance, v_tx_id;
END;
$$;

REVOKE ALL ON FUNCTION public.credit_wallet(UUID, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_wallet(UUID, BIGINT, TEXT, TEXT, TEXT) TO service_role;

-- ----------------------------------------------------------------------------
-- 8. Session functions
-- ----------------------------------------------------------------------------

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
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_balance BIGINT;
  v_session_id UUID;
  v_started_at TIMESTAMPTZ;
  v_existing_id UUID;
  v_existing_started_at TIMESTAMPTZ;
  v_last_hb TIMESTAMPTZ;
BEGIN
  IF NOT public.check_is_service_or_owner(p_user_id) THEN
    RAISE EXCEPTION 'Unauthorized: Caller does not own user_id %', p_user_id;
  END IF;

  SELECT balance INTO v_balance
  FROM public.wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found for user %', p_user_id;
  END IF;

  IF v_balance < 4 THEN
    RAISE EXCEPTION 'Insufficient balance to start live stream. Current balance: % cents', v_balance;
  END IF;

  SELECT id, started_at, last_heartbeat_at
  INTO v_existing_id, v_existing_started_at, v_last_hb
  FROM public.live_sessions
  WHERE user_id = p_user_id
    AND status = 'active'
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF v_last_hb < (timezone('utc'::text, now()) - INTERVAL '45 seconds') THEN
      UPDATE public.live_sessions
      SET status = 'abandoned', billing_state = 'ended', billing_state_updated_at = timezone('utc'::text, now()), ended_at = v_last_hb
      WHERE id = v_existing_id;
    ELSE
      IF p_decart_session_id IS NOT NULL THEN
        UPDATE public.live_sessions
        SET decart_session_id = COALESCE(decart_session_id, p_decart_session_id)
        WHERE id = v_existing_id;
      END IF;

      RETURN QUERY SELECT v_existing_id, p_user_id, 'active'::TEXT, v_existing_started_at, v_balance;
      RETURN;
    END IF;
  END IF;

  v_started_at := timezone('utc'::text, now());

  INSERT INTO public.live_sessions (
    user_id, decart_session_id, started_at, status, last_heartbeat_at,
    last_billed_at, billing_state, billing_state_updated_at, created_at
  )
  VALUES (
    p_user_id, p_decart_session_id, v_started_at, 'active', v_started_at,
    v_started_at, 'idle', v_started_at, v_started_at
  )
  RETURNING id INTO v_session_id;

  RETURN QUERY SELECT v_session_id, p_user_id, 'active'::TEXT, v_started_at, v_balance;
END;
$$;

REVOKE ALL ON FUNCTION public.start_live_session(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_live_session(UUID, TEXT) TO authenticated, service_role;

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
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
  v_rate_cents_per_sec CONSTANT BIGINT := 4;
  v_max_lease_seconds CONSTANT BIGINT := 15;
BEGIN
  IF NOT public.check_is_service_or_owner(p_user_id) THEN
    RAISE EXCEPTION 'Unauthorized: Caller does not own user_id %', p_user_id;
  END IF;

  v_now := timezone('utc'::text, now());

  SELECT * INTO v_session
  FROM public.live_sessions
  WHERE id = p_session_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Live session % not found for user %', p_session_id, p_user_id;
  END IF;

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found for user %', p_user_id;
  END IF;

  IF v_session.status <> 'active' THEN
    RETURN QUERY SELECT
      v_session.id, v_session.status, v_session.billing_state,
      v_session.duration_seconds, v_session.billed_amount,
      v_wallet.balance, TRUE, 'Session already ' || v_session.status;
    RETURN;
  END IF;

  IF v_session.billing_state <> 'billable' THEN
    UPDATE public.live_sessions
    SET last_heartbeat_at = v_now, last_billed_at = v_now
    WHERE id = v_session.id;

    RETURN QUERY SELECT
      v_session.id, v_session.status, v_session.billing_state,
      v_session.duration_seconds, v_session.billed_amount,
      v_wallet.balance, (v_wallet.balance < v_rate_cents_per_sec),
      CASE WHEN v_wallet.balance < v_rate_cents_per_sec THEN 'Balance exhausted' ELSE 'Heartbeat acknowledged (not billable)' END;
    RETURN;
  END IF;

  v_raw_elapsed_seconds := FLOOR(EXTRACT(EPOCH FROM (v_now - v_session.last_billed_at)))::BIGINT;

  IF v_raw_elapsed_seconds <= 0 THEN
    UPDATE public.live_sessions
    SET last_heartbeat_at = v_now
    WHERE id = v_session.id;

    RETURN QUERY SELECT
      v_session.id, v_session.status, v_session.billing_state,
      v_session.duration_seconds, v_session.billed_amount,
      v_wallet.balance, (v_wallet.balance < v_rate_cents_per_sec),
      CASE WHEN v_wallet.balance < v_rate_cents_per_sec THEN 'Balance exhausted' ELSE 'Heartbeat acknowledged' END;
    RETURN;
  END IF;

  IF v_raw_elapsed_seconds > v_max_lease_seconds THEN
    v_billable_delta_seconds := v_max_lease_seconds;
  ELSE
    v_billable_delta_seconds := v_raw_elapsed_seconds;
  END IF;

  v_debit_amount_cents := v_billable_delta_seconds * v_rate_cents_per_sec;

  IF v_wallet.balance >= v_debit_amount_cents THEN
    UPDATE public.wallets
    SET balance = balance - v_debit_amount_cents, updated_at = v_now
    WHERE id = v_wallet.id
    RETURNING balance INTO v_new_balance;

    INSERT INTO public.wallet_transactions (
      wallet_id, user_id, type, amount, currency, status, reference, description, created_at
    )
    VALUES (
      v_wallet.id, p_user_id, 'live_session_charge', -v_debit_amount_cents, 'USD', 'completed',
      'meter_' || v_session.id || '_' || (v_session.duration_seconds + v_billable_delta_seconds),
      'Live Video Usage (' || v_billable_delta_seconds || 's @ $0.04/s)', v_now
    )
    RETURNING id INTO v_tx_id;

    UPDATE public.live_sessions
    SET duration_seconds = duration_seconds + v_billable_delta_seconds,
        billed_amount = billed_amount + v_debit_amount_cents,
        last_billed_at = last_billed_at + (v_billable_delta_seconds || ' seconds')::INTERVAL,
        last_heartbeat_at = v_now
    WHERE id = v_session.id;

    RETURN QUERY SELECT
      v_session.id, 'active'::TEXT, v_session.billing_state,
      (v_session.duration_seconds + v_billable_delta_seconds),
      (v_session.billed_amount + v_debit_amount_cents),
      v_new_balance,
      (v_new_balance < v_rate_cents_per_sec),
      CASE WHEN v_new_balance < v_rate_cents_per_sec THEN 'Balance exhausted after metering' ELSE 'OK' END;
    RETURN;
  ELSE
    v_actual_affordable_seconds := v_wallet.balance / v_rate_cents_per_sec;
    v_actual_debit_cents := v_actual_affordable_seconds * v_rate_cents_per_sec;

    IF v_actual_debit_cents > 0 THEN
      UPDATE public.wallets
      SET balance = balance - v_actual_debit_cents, updated_at = v_now
      WHERE id = v_wallet.id
      RETURNING balance INTO v_new_balance;

      INSERT INTO public.wallet_transactions (
        wallet_id, user_id, type, amount, currency, status, reference, description, created_at
      )
      VALUES (
        v_wallet.id, p_user_id, 'live_session_charge', -v_actual_debit_cents, 'USD', 'completed',
        'meter_final_' || v_session.id,
        'Live Video Final Usage (' || v_actual_affordable_seconds || 's @ $0.04/s)', v_now
      )
      RETURNING id INTO v_tx_id;
    ELSE
      v_new_balance := v_wallet.balance;
    END IF;

    UPDATE public.live_sessions
    SET duration_seconds = duration_seconds + v_actual_affordable_seconds,
        billed_amount = billed_amount + v_actual_debit_cents,
        status = 'terminated_insufficient_funds',
        billing_state = 'ended',
        billing_state_updated_at = v_now,
        last_billed_at = last_billed_at + (v_actual_affordable_seconds || ' seconds')::INTERVAL,
        ended_at = v_now,
        last_heartbeat_at = v_now
    WHERE id = v_session.id;

    RETURN QUERY SELECT
      v_session.id, 'terminated_insufficient_funds'::TEXT, 'ended'::TEXT,
      (v_session.duration_seconds + v_actual_affordable_seconds),
      (v_session.billed_amount + v_actual_debit_cents),
      v_new_balance, TRUE, 'Session terminated due to insufficient balance';
    RETURN;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.heartbeat_and_meter_session(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.heartbeat_and_meter_session(UUID, UUID) TO authenticated, service_role;

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
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_session public.live_sessions%ROWTYPE;
  v_wallet public.wallets%ROWTYPE;
  v_now TIMESTAMPTZ;
  v_changed BOOLEAN := FALSE;
  v_meter RECORD;
  v_meter_assigned BOOLEAN := FALSE;
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
  WHERE id = p_session_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Live session % not found for user %', p_session_id, p_user_id;
  END IF;

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found for user %', p_user_id;
  END IF;

  IF v_session.status <> 'active' THEN
    RETURN QUERY SELECT
      v_session.id, v_session.billing_state, v_session.status,
      v_session.duration_seconds, v_session.billed_amount, v_wallet.balance, FALSE;
    RETURN;
  END IF;

  IF p_billing_state = 'billable' THEN
    IF v_session.billing_state <> 'billable' THEN
      UPDATE public.live_sessions
      SET billing_state = 'billable', billing_state_updated_at = v_now,
          last_billed_at = v_now, last_heartbeat_at = v_now
      WHERE id = v_session.id;
      v_changed := TRUE;
    ELSE
      UPDATE public.live_sessions
      SET last_heartbeat_at = v_now
      WHERE id = v_session.id;
    END IF;

    SELECT * INTO v_wallet FROM public.wallets WHERE user_id = p_user_id;
    SELECT * INTO v_session FROM public.live_sessions WHERE id = p_session_id;

    RETURN QUERY SELECT
      v_session.id, v_session.billing_state, v_session.status,
      v_session.duration_seconds, v_session.billed_amount, v_wallet.balance, v_changed;
    RETURN;
  END IF;

  IF v_session.billing_state = 'billable' THEN
    SELECT * INTO v_meter FROM public.heartbeat_and_meter_session(p_session_id, p_user_id);
    v_meter_assigned := TRUE;
  END IF;

  UPDATE public.live_sessions
  SET billing_state = p_billing_state, billing_state_updated_at = v_now,
      last_billed_at = v_now, last_heartbeat_at = v_now
  WHERE id = v_session.id AND status = 'active';

  SELECT * INTO v_session FROM public.live_sessions WHERE id = p_session_id;
  SELECT * INTO v_wallet FROM public.wallets WHERE user_id = p_user_id;

  IF v_meter_assigned THEN
    RETURN QUERY SELECT
      v_session.id, v_session.billing_state, v_session.status,
      v_meter.cumulative_seconds, v_meter.billed_cents, v_meter.new_balance, v_changed;
  ELSE
    RETURN QUERY SELECT
      v_session.id, v_session.billing_state, v_session.status,
      v_session.duration_seconds, v_session.billed_amount, v_wallet.balance, v_changed;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.set_session_billing_state(UUID, UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_session_billing_state(UUID, UUID, TEXT) TO authenticated, service_role;

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
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
  WHERE id = p_session_id AND user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Live session % not found for user %', p_session_id, p_user_id;
  END IF;

  SELECT * INTO v_wallet
  FROM public.wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF v_session.status <> 'active' THEN
    UPDATE public.live_sessions
    SET billing_state = 'ended', billing_state_updated_at = v_now
    WHERE id = v_session.id AND billing_state <> 'ended';

    RETURN QUERY SELECT
      v_session.id, v_session.status, v_session.duration_seconds,
      v_session.billed_amount, v_wallet.balance;
    RETURN;
  END IF;

  IF v_session.billing_state = 'billable' THEN
    SELECT * INTO v_meter FROM public.heartbeat_and_meter_session(p_session_id, p_user_id);
    v_meter_assigned := TRUE;
  END IF;

  UPDATE public.live_sessions
  SET status = 'completed', billing_state = 'ended', billing_state_updated_at = v_now,
      last_billed_at = v_now, ended_at = COALESCE(ended_at, v_now),
      last_heartbeat_at = v_now
  WHERE id = p_session_id
  RETURNING id, status, duration_seconds, billed_amount
  INTO v_session.id, v_session.status, v_session.duration_seconds, v_session.billed_amount;

  SELECT balance INTO v_wallet.balance FROM public.wallets WHERE user_id = p_user_id;

  RETURN QUERY SELECT
    v_session.id, v_session.status, v_session.duration_seconds,
    v_session.billed_amount, v_wallet.balance;
END;
$$;

REVOKE ALL ON FUNCTION public.end_live_session(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_live_session(UUID, UUID) TO authenticated, service_role;

-- ----------------------------------------------------------------------------
-- 9. Stale session reconciler
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.reconcile_stale_sessions()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
      SELECT s.id, s.user_id, s.started_at, s.duration_seconds, s.billed_amount,
             s.last_billed_at, s.last_heartbeat_at, s.billing_state
      FROM public.live_sessions s
      WHERE s.status = 'active'
        AND s.last_heartbeat_at < (v_start_time - INTERVAL '45 seconds')
      ORDER BY s.last_heartbeat_at ASC
      FOR UPDATE OF s SKIP LOCKED
    LOOP
      IF v_stale_record.billing_state <> 'billable' THEN
        UPDATE public.live_sessions
        SET status = 'abandoned', billing_state = 'ended', billing_state_updated_at = v_start_time,
            ended_at = v_stale_record.last_heartbeat_at
        WHERE id = v_stale_record.id;
        v_count := v_count + 1;
        CONTINUE;
      END IF;

      v_raw_elapsed_seconds := FLOOR(EXTRACT(EPOCH FROM (v_stale_record.last_heartbeat_at - v_stale_record.last_billed_at)))::BIGINT;

      IF v_raw_elapsed_seconds > 0 THEN
        IF v_raw_elapsed_seconds > v_max_lease_seconds THEN
          v_billable_delta_seconds := v_max_lease_seconds;
        ELSE
          v_billable_delta_seconds := v_raw_elapsed_seconds;
        END IF;

        v_debit_amount_cents := v_billable_delta_seconds * v_rate_cents_per_sec;

        SELECT * INTO v_wallet
        FROM public.wallets
        WHERE user_id = v_stale_record.user_id
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
              v_wallet.id, v_stale_record.user_id, 'live_session_charge', -v_debit_amount_cents,
              'USD', 'completed',
              'meter_reconcile_' || v_stale_record.id || '_' || (v_stale_record.duration_seconds + v_billable_delta_seconds),
              'Live Video Usage Reconciled (' || v_billable_delta_seconds || 's @ $0.04/s)', v_start_time
            );

            UPDATE public.live_sessions
            SET duration_seconds = duration_seconds + v_billable_delta_seconds,
                billed_amount = billed_amount + v_debit_amount_cents,
                last_billed_at = last_billed_at + (v_billable_delta_seconds || ' seconds')::INTERVAL,
                status = 'abandoned', billing_state = 'ended', billing_state_updated_at = v_start_time,
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
                v_wallet.id, v_stale_record.user_id, 'live_session_charge', -v_actual_debit_cents,
                'USD', 'completed',
                'meter_reconcile_final_' || v_stale_record.id,
                'Live Video Usage Final Reconciled (' || v_actual_affordable_seconds || 's @ $0.04/s)', v_start_time
              );
            END IF;

            UPDATE public.live_sessions
            SET duration_seconds = duration_seconds + v_actual_affordable_seconds,
                billed_amount = billed_amount + v_actual_debit_cents,
                last_billed_at = last_billed_at + (v_actual_affordable_seconds || ' seconds')::INTERVAL,
                status = 'abandoned', billing_state = 'ended', billing_state_updated_at = v_start_time,
                ended_at = v_stale_record.last_heartbeat_at
            WHERE id = v_stale_record.id;
          END IF;
        ELSE
          UPDATE public.live_sessions
          SET status = 'abandoned', billing_state = 'ended', billing_state_updated_at = v_start_time,
              ended_at = v_stale_record.last_heartbeat_at
          WHERE id = v_stale_record.id;
        END IF;
      ELSE
        UPDATE public.live_sessions
        SET status = 'abandoned', billing_state = 'ended', billing_state_updated_at = v_start_time,
            ended_at = v_stale_record.last_heartbeat_at
        WHERE id = v_stale_record.id;
      END IF;

      v_count := v_count + 1;
    END LOOP;

    v_end_time := timezone('utc'::text, now());
    v_duration_ms := FLOOR(EXTRACT(EPOCH FROM (v_end_time - v_start_time)) * 1000)::BIGINT;

    UPDATE public.reconciliation_logs
    SET completed_at = v_end_time, sessions_reconciled = v_count, status = 'success', duration_ms = v_duration_ms
    WHERE id = v_log_id;

    RETURN v_count;

  EXCEPTION WHEN OTHERS THEN
    v_end_time := timezone('utc'::text, now());
    v_duration_ms := FLOOR(EXTRACT(EPOCH FROM (v_end_time - v_start_time)) * 1000)::BIGINT;

    UPDATE public.reconciliation_logs
    SET completed_at = v_end_time, sessions_reconciled = v_count, status = 'failed',
        error_message = SUBSTRING(SQLERRM FROM 1 FOR 500), duration_ms = v_duration_ms
    WHERE id = v_log_id;

    RAISE;
  END;
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_stale_sessions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_stale_sessions() TO service_role;

-- ----------------------------------------------------------------------------
-- 10. Payment integrity function
-- ----------------------------------------------------------------------------

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
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_record public.payment_records%ROWTYPE;
  v_wallet_id UUID;
  v_new_balance BIGINT;
  v_tx_id UUID;
BEGIN
  IF NOT public.check_is_service_role() THEN
    RAISE EXCEPTION 'Access denied: credit_verified_payment can only be invoked by service_role';
  END IF;

  IF p_reference IS NULL OR trim(p_reference) = '' THEN
    RETURN QUERY SELECT FALSE, FALSE, 0::BIGINT, 0::BIGINT, 'Missing payment reference';
    RETURN;
  END IF;

  SELECT * INTO v_record
  FROM public.payment_records
  WHERE reference = p_reference
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, FALSE, 0::BIGINT, 0::BIGINT, 'Payment record not found';
    RETURN;
  END IF;

  IF v_record.status = 'success' THEN
    SELECT balance INTO v_new_balance FROM public.wallets WHERE user_id = v_record.user_id;
    RETURN QUERY SELECT TRUE, TRUE, v_record.usd_credit_amount, COALESCE(v_new_balance, 0::BIGINT), 'Payment already credited';
    RETURN;
  END IF;

  IF p_gateway_status <> 'success' THEN
    UPDATE public.payment_records
    SET status = CASE WHEN p_gateway_status = 'abandoned' THEN 'abandoned' ELSE 'failed' END,
        verified_at = timezone('utc'::text, now()),
        metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
        updated_at = timezone('utc'::text, now())
    WHERE id = v_record.id;

    SELECT balance INTO v_new_balance FROM public.wallets WHERE user_id = v_record.user_id;
    RETURN QUERY SELECT FALSE, FALSE, 0::BIGINT, COALESCE(v_new_balance, 0::BIGINT), 'Payment gateway status is ' || p_gateway_status;
    RETURN;
  END IF;

  IF p_verified_amount IS NULL
     OR p_verified_currency IS NULL
     OR upper(trim(p_verified_currency)) <> 'NGN'
     OR p_verified_amount <> v_record.ngn_amount THEN
    UPDATE public.payment_records
    SET status = 'failed',
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

  UPDATE public.payment_records
  SET status = 'success', verified_at = timezone('utc'::text, now()),
      metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
      updated_at = timezone('utc'::text, now())
  WHERE id = v_record.id;

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
$$;

REVOKE ALL ON FUNCTION public.credit_verified_payment(TEXT, TEXT, BIGINT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_verified_payment(TEXT, TEXT, BIGINT, TEXT, JSONB) TO service_role;

-- ----------------------------------------------------------------------------
-- 11. Duplicate credit protection index
-- ----------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_transactions_unique_top_up_reference
  ON public.wallet_transactions (reference)
  WHERE type = 'top_up' AND reference IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_payment_records_reconciliation
  ON public.payment_records (status, created_at)
  WHERE status IN ('initialized', 'pending');

-- ----------------------------------------------------------------------------
-- 12. Schedule pg_cron reconciliation job (every minute)
-- ----------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    RAISE EXCEPTION 'pg_cron extension is not installed. Enable it in Supabase Dashboard → Database → Extensions.';
  END IF;
END;
$$;

DO $$
DECLARE
  v_job RECORD;
BEGIN
  FOR v_job IN SELECT jobid FROM cron.job WHERE jobname = 'reconcile-stale-live-sessions' LOOP
    PERFORM cron.unschedule(v_job.jobid);
  END LOOP;

  PERFORM cron.schedule(
    'reconcile-stale-live-sessions',
    '* * * * *',
    'SELECT public.reconcile_stale_sessions();'
  );
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'reconcile-stale-live-sessions' AND active = TRUE
  ) THEN
    RAISE EXCEPTION 'Failed to register pg_cron job reconcile-stale-live-sessions.';
  END IF;

  IF (SELECT count(*) FROM cron.job WHERE jobname = 'reconcile-stale-live-sessions') <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one reconcile-stale-live-sessions cron job.';
  END IF;
END;
$$;

-- ----------------------------------------------------------------------------
-- 13. Backfill wallets for existing users
-- ----------------------------------------------------------------------------

INSERT INTO public.wallets (user_id, currency, balance, created_at, updated_at)
SELECT id, 'USD', 0, timezone('utc'::text, now()), timezone('utc'::text, now())
FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- Done
-- ----------------------------------------------------------------------------
SELECT 'Dallr Cam database schema created successfully' AS result;
