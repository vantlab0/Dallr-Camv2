# Dallr Cam — Desktop Video Calling Studio

Dallr Cam is a desktop studio application built with **Tauri 2**, **React 19**, **TypeScript**, **Vite**, and **Tailwind CSS**. It enables operators to broadcast real-time video calls with balance management and WebRTC streaming.

---

## Phase 7: Real-Time Session Billing, Security & Production Readiness

Phase 7 delivers authoritative backend-controlled session metering, cumulative integer arithmetic billing, low and critical balance notifications, automatic fund-exhaustion teardown, and production desktop builds for Windows and macOS.

### 1. Authoritative Session Metering & Business Rules
- **Wallet Currency**: United States Dollar (`USD`)
- **Payment Currency**: Nigerian Naira (`NGN`) via Paystack checkout
- **Minimum Top-Up**: **$15.00 USD** equivalent (strictly enforced)
- **Billing Rate**: **$0.04 USD per second** (4 cents / billable second)
  - 60 seconds = $2.40 USD (240 cents)
  - 120 seconds = $4.80 USD (480 cents)
  - 300 seconds = $12.00 USD (1200 cents)
  - 375 seconds = $15.00 USD (1500 cents)
- **Activation Gate**: Usage metering initiates only once Decart Lucy 2.5 confirms an active generating WebRTC stream.
- **Heartbeat Cadence**: 5 seconds cumulative usage reporting via `sessionBillingService` and `session-heartbeat` Edge Function.
- **Balance Warnings**:
  - Low balance warning when balance covers `< 30s` ($1.20 USD).
  - Critical balance warning when balance covers `< 10s` ($0.40 USD).
  - Automatic stream termination and window closure when funds are exhausted.

### 2. Database Migrations & Tables
- `supabase/migrations/20240101000000_create_profiles.sql`: User profiles and signup triggers.
- `supabase/migrations/20240102000000_create_wallets_and_payments.sql`: Wallets, transactions, Paystack records, and RLS.
- `supabase/migrations/20240103000000_create_live_sessions_and_billing.sql`: `live_sessions` table, `start_live_session`, `heartbeat_and_meter_session`, `end_live_session`, and `reconcile_stale_sessions` stored procedures.

### 3. Comprehensive Documentation
- See [`PRODUCTION_READINESS.md`](./PRODUCTION_READINESS.md) for full system architecture, database schema, API contracts, security review, known limitations, and Windows/macOS native build instructions.

---

## Phase 5: Decart Lucy 2.5 Real-Time Video Transformation

Phase 5 integrates the official `@decartai/sdk` and establishes a real-time WebRTC transformation session utilizing the **Decart Lucy 2.5** model (`lucy-2.5`).

### 1. Decart SDK & Model Specifications
- **SDK Package**: `@decartai/sdk` (v0.2.14+)
- **Model Identifier**: `lucy-2.5` (`models.realtime("lucy-2.5")`)
- **Native Resolution**: 1280×720 (720p) at 30 fps
- **Transport**: WebRTC
- **Reference Image**: Supported formats: PNG, JPG, JPEG, WebP. Kept in memory (decoded base64 dataUrl / Blob) without cloud upload.
- **Prompt Enhancement**: Enabled by default (`enhance: true`) to adapt instructions to camera feeds and reference images.
- **Dynamic Updates**: Uses unified atomic `set({ prompt, image, enhance: true })` or `setPrompt()` to modify styles without dropping the WebRTC connection.

### 2. Secure Backend Architecture
- **Permanent Secret Isolation**: The permanent secret key (`DECART_API_KEY`) is stored strictly on the backend / Supabase Edge Functions. It is never bundled into or accessible by the client desktop app.
- **Short-Lived Client Tokens**: Tokens are generated on the server with a configurable TTL (default 300s / 5 minutes), scoped strictly to `allowedModels: ["lucy-2.5"]`.
- **Pre-flight Wallet Verification**: Before minting a client token, the backend authenticates the user's Supabase JWT and checks that the user's USD wallet holds at least $0.04 USD (4 cents, representing at least 1 second of live streaming at $0.04/sec).
- **Backend Function**: `supabase/functions/create-decart-token/index.ts`
  - Validates `Authorization: Bearer <jwt>`.
  - Verifies USD wallet balance `>= 4` cents.
  - Calls Decart `client.tokens.create({ expiresIn: 300, allowedModels: ["lucy-2.5"] })`.
  - Returns `{ apiKey, expiresAt, permissions, constraints }`.

### 3. Stream Architecture & Multi-Window Readiness (Phase 6)
- **Service Layer**: `src/services/decartStreamService.ts` implements a modular singleton managing the WebRTC connection, camera tracks, event callbacks, and cleanup.
- **Shared Stream State**: Exposes `sessionId`, `subscribeToken`, `localStream`, and `remoteStream`.
- **Stream Sharing for Phase 6**: Other Tauri windows can subscribe to active sessions via `client.realtime.subscribe({ token: subscribeToken })` without duplicating camera hardware locks or opening redundant upstream encoder connections.
- **Lifecycle States**:
  - `idle`: Camera and WebRTC idle.
  - `preparing`: Pre-flight eligibility validated and camera media stream acquired.
  - `connecting`: WebRTC peer connection dialing Decart signaling.
  - `connected`: Active live stream transforming frames in real-time.
  - `reconnecting`: Automatic exponential-backoff retry on network interruption.
  - `failed`: Terminal failure or credential rejection.
  - `ending`: Teardown initiated.
  - `ended`: Resources cleanly released.

### 4. UI Components
- **`LiveStreamView.tsx`**:
  - Displays primary transformed Decart WebRTC remote stream.
  - Displays picture-in-picture local camera preview and reference portrait.
  - Live session header with pulsating "LIVE" indicator, model tag ("Decart Lucy 2.5 (720p)"), connection status badge, live duration timer, and real-time USD billing counter ($0.04/sec).
  - Dynamic prompt input bar to update prompts on the fly via `updatePrompt`.
  - Actionable error banner with dismiss and auto-recovery.
  - "End Stream" button for graceful teardown.
- **`LiveSetupModal.tsx`**:
  - Manages portrait selection, validation, and pre-flight checks.
  - Transitions into live streaming mode upon user initiating live stream.

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

---

## Backend Edge Functions

Located in `supabase/functions/`:

1. **`create-decart-token`**:
   - Authenticates caller using Supabase JWT.
   - Verifies USD wallet has at least $0.04 USD.
   - Mints a short-lived Decart client token scoped to `lucy-2.5`.

2. **`get-exchange-rate`**:
   - Returns the backend-authoritative exchange rate (default: `1550 NGN/USD`), minimum top-up requirement (`$15 USD`), and usage rate (`$0.04/s`).

3. **`initialize-payment`**:
   - Authenticates caller and initializes Paystack transaction.

4. **`paystack-webhook`**:
   - Validates HMAC-SHA512 webhook signature and credits verified transactions.

5. **`verify-payment`**:
   - Synchronizes payment status directly with Paystack API.

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
| `DECART_API_KEY` | Backend (Edge Functions) | Decart Secret API Key (`dct_...`) |
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
