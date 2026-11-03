import type { Profile } from './database'
import type { Session, User as SupabaseUser } from '@supabase/supabase-js'

export interface User {
  id: string
  email: string
  displayName?: string
}

export interface AuthState {
  user: User | null
  profile: Profile | null
  session: Session | null
  isAuthenticated: boolean
  isLoading: boolean
  error: string | null
}

export interface SignUpResponse {
  user: SupabaseUser | null
  session: Session | null
  needsEmailVerification: boolean
}
