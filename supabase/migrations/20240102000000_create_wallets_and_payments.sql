-- Phase 3 — Dallr Cam: Wallet, Transactions & Paystack Payment Records Migration
-- 1. Create wallets, wallet_transactions, and payment_records tables
-- 2. Configure constraints, indexes, and Row Level Security (RLS)
-- 3. Stored procedures for atomic wallet credits, debits, and idempotent payment handling
-- 4. Triggers for wallet creation on user sign-up and updated_at timestamps

-- Table 1: wallets
CREATE TABLE IF NOT EXISTS public.wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'USD',
  balance BIGINT NOT NULL DEFAULT 0, -- Minor units (cents): 1500 = $15.00
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT wallets_user_id_unique UNIQUE (user_id),
  CONSTRAINT wallets_currency_check CHECK (currency = 'USD'),
  CONSTRAINT wallets_balance_non_negative CHECK (balance >= 0)
);

CREATE INDEX IF NOT EXISTS idx_wallets_user_id ON public.wallets(user_id);

-- Table 2: wallet_transactions
CREATE TABLE IF NOT EXISTS public.wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES public.wallets(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  amount BIGINT NOT NULL, -- Minor units (cents): positive for credit, negative for debit
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

CREATE INDEX IF NOT EXISTS idx_wallet_transactions_user_id ON public.wallet_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_wallet_id ON public.wallet_transactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_created_at ON public.wallet_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wallet_transactions_reference ON public.wallet_transactions(reference);

-- Table 3: payment_records
CREATE TABLE IF NOT EXISTS public.payment_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reference TEXT NOT NULL UNIQUE,
  ngn_amount BIGINT NOT NULL, -- Minor units in NGN kobo (100 kobo = 1 NGN)
  usd_credit_amount BIGINT NOT NULL, -- Minor units in USD cents (100 cents = $1.00)
  exchange_rate_used NUMERIC(12, 4) NOT NULL, -- e.g. 1550.0000
  status TEXT NOT NULL DEFAULT 'initialized',
  paystack_access_code TEXT,
  authorization_url TEXT,
  metadata JSONB DEFAULT '{}'::jsonb,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  CONSTRAINT payment_records_status_check CHECK (
    status IN ('initialized', 'pending', 'success', 'failed', 'abandoned')
  ),
  CONSTRAINT payment_records_min_usd CHECK (usd_credit_amount >= 1500) -- Minimum $15 top-up (1500 cents)
);

CREATE INDEX IF NOT EXISTS idx_payment_records_user_id ON public.payment_records(user_id);
CREATE INDEX IF NOT EXISTS idx_payment_records_reference ON public.payment_records(reference);
CREATE INDEX IF NOT EXISTS idx_payment_records_status ON public.payment_records(status);

-- Enable Row Level Security (RLS) on all tables
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallet_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_records ENABLE ROW LEVEL SECURITY;

-- Wallets RLS:
-- Authenticated users can ONLY SELECT their own wallet.
-- Direct INSERT, UPDATE, DELETE from client is prohibited.
CREATE POLICY "Users can view own wallet"
  ON public.wallets
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Wallet Transactions RLS:
-- Authenticated users can ONLY SELECT their own transactions.
-- Direct INSERT, UPDATE, DELETE from client is prohibited.
CREATE POLICY "Users can view own transactions"
  ON public.wallet_transactions
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- Payment Records RLS:
-- Authenticated users can ONLY SELECT their own payment records.
-- Direct client INSERT, UPDATE, DELETE is prohibited.
CREATE POLICY "Users can view own payment records"
  ON public.payment_records
  FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

-- ----------------------------------------------------
-- DATABASE FUNCTIONS & STORED PROCEDURES
-- ----------------------------------------------------

-- 1. Automatic USD wallet creation trigger on user sign-up
CREATE OR REPLACE FUNCTION public.handle_new_user_wallet()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.wallets (user_id, currency, balance, created_at, updated_at)
  VALUES (NEW.id, 'USD', 0, timezone('utc'::text, now()), timezone('utc'::text, now()))
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created_wallet ON auth.users;
CREATE TRIGGER on_auth_user_created_wallet
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_wallet();

-- Backfill existing users who may not have a wallet yet
INSERT INTO public.wallets (user_id, currency, balance, created_at, updated_at)
SELECT id, 'USD', 0, timezone('utc'::text, now()), timezone('utc'::text, now())
FROM auth.users
ON CONFLICT (user_id) DO NOTHING;

-- 2. Trigger for updated_at timestamps on wallets and payment_records
CREATE OR REPLACE FUNCTION public.handle_wallet_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_wallet_updated ON public.wallets;
CREATE TRIGGER on_wallet_updated
  BEFORE UPDATE ON public.wallets
  FOR EACH ROW EXECUTE FUNCTION public.handle_wallet_updated_at();

DROP TRIGGER IF EXISTS on_payment_record_updated ON public.payment_records;
CREATE TRIGGER on_payment_record_updated
  BEFORE UPDATE ON public.payment_records
  FOR EACH ROW EXECUTE FUNCTION public.handle_wallet_updated_at();

-- 3. Atomic credit procedure (SECURITY DEFINER)
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
  IF p_amount_cents <= 0 THEN
    RAISE EXCEPTION 'Credit amount must be greater than zero.';
  END IF;

  -- Lock wallet row for update
  SELECT id, balance INTO v_wallet_id, v_balance
  FROM public.wallets
  WHERE user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- If wallet does not exist, create it
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Atomic debit procedure (SECURITY DEFINER)
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Idempotent payment crediting function (SECURITY DEFINER)
-- Used by webhook & payment verification edge functions.
-- Guarantees that a payment reference can ONLY be credited once.
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
  SELECT wallet_id, new_balance, transaction_id INTO v_wallet_id, v_new_balance, v_tx_id
  FROM public.credit_wallet(
    v_record.user_id,
    v_record.usd_credit_amount,
    'top_up',
    v_record.reference,
    'Paystack Top Up: $' || TRIM(TO_CHAR(v_record.usd_credit_amount / 100.0, '999999990.00'))
  );

  RETURN QUERY SELECT TRUE, FALSE, v_record.usd_credit_amount, v_new_balance, 'Payment credited successfully';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
