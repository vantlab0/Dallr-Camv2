# Dallr Cam — Technical Production Readiness Report

## Executive Summary
Dallr Cam is a production-ready desktop video calling studio application developed with **Tauri 2**, **React 19**, **TypeScript**, **Vite**, **Tailwind CSS**, and **Supabase**. The platform enables operators to transform their live webcam video streams into realistic reference identities in real time using the **Decart Lucy 2.5** WebRTC model (`lucy-2.5` @ 1280×720 30fps).

Phase 7 introduces authoritative backend-controlled session billing, cumulative integer usage metering ($0.04 USD per billable second), zero-trust wallet balance protection, automatic low/critical balance warnings, safe fund-exhaustion teardown, and production desktop builds for Windows and macOS.

---

## 1. System Architecture

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Dallr Cam Desktop Application                   │
│                                                                        │
│   ┌────────────────────────┐           ┌───────────────────────────┐   │
│   │ Main Studio Window     │           │ Borderless Video Window   │   │
│   │ - Account & Auth       │           │ - Route: /?view=video-out │   │
│   │ - Paystack USD Top-Up  │           │ - Decorations: false      │   │
│   │ - Identity Reference   │           │ - Dedicated for screen    │   │
│   │ - Dynamic Prompting    │           │   share / Zoom / Meet     │   │
│   │ - Authoritative Timer  │           └─────────────▲─────────────┘   │
│   └───────────┬────────────┘                         │                 │
│               │ BroadcastChannel / Local RTCPeerConnection Loopback     │
│               │ (Cross-window relay without duplicate Decart encoder)  │
│               ▼                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ DecartStreamService (WebRTC 720p 30fps with Decart AI Cloud)  │   │
│   │ SessionBillingService (Cumulative 5s Metering Heartbeats)      │   │
│   └────────────────────────────────┬───────────────────────────────┘   │
└────────────────────────────────────┼───────────────────────────────────┘
                                     │ HTTPS / JWT
                                     ▼
        ┌────────────────────────────────────────────────────────┐
        │           Supabase Backend & Edge Functions           │
        │                                                        │
        │  • create-decart-token: Issues short-lived token      │
        │  • session-heartbeat: Authoritative 5s metering debit  │
        │  • session-end: Final session reconciliation           │
        │  • initialize-payment: Paystack checkout init         │
        │  • verify-payment: Direct Paystack status verification │
        │  • paystack-webhook: HMAC-SHA512 webhook handler       │
        │                                                        │
        │  Database (PostgreSQL + RLS + SECURITY DEFINER RPCs):  │
        │  • wallets, wallet_transactions, payment_records       │
        │  • live_sessions, start_live_session,                  │
        │    heartbeat_and_meter_session, end_live_session       │
        └────────────────────────────────────────────────────────┘
