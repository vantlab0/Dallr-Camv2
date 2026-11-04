-- Migration: 20240105000000_prevent_duplicate_live_sessions.sql
-- Idempotency and Race Condition Protection for Live Sessions:
-- 1. Partial unique index on public.live_sessions (user_id) WHERE status = 'active'
-- 2. Idempotent start_live_session stored procedure that returns the active session if one exists

-- 1. Create partial unique index to guarantee at database level that a user can have at most one active live session
CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_active_user_live_session
  ON public.live_sessions (user_id)
  WHERE status = 'active';

-- 2. Update start_live_session to be idempotent and safe under concurrent invocations
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
        ended_at = v_last_hb
      WHERE id = v_existing_id;
    ELSE
      -- Active session is still alive: return existing session record idempotently
      -- Update decart_session_id if provided and was not set
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
