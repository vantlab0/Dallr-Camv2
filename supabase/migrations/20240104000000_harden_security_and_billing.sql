-- Migration: 20240104000000_harden_security_and_billing.sql
-- Hardens PostgreSQL functions with fixed search_path = public, pg_temp,
-- revokes dangerous client execution privileges on sensitive RPC functions,
-- enforces caller checks, prevents concurrent live sessions, and adds timestamp bounding.

-- Helper: Check if caller is genuinely service_role (backend worker / edge functions)
-- or direct internal admin (e.g. postgres CLI/migrations when auth context is unset).
-- Note: Inside SECURITY DEFINER functions, `current_user` evaluates to the function owner (e.g. 'postgres').
-- Therefore, we NEVER use `current_user` alone to determine caller privileges!
CREATE OR REPLACE FUNCTION public.check_is_service_role()
RETURNS BOOLEAN AS $$
DECLARE
  v_role TEXT;
  v_jwt_claims JSONB;
BEGIN
  -- 1. Check Supabase auth.role() helper if available
  BEGIN
    v_role := auth.role();
  EXCEPTION WHEN OTHERS THEN
    v_role := NULL;
  END;

  IF v_role = 'service_role' THEN
    RETURN TRUE;
  END IF;

  -- 2. Check request.jwt.claim.role or request.jwt.claims session setting
  BEGIN
    v_role := current_setting('request.jwt.claim.role', true);
  EXCEPTION WHEN OTHERS THEN
    v_role := NULL;
  END;

  IF v_role = 'service_role' THEN
    RETURN TRUE;
  END IF;

  BEGIN
    v_jwt_claims := NULLIF(current_setting('request.jwt.claims', true), '')::jsonb;
    IF v_jwt_claims ->> 'role' = 'service_role' THEN
      RETURN TRUE;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- Ignore JSON parse errors
  END;

  -- 3. Check session_user (the physical connected DB role, NOT current_user which changes under SECURITY DEFINER)
  IF session_user = 'service_role' THEN
    RETURN TRUE;
  END IF;

  -- 4. If connected directly as superuser/postgres in direct SQL / migration script outside PostgREST
  -- (where no request.jwt or auth context exists)
  IF session_user = 'postgres' AND auth.role() IS NULL AND auth.uid() IS NULL THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.check_is_service_role() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_is_service_role() TO authenticated, service_role;

-- 1. Helper function to check if caller is service_role or authenticated owner of p_user_id
CREATE OR REPLACE FUNCTION public.check_is_service_or_owner(p_user_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
  v_auth_uid UUID;
  v_role TEXT;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- If caller is service_role or internal DB administrator, allow
  IF public.check_is_service_role() THEN
    RETURN TRUE;
  END IF;

  -- Otherwise, caller must be an authenticated user matching p_user_id
  BEGIN
    v_role := auth.role();
  EXCEPTION WHEN OTHERS THEN
    v_role := NULL;
  END;

  BEGIN
    v_auth_uid := auth.uid();
  EXCEPTION WHEN OTHERS THEN
    v_auth_uid := NULL;
  END;

  IF v_role = 'authenticated' AND v_auth_uid IS NOT NULL AND v_auth_uid = p_user_id THEN
    RETURN TRUE;
  END IF;

  RETURN FALSE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.check_is_service_or_owner(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_is_service_or_owner(UUID) TO authenticated, service_role;

-- 2. Harden handle_new_user trigger function
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, display_name, created_at, updated_at)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)),
    timezone('utc'::text, now()),
    timezone('utc'::text, now())
  )
  ON CONFLICT (id) DO UPDATE
  SET
    email = EXCLUDED.email,
    display_name = COALESCE(EXCLUDED.display_name, public.profiles.display_name),
    updated_at = timezone('utc'::text, now());

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 3. Harden handle_new_user_wallet trigger function
CREATE OR REPLACE FUNCTION public.handle_new_user_wallet()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.wallets (user_id, currency, balance, created_at, updated_at)
  VALUES (NEW.id, 'USD', 0, timezone('utc'::text, now()), timezone('utc'::text, now()))
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

-- 4. Harden handle_wallet_updated_at trigger function
CREATE OR REPLACE FUNCTION public.handle_wallet_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = public, pg_temp;

