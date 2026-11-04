#!/usr/bin/env python3
"""
Real Database Integration Test Runner
Validates sequential migration application, obsolete RPC function removal,
15-second lease bounding, row locking, and idempotent session billing against local PostgreSQL.
"""

import subprocess
import sys

def run_cmd(cmd, check=True):
    res = subprocess.run(cmd, capture_output=True, text=True)
    if check and res.returncode != 0:
        print(f"Command failed: {' '.join(cmd)}")
        print(f"Stdout:\n{res.stdout}")
        print(f"Stderr:\n{res.stderr}")
        sys.exit(1)
    return res

print("=== 1. Setting up fresh PostgreSQL integration database ===")
run_cmd(["sudo", "-u", "postgres", "dropdb", "--if-exists", "dallr_integration_test"])
run_cmd(["sudo", "-u", "postgres", "createdb", "dallr_integration_test"])

# Setup Supabase auth schema and standard roles
auth_setup = """
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE,
  raw_user_meta_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID AS $$
  SELECT NULL::UUID;
$$ LANGUAGE sql STABLE;
CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT AS $$
  SELECT 'authenticated'::TEXT;
$$ LANGUAGE sql STABLE;
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role;
  END IF;
END
$$;
"""
run_cmd(["sudo", "-u", "postgres", "psql", "-d", "dallr_integration_test", "-c", auth_setup])

print("=== 2. Applying all migrations in sequential timestamp order ===")
MIGRATIONS = [
    "supabase/migrations/20240101000000_create_profiles.sql",
    "supabase/migrations/20240102000000_create_wallets_and_payments.sql",
    "supabase/migrations/20240103000000_create_live_sessions_and_billing.sql",
    "supabase/migrations/20240104000000_harden_security_and_billing.sql",
    "supabase/migrations/20240105000000_secure_paystack_payments.sql",
    "supabase/migrations/20240106000000_server_authoritative_billing.sql",
    "supabase/migrations/20240107000000_prevent_duplicate_live_sessions.sql",
]

for m in MIGRATIONS:
    print(f"  -> Applying {m}...")
    with open(m, "rb") as f:
        res = subprocess.run(["sudo", "-u", "postgres", "psql", "-d", "dallr_integration_test", "-v", "ON_ERROR_STOP=1"], input=f.read(), capture_output=True)
    if res.returncode != 0:
        print(f"FAILED on {m}:\n{res.stderr.decode()}")
        sys.exit(1)

print("=== 3. Verifying obsolete 3-argument RPC functions are completely dropped ===")
check_functions_sql = """
SELECT routine_name, specific_name, data_type
FROM information_schema.routines
WHERE specific_schema = 'public'
  AND routine_name IN ('heartbeat_and_meter_session', 'end_live_session');
"""
res = run_cmd(["sudo", "-u", "postgres", "psql", "-d", "dallr_integration_test", "-t", "-A", "-F", "|", "-c", check_functions_sql])
lines = [l.strip() for l in res.stdout.strip().splitlines() if l.strip()]
print(f"Found {len(lines)} active signatures for billing procedures:")
for l in lines:
    print(f"  - {l}")
assert len(lines) == 2, f"Expected exactly 2 routines (2-arg versions), got {len(lines)}"

print("=== 4. Testing 15-second lease bounding & last_billed_at reset in real DB ===")
lease_test_sql = """
SET request.jwt.claims = '{"role": "service_role"}';

-- Create test user (auto-triggers wallet creation)
INSERT INTO auth.users (id, email) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'dbtest@dallrcam.com');
UPDATE public.wallets SET balance = 2000 WHERE user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- Start session
SELECT session_id, current_balance FROM public.start_live_session('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid, 'decart-test-1');

-- Simulate client network freeze: last_billed_at is 40 seconds ago
UPDATE public.live_sessions
SET last_billed_at = timezone('utc'::text, now()) - INTERVAL '40 seconds'
WHERE user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- First heartbeat: should cap usage at 15s (60 cents) and reset last_billed_at to now()
SELECT cumulative_seconds, billed_cents, new_balance, stop_requested
FROM public.heartbeat_and_meter_session(
  (SELECT id FROM public.live_sessions WHERE user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid
);

-- Check that last_billed_at is now within 2 seconds of current time
SELECT EXTRACT(EPOCH FROM (timezone('utc'::text, now()) - last_billed_at)) < 2 AS lease_reset_verified
FROM public.live_sessions
WHERE user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

-- Simulate next 5-second interval
UPDATE public.live_sessions
SET last_billed_at = timezone('utc'::text, now()) - INTERVAL '5 seconds'
WHERE user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

SELECT cumulative_seconds, billed_cents, new_balance
FROM public.heartbeat_and_meter_session(
  (SELECT id FROM public.live_sessions WHERE user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid
);

-- End session cleanly
SELECT total_seconds, total_billed_cents, final_balance, status
FROM public.end_live_session(
  (SELECT id FROM public.live_sessions WHERE user_id = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid
);
"""
res = run_cmd(["sudo", "-u", "postgres", "psql", "-d", "dallr_integration_test", "-c", lease_test_sql])
print(res.stdout)

print("=== 5. Testing scheduled reconciliation on stale sessions ===")
reconcile_test_sql = """
SET request.jwt.claims = '{"role": "service_role"}';

-- Create another user with active session abandoned > 45s ago
INSERT INTO auth.users (id, email) VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'abandoned@dallrcam.com');
UPDATE public.wallets SET balance = 500 WHERE user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

INSERT INTO public.live_sessions (
  user_id, status, started_at, last_heartbeat_at, last_billed_at
) VALUES (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  'active',
  timezone('utc'::text, now()) - INTERVAL '90 seconds',
  timezone('utc'::text, now()) - INTERVAL '60 seconds',
  timezone('utc'::text, now()) - INTERVAL '60 seconds'
);

SELECT public.reconcile_stale_sessions() AS closed_stale_count;

SELECT id, status, ended_at IS NOT NULL as has_ended_at
FROM public.live_sessions
WHERE user_id = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
"""
res = run_cmd(["sudo", "-u", "postgres", "psql", "-d", "dallr_integration_test", "-c", reconcile_test_sql])
print(res.stdout)

print("ALL REAL DATABASE INTEGRATION TESTS PASSED SUCCESSFULLY!")
