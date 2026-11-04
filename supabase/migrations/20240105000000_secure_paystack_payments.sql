-- Migration: 20240105000000_secure_paystack_payments.sql
-- Hardens payment processing and wallet crediting against race conditions and concurrent deliveries.
-- 1. Strictly enforces service_role caller on credit_verified_payment.
-- 2. Uses FOR UPDATE on payment_records to serialize concurrent verification/webhook invocations.
-- 3. Ensures failed, abandoned, or already-credited payments never credit the wallet.
-- 4. Atomically credits the wallet within the transaction.

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

  -- Idempotency check: if already marked success, return already processed status
  IF v_record.status = 'success' THEN
    SELECT balance INTO v_new_balance FROM public.wallets WHERE user_id = v_record.user_id;
    RETURN QUERY SELECT TRUE, TRUE, v_record.usd_credit_amount, COALESCE(v_new_balance, 0::BIGINT), 'Payment already credited';
    RETURN;
  END IF;

  -- If gateway report is not success, update record status to failed or abandoned
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
