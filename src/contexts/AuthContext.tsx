import React, { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '@/lib/supabase'
import { authService } from '@/services/authService'
import type { User, Profile, SignUpResponse } from '@/types'
import { AuthContext } from './authContextValue'

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [session, setSession] = useState<Session | null>(null)
  const [user, setUser] = useState<User | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [error, setError] = useState<string | null>(null)

  const syncUserProfile = async (activeSession: Session | null) => {
    if (!activeSession?.user) {
      setUser(null)
      setProfile(null)
      return
    }

    const supaUser = activeSession.user
    const fallbackDisplayName =
      (supaUser.user_metadata?.display_name as string) || supaUser.email?.split('@')[0] || 'Operator'

    setUser({
      id: supaUser.id,
      email: supaUser.email || '',
      displayName: fallbackDisplayName,
    })

    try {
      const fetchedProfile = await authService.getProfile(supaUser.id)
      if (fetchedProfile) {
        setProfile(fetchedProfile)
        if (fetchedProfile.display_name) {
          setUser({
            id: supaUser.id,
            email: supaUser.email || '',
            displayName: fetchedProfile.display_name,
          })
        }
      } else {
        // Fallback: trigger ensureProfile if DB trigger didn't fire
        const created = await authService.ensureProfile(
          supaUser.id,
          supaUser.email || '',
          fallbackDisplayName
        )
        if (created) {
          setProfile(created)
        }
      }
    } catch (e) {
      console.warn('Could not load profile from profiles table:', e)
    }
  }

  useEffect(() => {
    let isMounted = true

    // Initialize session and restore existing persistent login
    const initSession = async () => {
      try {
        const initialSession = await authService.getSession()
        if (isMounted) {
          setSession(initialSession)
          if (initialSession) {
            await syncUserProfile(initialSession)
          }
        }
      } catch (err) {
        console.error('Session initialization error:', err)
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to initialize session')
        }
      } finally {
        if (isMounted) {
          setIsLoading(false)
        }
      }
    }

    void initSession()

    // Listen for auth state events (SIGNED_IN, SIGNED_OUT, TOKEN_REFRESHED, USER_UPDATED)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(async (event, newSession) => {
      if (!isMounted) return

      if (event === 'SIGNED_OUT' || !newSession) {
        setSession(null)
        setUser(null)
        setProfile(null)
        setIsLoading(false)
      } else if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') {
        setSession(newSession)
        await syncUserProfile(newSession)
        setIsLoading(false)
      }
    })

    return () => {
      isMounted = false
      subscription.unsubscribe()
    }
  }, [])

  const signUp = async (email: string, password: string, displayName?: string): Promise<SignUpResponse> => {
    setError(null)
    try {
      const res = await authService.signUp(email, password, displayName)
      if (res.session) {
        setSession(res.session)
        await syncUserProfile(res.session)
      }
      return res
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Sign up failed'
      setError(msg)
      throw err
    }
  }

  const signIn = async (email: string, password: string) => {
    setError(null)
    try {
      const data = await authService.signIn(email, password)
      setSession(data.session)
      await syncUserProfile(data.session)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Sign in failed'
      setError(msg)
      throw err
    }
  }

  const signOut = async () => {
    setError(null)
    try {
      await authService.signOut()
      setSession(null)
      setUser(null)
      setProfile(null)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Sign out failed'
      setError(msg)
      throw err
    }
  }

  const refreshProfile = async () => {
    if (session) {
      await syncUserProfile(session)
    }
  }

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        session,
        isAuthenticated: !!session && !!user,
        isLoading,
        error,
        signUp,
        signIn,
        signOut,
        refreshProfile,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
