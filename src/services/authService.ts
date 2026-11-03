import { supabase } from '@/lib/supabase'
import type { Profile, ProfileUpdate } from '@/types/database'
import type { SignUpResponse } from '@/types/auth'
import type { Session } from '@supabase/supabase-js'

export const authService = {
  /**
   * Register a new user with email and password
   */
  async signUp(email: string, password: string, displayName?: string): Promise<SignUpResponse> {
    const trimmedEmail = email.trim().toLowerCase()

    const { data, error } = await supabase.auth.signUp({
      email: trimmedEmail,
      password,
      options: {
        data: {
          display_name: displayName?.trim() || trimmedEmail.split('@')[0],
        },
      },
    })

    if (error) {
      throw error
    }

    const user = data.user
    const session = data.session

    // If a session was returned immediately (email confirmation disabled or auto-confirmed),
    // ensure profile exists in database
    if (user && session) {
      try {
        await this.ensureProfile(user.id, user.email || trimmedEmail, displayName)
      } catch (profileErr) {
        console.warn('Profile creation fallback notice:', profileErr)
      }
    }

    return {
      user,
      session,
      needsEmailVerification: !session && !!user,
    }
  },

  /**
   * Sign in with email and password
   */
  async signIn(email: string, password: string) {
    const trimmedEmail = email.trim().toLowerCase()
    const { data, error } = await supabase.auth.signInWithPassword({
      email: trimmedEmail,
      password,
    })

    if (error) {
      throw error
    }

    return data
  },

  /**
   * Sign out the active user session
   */
  async signOut() {
    const { error } = await supabase.auth.signOut()
    if (error) {
      throw error
    }
  },

  /**
   * Get active session
   */
  async getSession(): Promise<Session | null> {
    const { data, error } = await supabase.auth.getSession()
    if (error) {
      throw error
    }
    return data.session
  },

  /**
   * Fetch current user's profile from profiles table
   */
  async getProfile(userId: string): Promise<Profile | null> {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', userId)
      .maybeSingle()

    if (error) {
      console.error('Error fetching profile:', error)
      return null
    }

    return data
  },

  /**
   * Update profile information
   */
  async updateProfile(userId: string, updates: ProfileUpdate): Promise<Profile | null> {
    const { data, error } = await supabase
      .from('profiles')
      .update(updates)
      .eq('id', userId)
      .select()
      .single()

    if (error) {
      throw error
    }

    return data
  },

  /**
   * Ensure profile exists in profiles table
   */
  async ensureProfile(userId: string, email: string, displayName?: string): Promise<Profile | null> {
    const existing = await this.getProfile(userId)
    if (existing) {
      return existing
    }

    const { data, error } = await supabase
      .from('profiles')
      .upsert({
        id: userId,
        email,
        display_name: displayName || email.split('@')[0],
      })
      .select()
      .maybeSingle()

    if (error) {
      console.error('Error ensuring profile:', error)
      return null
    }

    return data
  },
}