```

---

## 2. Business Pricing & Monetary Rules
- **Wallet Currency**: United States Dollar (`USD`).
- **Payment Currency**: Nigerian Naira (`NGN`).
- **Minimum Top-Up**: **$15.00 USD** equivalent (strictly enforced on both client and backend).
- **Billing Rate**: **$0.04 USD per second** (4 cents / billable second).
  - 60 seconds: $2.40 USD (240 cents)
  - 120 seconds: $4.80 USD (480 cents)
  - 300 seconds: $12.00 USD (1200 cents)
  - 375 seconds: $15.00 USD (1500 cents)
- **Monetary Representation**: Integer minor units (USD cents: `$15.00 = 1500`, NGN kobo: `100 kobo = 1 NGN`) throughout PostgreSQL columns and stored procedures to guarantee floating-point calculation precision.

---

## 3. Authoritative Usage Metering & Billing Mechanism

### 3.1 Metering Architecture
1. **Activation Trigger**: Billing begins *only* when the Decart Lucy 2.5 WebRTC session is confirmed active (`generating` / `connected`).
2. **Cumulative Seconds Accounting**:
   - The desktop client reports its total monotonically increasing cumulative duration derived from Decart WebRTC generation ticks.
   - The backend computes: `delta_seconds = cumulative_seconds - session.duration_seconds`.
   - `delta_cents = delta_seconds * 4`.
   - Prevents micro-interval rounding distortions and ensures dropped or delayed network packets never cause duplicate charges or missed time.
3. **5-Second Heartbeat Cadence**:
   - Metering heartbeat runs every **5 seconds**.
   - **Trade-off Analysis**: A 5-second interval provides optimal balance: rapid protection against balance exhaustion (maximum overdraft exposure is < 20 cents if an edge case network drop occurs), while generating minimal HTTP request overhead and database row-locking contention compared to 1-second pings.
4. **Time Manipulation Defense**:
   - The desktop clock is never trusted. All start, end, and duration checks are evaluated server-side using PostgreSQL server timestamps (`timezone('utc'::text, now())`) and cumulative generation tick counts validated against server elapsed bounds.

### 3.2 Insufficient Balance & Auto-Cutoff
- **Low Balance Warning**: Triggered when remaining balance covers less than 30 seconds ($1.20 USD).
- **Critical Balance Warning**: Triggered when remaining balance covers less than 10 seconds ($0.40 USD).
- **Balance Exhaustion**:
  - When balance cannot cover further usage, backend stored procedure `heartbeat_and_meter_session` debits the remaining affordable seconds, sets session status to `terminated_insufficient_funds`, and returns `stop_requested: true`.
  - The client immediately:
    1. Ends the active Decart Lucy 2.5 stream.
    2. Closes the borderless video output window.
    3. Broadcasts session teardown across all windows.
    4. Refreshes wallet balance.
    5. Displays the persistent balance exhaustion banner with final billable duration.

---

## 4. Database Schema

### `live_sessions` Table
```sql
CREATE TABLE public.live_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  decart_session_id TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  ended_at TIMESTAMPTZ,
  duration_seconds BIGINT NOT NULL DEFAULT 0,
  billed_amount BIGINT NOT NULL DEFAULT 0, -- USD cents
  status TEXT NOT NULL DEFAULT 'active' CHECK (
    status IN ('active', 'completed', 'terminated_insufficient_funds', 'abandoned', 'failed')
  ),
  last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
```

### `reconciliation_logs` Table
```sql
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
```

### Stored Procedures
- `start_live_session(p_user_id, p_decart_session_id)`: Validates wallet balance `>= 4` cents, initializes session record.
- `heartbeat_and_meter_session(p_session_id, p_user_id, p_cumulative_seconds)`: Locks wallet and session rows `FOR UPDATE`, debits incremental seconds at 4 cents/sec, records `wallet_transactions` ledger entry, returns updated balance and `stop_requested`.
- `end_live_session(p_session_id, p_user_id, p_final_seconds)`: Finalizes duration and status `completed`.
- `reconcile_stale_sessions()`: Automatically reconciles abandoned sessions that have ceased sending heartbeats (> 45s heartbeat lapse). Safe and idempotent: uses `FOR UPDATE SKIP LOCKED`, debits unbilled duration up to the heartbeat lease cap (15s) without exceeding wallet balance, transitions status to `abandoned`, sets `ended_at = last_heartbeat_at`, and logs execution telemetry into `reconciliation_logs`. Restricted strictly to `service_role`.

### 4.1 Automatic Stale Session Reconciliation Scheduler
- **Scheduler**: Supabase `pg_cron`
- **Job Name**: `'reconcile-stale-live-sessions'`
- **Schedule**: Every minute (`* * * * *`)
- **Command**: `SELECT public.reconcile_stale_sessions();`
- **Status Transition Policy**: Marks stale sessions as `abandoned` and freezes `ended_at` at `last_heartbeat_at`.
- **Billing Boundary Protection**: Prevents indefinite billable accumulation by bounding unbilled duration to `15 seconds` (maximum heartbeat lease) and never overdrafting user wallets.
- **Idempotency & Concurrency**: Subsequent runs do not duplicate charges or transactions. Concurrency is guarded via PostgreSQL row locks (`FOR UPDATE SKIP LOCKED`).
- **Deployment Safety**: Migrations unschedule existing jobs before re-registering to guarantee zero duplicate cron jobs across deployments.
- **Security & Auditability**: Execution is restricted to `service_role`. Outcomes (timestamp, duration, reconciled counts, status) are logged to `public.reconciliation_logs` without exposing credentials, secrets, or user tokens.

---

## 5. Security Audit Findings & Defenses

| Surface | Threat | Mitigation |
| :--- | :--- | :--- |
| **Wallet Mutations** | Client modifying balance or tampering with transactions | Desktop client only has `SELECT` RLS permissions on `wallets` and `wallet_transactions`. All credits and debits occur via `SECURITY DEFINER` stored procedures invoked by backend Edge Functions. |
| **Paystack Verification** | Spoofed redirect or tampered amount | Client redirects are never trusted. Payment crediting requires backend HMAC-SHA512 webhook signature verification or direct backend REST inquiry with `PAYSTACK_SECRET_KEY`. |
| **Decart Secret** | Decart permanent API key exposure | Secret key `DECART_API_KEY` exists strictly on backend. App receives only short-lived tokens (scoped to `lucy-2.5`). |
| **Session Ownership** | User A metering User B's session | All Edge Functions authenticate the caller's Supabase JWT and enforce `WHERE user_id = auth.uid()` in stored procedures. |
| **Desktop IPC** | Privilege escalation via Tauri commands | Strict Tauri 2 capabilities configuration (`src-tauri/capabilities/default.json`) restricted to `core:default`. |
| **Portrait Validation** | Malicious file payload | Strict client MIME type and image dimension pre-validation (`validateAndProcessReferenceImage`); kept in memory without permanent cloud storage. |

---

## 6. Environment Variables

### Client Application (`.env`)
```bash
VITE_SUPABASE_URL="https://your-supabase-project.supabase.co"
VITE_SUPABASE_ANON_KEY="eyJhbGciOi..."
VITE_APP_NAME="Dallr Cam"
VITE_APP_ENV="production"
```

### Supabase Edge Functions Secrets
```bash
DECART_API_KEY="dct_live_..."
PAYSTACK_SECRET_KEY="sk_live_..."
SUPABASE_URL="https://your-supabase-project.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="eyJhbGciOi..."
PAYSTACK_USD_TO_NGN_RATE="1550"
```

---

## 7. Build Instructions

### 7.1 Linux Development / CI Host (Environment of Record)
```bash
# Install system development dependencies
sudo apt-get update && sudo apt-get install -y \
  libglib2.0-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev libjavascriptcoregtk-4.1-dev

