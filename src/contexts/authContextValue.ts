import { createContext } from 'react'
import type { AuthState, SignUpResponse } from '@/types'

export interface AuthContextType extends AuthState {
  signUp: (email: string, password: string, displayName?: string) => Promise<SignUpResponse>
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  refreshProfile: () => Promise<void>
}

export const AuthContext = createContext<AuthContextType | undefined>(undefined)
