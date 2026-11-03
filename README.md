# Dallr Cam — Desktop Video Calling Studio

Dallr Cam is a desktop studio application built with **Tauri 2**, **React 19**, **TypeScript**, **Vite**, and **Tailwind CSS**. It enables operators to broadcast real-time video calls with balance management and WebRTC streaming.

---

## Phase 2: Supabase Authentication

Phase 2 introduces production-ready Supabase authentication and user profile management, including session persistence, input validation, row-level security (RLS), and automated database triggers.

### Features
- **Email & Password Authentication**: Full sign up and sign in flows with client-side validation (email format, 8+ character password, password matching).
- **Persistent Sessions**: Sessions are automatically saved in local storage and restored when the desktop app starts.
- **Session Lifecycle & Expiry**: Listens to `onAuthStateChange` to handle token refresh, user updates, and session expiration.
- **Email Verification**: Handles email confirmation flow with feedback messaging when confirmation links are sent.
- **Protected Studio Dashboard**: Unauthenticated users cannot access dashboard actions or live setup; logging out redirects back to authentication.
- **User Profiles with RLS**: `profiles` table linked to `auth.users` with Row Level Security allowing operators to access only their own data.
- **Zero Secrets in Client**: Uses only `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`. The `service_role` key is never exposed.

---

## Environment Variables

Copy `.env.example` to `.env` and fill in your Supabase project credentials:

```bash
cp .env.example .env
```

| Variable | Description | Example / Default |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Your Supabase project URL | `https://xyzproject.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | Your Supabase public anonymous API key | `eyJhbGciOi...` |
| `VITE_APP_NAME` | Application name | `Dallr Cam` |
| `VITE_APP_ENV` | Application environment | `development` |
| `VITE_MOCK_BALANCE_USD` | Fallback starting balance | `124.50` |
| `VITE_MOCK_USD_TO_NGN_RATE` | USD to NGN exchange rate | `1550` |

---

## Database Migrations & SQL Setup

The migration file is located at `supabase/migrations/20240101000000_create_profiles.sql`.

To apply the migration to your Supabase project:
1. Navigate to the **SQL Editor** in your Supabase dashboard (or run with `supabase db push` if using the Supabase CLI).
2. Execute the migration script:

```sql
-- 1. Create profiles table
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now()),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);

-- 2. Enable Row Level Security (RLS)
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 3. RLS Policies: users can only view, insert, and update their own profile
CREATE POLICY "Users can view own profile"
  ON public.profiles
  FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile"
  ON public.profiles
  FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Users can update own profile"
  ON public.profiles
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- 4. Automatic profile creation trigger on auth.users sign-up
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Trigger for updated_at timestamp
CREATE OR REPLACE FUNCTION public.handle_profile_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = timezone('utc'::text, now());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS on_profile_updated ON public.profiles;
CREATE TRIGGER on_profile_updated
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_profile_updated_at();
```

---

## Development & Testing Commands

### Install dependencies
```bash
npm install
```

### Run Vitest test suite
```bash
npm test
```

### Type check and build frontend
```bash
npm run build
```

### Lint code
```bash
npm run lint
```

### Tauri desktop check
```bash
cargo check --manifest-path src-tauri/Cargo.toml
```

---

## Security Guidelines

- **Service-Role Key Protection**: Never include `SUPABASE_SERVICE_ROLE_KEY` in desktop applications or git repositories.
- **Row Level Security**: All operations against `public.profiles` require active JWT authentication and match `auth.uid() = id`.
- **Validation**: All user inputs (emails, passwords, passwords match) are validated on the client before triggering authentication requests.