# Install dependencies and run tests
npm ci
npm test
npm run lint
npm run build

# Verify Tauri Rust backend
cargo check --manifest-path src-tauri/Cargo.toml
```

### 7.2 Windows Desktop Build (`.exe` / `.msi`)
*Note: Tauri cross-compilation from Linux to Windows with webkit/webview bindings requires a Windows host or Windows CI Runner (e.g. GitHub Actions `windows-latest`).*
1. Install prerequisites:
   - [Node.js 20+](https://nodejs.org/)
   - [Rust toolchain](https://www.rust-lang.org/tools/install) (`x86_64-pc-windows-msvc`)
   - [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (C++ workload)
   - [WebView2 Runtime](https://developer.microsoft.com/en-us/microsoft-edge/webview2/) (preinstalled on Windows 10/11)
2. Run production build:
   ```powershell
   npm ci
   npm run tauri build
   ```
3. Bundles output:
   `src-tauri/target/release/bundle/nsis/Dallr Cam_0.1.0_x64-setup.exe`
   `src-tauri/target/release/bundle/msi/Dallr Cam_0.1.0_x64_en-US.msi`

### 7.3 macOS Desktop Build (`.dmg` / `.app`)
*Note: macOS builds require macOS host or GitHub Actions `macos-latest` with Xcode Command Line Tools.*
1. Install prerequisites:
   - Node.js 20+
   - Rust toolchain (`aarch64-apple-darwin` and/or `x86_64-apple-darwin`)
   - Xcode Command Line Tools (`xcode-select --install`)
2. Run production build:
   ```bash
   npm ci
   # For Apple Silicon
   npm run tauri build -- --target aarch64-apple-darwin
   # Or Universal binary
   npm run tauri build -- --target universal-apple-darwin
   ```
3. Bundles output:
   `src-tauri/target/release/bundle/dmg/Dallr Cam_0.1.0_aarch64.dmg`
   `src-tauri/target/release/bundle/macos/Dallr Cam.app`

---

## 8. Known Limitations & Recommendations
1. **Virtual Camera Driver**: Dallr Cam achieves virtual camera functionality via the dedicated borderless `video-output` window shared directly into Zoom, Discord, Google Meet, or OBS Window Capture. For native direct virtual webcam device driver emulation on Windows and macOS, a signed kernel-mode driver (DirectShow on Windows / CoreMediaIO DAL Plugin on macOS) is recommended for future phases.
2. **Offline Mode**: Decart Lucy 2.5 streaming requires active internet connectivity; offline local inference is not supported by the Lucy 2.5 cloud WebRTC architecture.
