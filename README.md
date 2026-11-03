# Dallr Cam — Desktop Video Calling Studio

Dallr Cam is a desktop studio application built with **Tauri 2**, **React 19**, **TypeScript**, **Vite**, and **Tailwind CSS**. It enables operators to broadcast real-time video calls with balance management and WebRTC streaming.

---

## Phase 3: Real Wallet & Paystack Payment Infrastructure

Phase 3 introduces production-ready USD wallet accounting, Paystack NGN checkout integration, backend-controlled exchange rates, and idempotent webhook verification.

### Business Rules
- **Wallet Currency**: USD
- **Payment Currency**: NGN
- **Minimum Top-Up**: $15.00 USD equivalent (enforced on both client and server)
- **Live Video Usage Rate**: $0.04 USD per second
- **Monetary Representation**: Integer minor units (USD cents: `$15.00` = `1500`, NGN kobo: `100 kobo` = `1 NGN`) to prevent floating-point calculation drift.
- **Client Security**: Desktop client cannot directly update wallet balances. All credits and debits occur through backend functions and PostgreSQL stored procedures (`credit_wallet`, `debit_wallet`, `credit_verified_payment`).
- **Idempotency**: Webhook verification verifies transaction status and credits each Paystack reference exactly once. Duplicate or delayed events are safely ignored.

---

## Database Architecture & Migrations

Database migration files are located under `supabase/migrations/`:
- `20240101000000_create_profiles.sql` (Phase 2 Auth & Profiles)
- `20240102000000_create_wallets_and_payments.sql` (Phase 3 Wallets & Payments)

### Tables
1. **`wallets`**:
   - `id`: UUID Primary Key
   - `user_id`: UUID References `auth.users(id)` ON DELETE CASCADE (UNIQUE)
   - `currency`: TEXT (CHECK `currency = 'USD'`)
   - `balance`: BIGINT (Stored in integer cents, CHECK `balance >= 0`)
   - `created_at`, `updated_at`: TIMESTAMPTZ

2. **`wallet_transactions`**:
   - `id`: UUID Primary Key
   - `wallet_id`: UUID References `public.wallets(id)` ON DELETE CASCADE
   - `user_id`: UUID References `auth.users(id)` ON DELETE CASCADE
   - `type`: TEXT (`top_up`, `live_session_charge`, `refund`, `adjustment`)
   - `amount`: BIGINT (Minor units in cents: positive for credits, negative for debits)
   - `currency`: TEXT (`USD`)
   - `status`: TEXT (`pending`, `completed`, `failed`, `reversed`)
   - `reference`: TEXT (Unique external reference, e.g. Paystack reference)
   - `description`: TEXT
   - `created_at`: TIMESTAMPTZ

3. **`payment_records`**:
   - `id`: UUID Primary Key
   - `user_id`: UUID References `auth.users(id)` ON DELETE CASCADE
   - `reference`: TEXT UNIQUE (Paystack transaction reference)
   - `ngn_amount`: BIGINT (NGN kobo, minor units)
   - `usd_credit_amount`: BIGINT (USD cents, minor units; CHECK `usd_credit_amount >= 1500`)
   - `exchange_rate_used`: NUMERIC(12, 4) (NGN per USD rate)
   - `status`: TEXT (`initialized`, `pending`, `success`, `failed`, `abandoned`)
   - `paystack_access_code`: TEXT
   - `authorization_url`: TEXT
   - `metadata`: JSONB
   - `verified_at`: TIMESTAMPTZ
   - `created_at`, `updated_at`: TIMESTAMPTZ

### Row Level Security (RLS)
- Authenticated users are only granted `SELECT` access to rows where `auth.uid() = user_id`.
- Direct `INSERT`, `UPDATE`, or `DELETE` requests from the client are forbidden. Balance modifications are executed exclusively through SECURITY DEFINER PostgreSQL functions (`credit_wallet`, `debit_wallet`, `credit_verified_payment`).

---

## Backend Edge Functions

Located in `supabase/functions/`:

1. **`get-exchange-rate`**:
   - Returns the backend-authoritative exchange rate (default: `1550 NGN/USD`), minimum top-up requirement (`$15 USD`), and usage rate (`$0.04/s`).
   - Prevents desktop client from forging conversion rates.

2. **`initialize-payment`**:
   - Authenticates caller using Supabase JWT.
   - Enforces `$15.00 USD` minimum server-side.
   - Calculates NGN amount in kobo using backend rate.
   - Generates unique reference `dallr_<uid>_<timestamp>_<rand>`.
   - Initializes transaction with Paystack API (`https://api.paystack.co/transaction/initialize`) using server-side secret key `PAYSTACK_SECRET_KEY`.
   - Records transaction in `payment_records` table with status `initialized`.
   - Returns checkout `authorization_url` to client.

3. **`paystack-webhook`**:
   - Receives Paystack webhook events.
   - Validates `x-paystack-signature` HMAC-SHA512 header with `PAYSTACK_SECRET_KEY`.
   - On `charge.success`: Independently calls Paystack API (`https://api.paystack.co/transaction/verify/:ref`) to confirm amount and payment status.
   - Invokes `credit_verified_payment` stored procedure to atomically and idempotently credit the user's USD wallet.
   - Records failed or abandoned events without crediting.

4. **`verify-payment`**:
   - Authenticated endpoint for the desktop application to check transaction status.
   - Queries Paystack API directly and synchronizes payment record and wallet balance.

---

## Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

| Variable | Scope | Description |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Client (Vite) | Supabase project URL |
| `VITE_SUPABASE_ANON_KEY` | Client (Vite) | Supabase public anonymous API key |
| `VITE_APP_NAME` | Client (Vite) | Application name (default: `Dallr Cam`) |
| `VITE_APP_ENV` | Client (Vite) | Environment mode (`development` / `production`) |
| `PAYSTACK_SECRET_KEY` | Backend (Edge Functions) | Paystack Secret Key (`sk_live_...` or `sk_test_...`) |
| `SUPABASE_SERVICE_ROLE_KEY` | Backend (Edge Functions) | Supabase admin secret key for database operations |
| `PAYSTACK_USD_TO_NGN_RATE` | Backend (Edge Functions) | Authoritative USD to NGN exchange rate (default: `1550`) |

---

## Testing & Verification

### Run unit and integration tests
```bash
npm test
```

### Type check and build frontend
```bash
npm run build
```

### Lint codebase
```bash
npm run lint
```

### Tauri desktop check
```bash
cargo check --manifest-path src-tauri/Cargo.toml
```