-- 5. Harden credit_wallet
-- Only callable by backend service_role
CREATE OR REPLACE FUNCTION public.credit_wallet(
  p_user_id UUID,
  p_amount_cents BIGINT,
  p_type TEXT,
  p_reference TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL
)
RETURNS TABLE (
  wallet_id UUID,
  new_balance BIGINT,
  transaction_id UUID
) AS $$
DECLARE
  v_wallet_id UUID;
  v_balance BIGINT;
  v_tx_id UUID;
BEGIN
  -- Strict caller verification: only service_role can directly credit
  IF NOT public.check_is_service_role() THEN
    RAISE EXCEPTION 'Access denied: credit_wallet can only be invoked by service_role';
  END IF;

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Credit amount must be greater than zero.';
  END IF;

  -- Lock wallet row for update
  SELECT id, balance INTO v_wallet_id, v_balance
  FROM public.wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO public.wallets (user_id, currency, balance)
    VALUES (p_user_id, 'USD', 0)
    RETURNING id, balance INTO v_wallet_id, v_balance;
  END IF;

  -- Update balance
  UPDATE public.wallets
  SET
    balance = balance + p_amount_cents,
    updated_at = timezone('utc'::text, now())
  WHERE id = v_wallet_id
  RETURNING balance INTO v_balance;

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
    v_wallet_id,
    p_user_id,
    p_type,
    p_amount_cents,
    'USD',
    'completed',
    p_reference,
    p_description,
    timezone('utc'::text, now())
  )
  RETURNING id INTO v_tx_id;

  RETURN QUERY SELECT v_wallet_id, v_balance, v_tx_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.credit_wallet(UUID, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_wallet(UUID, BIGINT, TEXT, TEXT, TEXT) TO service_role;

-- 6. Harden debit_wallet
-- Only callable by backend service_role
CREATE OR REPLACE FUNCTION public.debit_wallet(
  p_user_id UUID,
  p_amount_cents BIGINT,
  p_type TEXT,
  p_reference TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL
)
RETURNS TABLE (
  wallet_id UUID,
  new_balance BIGINT,
  transaction_id UUID
) AS $$
DECLARE
  v_wallet_id UUID;
  v_balance BIGINT;
  v_tx_id UUID;
BEGIN
  -- Strict caller verification: only service_role can directly debit
  IF NOT public.check_is_service_role() THEN
    RAISE EXCEPTION 'Access denied: debit_wallet can only be invoked by service_role';
  END IF;

  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Debit amount must be greater than zero.';
  END IF;

  -- Lock wallet row for update
  SELECT id, balance INTO v_wallet_id, v_balance
  FROM public.wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Wallet not found for user %', p_user_id;
  END IF;

  IF v_balance < p_amount_cents THEN
    RAISE EXCEPTION 'Insufficient balance: required %, available %', p_amount_cents, v_balance;
  END IF;

  -- Update balance
  UPDATE public.wallets
  SET
    balance = balance - p_amount_cents,
    updated_at = timezone('utc'::text, now())
  WHERE id = v_wallet_id
  RETURNING balance INTO v_balance;

  -- Record transaction with negative amount
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
    v_wallet_id,
    p_user_id,
    p_type,
    -p_amount_cents,
    'USD',
    'completed',
    p_reference,
    p_description,
    timezone('utc'::text, now())
  )
  RETURNING id INTO v_tx_id;

  RETURN QUERY SELECT v_wallet_id, v_balance, v_tx_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.debit_wallet(UUID, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.debit_wallet(UUID, BIGINT, TEXT, TEXT, TEXT) TO service_role;

-- 7. Harden credit_verified_payment
-- Only callable by backend service_role
CREATE OR REPLACE FUNCTION public.credit_verified_payment(
  p_reference TEXT,
  p_gateway_status TEXT,
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

  -- Lock payment record row
  SELECT * INTO v_record
  FROM public.payment_records
  WHERE reference = p_reference
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, FALSE, 0::BIGINT, 0::BIGINT, 'Payment record not found';
    RETURN;
  END IF;

  -- Idempotency check: if already success or already credited, do nothing
  IF v_record.status = 'success' THEN
    SELECT balance INTO v_new_balance FROM public.wallets WHERE user_id = v_record.user_id;
    RETURN QUERY SELECT TRUE, TRUE, v_record.usd_credit_amount, COALESCE(v_new_balance, 0::BIGINT), 'Payment already credited';
    RETURN;
  END IF;

  -- If gateway report is not success, update record status and return
  IF p_gateway_status <> 'success' THEN
    UPDATE public.payment_records
    SET
      status = CASE WHEN p_gateway_status = 'abandoned' THEN 'abandoned' ELSE 'failed' END,
      verified_at = timezone('utc'::text, now()),
      metadata = COALESCE(p_metadata, metadata),
      updated_at = timezone('utc'::text, now())
    WHERE id = v_record.id;

    RETURN QUERY SELECT FALSE, FALSE, 0::BIGINT, 0::BIGINT, 'Payment gateway status is ' || p_gateway_status;
    RETURN;
  END IF;

  -- Mark payment record as successful
  UPDATE public.payment_records
  SET
    status = 'success',
    verified_at = timezone('utc'::text, now()),
    metadata = COALESCE(p_metadata, metadata),
    updated_at = timezone('utc'::text, now())
  WHERE id = v_record.id;

  -- Atomically credit user wallet
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

REVOKE ALL ON FUNCTION public.credit_verified_payment(TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_verified_payment(TEXT, TEXT, JSONB) TO service_role;

-- 8. Harden start_live_session
-- Prevents concurrent live sessions and enforces caller ownership
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.start_live_session(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.start_live_session(UUID, TEXT) TO authenticated, service_role;

-- 9. Harden heartbeat_and_meter_session
-- Enforces server timestamp bounding, ownership, and rate limit
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
  v_max_server_elapsed_seconds BIGINT;
BEGIN
  -- Strict caller verification
  IF NOT public.check_is_service_or_owner(p_user_id) THEN
    RAISE EXCEPTION 'Unauthorized: Caller does not own user_id %', p_user_id;
  END IF;

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

  -- Server timestamp sanity check: client cannot report cumulative duration exceeding server elapsed time + 30s buffer
  v_max_server_elapsed_seconds := EXTRACT(EPOCH FROM (timezone('utc'::text, now()) - v_session.started_at))::BIGINT + 30;
  IF p_cumulative_seconds > v_max_server_elapsed_seconds THEN
    p_cumulative_seconds := v_max_server_elapsed_seconds;
  END IF;

  -- Ensure cumulative seconds is not decreasing
  IF p_cumulative_seconds < v_session.duration_seconds THEN
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
      (v_new_balance < v_rate_cents_per_sec),
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
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.heartbeat_and_meter_session(UUID, UUID, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.heartbeat_and_meter_session(UUID, UUID, BIGINT) TO authenticated, service_role;

-- 10. Harden end_live_session
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
  -- Strict caller verification
  IF NOT public.check_is_service_or_owner(p_user_id) THEN
    RAISE EXCEPTION 'Unauthorized: Caller does not own user_id %', p_user_id;
  END IF;

  -- Meter any remaining unbilled cumulative seconds
  SELECT * INTO v_res
  FROM public.heartbeat_and_meter_session(p_session_id, p_user_id, p_final_seconds);

  -- Set final status to completed if not already marked as terminated
  UPDATE public.live_sessions
  SET
    status = CASE
      WHEN live_sessions.status = 'active' THEN 'completed'
      ELSE live_sessions.status
    END,
    ended_at = COALESCE(live_sessions.ended_at, timezone('utc'::text, now())),
    last_heartbeat_at = timezone('utc'::text, now())
  WHERE live_sessions.id = p_session_id
  RETURNING live_sessions.id, live_sessions.status, live_sessions.duration_seconds, live_sessions.billed_amount INTO v_res.session_id, v_res.status, v_res.cumulative_seconds, v_res.billed_cents;

  RETURN QUERY SELECT
    v_res.session_id,
    v_res.status,
    v_res.cumulative_seconds,
    v_res.billed_cents,
    v_res.new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION public.end_live_session(UUID, UUID, BIGINT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.end_live_session(UUID, UUID, BIGINT) TO authenticated, service_role;

-- 11. Harden reconcile_stale_sessions
-- Only callable by service_role (e.g. cron or backend worker)
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
