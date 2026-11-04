import { describe, it, expect, vi, beforeEach } from 'vitest'
import { authService } from '../services/authService'
import { supabase } from '../lib/supabase'

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: {
      signUp: vi.fn(),
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
      getSession: vi.fn(),
    },
    from: vi.fn(),
  },
  isSupabaseConfigured: true,
}))

describe('authService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('signUp', () => {
    it('successfully registers a new user with email and password and ensures profile', async () => {
      const mockUser = {
        id: 'usr-123',
        email: 'test@example.com',
        user_metadata: { display_name: 'Test Operator' },
      }
      const mockSession = {
        access_token: 'token-abc',
        user: mockUser,
      }

      vi.mocked(supabase.auth.signUp).mockResolvedValueOnce({
        data: { user: mockUser as any, session: mockSession as any },
        error: null,
      })

      const mockSingle = vi.fn().mockResolvedValue({ data: null, error: null })
      const mockUpsertSingle = vi.fn().mockResolvedValue({
        data: {
          id: 'usr-123',
          email: 'test@example.com',
          display_name: 'Test Operator',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        error: null,
      })

      vi.mocked(supabase.from).mockImplementation((table: string) => {
        if (table === 'profiles') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: mockSingle,
            upsert: vi.fn().mockReturnValue({
              select: vi.fn().mockReturnValue({
                maybeSingle: mockUpsertSingle,
              }),
            }),
          } as any
        }
        return {} as any
      })

      const result = await authService.signUp('test@example.com', 'SecurePass123!', 'Test Operator')

      expect(supabase.auth.signUp).toHaveBeenCalledWith({
        email: 'test@example.com',
        password: 'SecurePass123!',
        options: {
          data: {
            display_name: 'Test Operator',
          },
        },
      })
      expect(result.user?.id).toBe('usr-123')
      expect(result.needsEmailVerification).toBe(false)
    })

    it('handles email verification required when no active session returned', async () => {
      const mockUser = {
        id: 'usr-unverified',
        email: 'verify@example.com',
      }

      vi.mocked(supabase.auth.signUp).mockResolvedValueOnce({
        data: { user: mockUser as any, session: null },
        error: null,
      })

      const result = await authService.signUp('verify@example.com', 'SecurePass123!')

      expect(result.user?.id).toBe('usr-unverified')
      expect(result.session).toBeNull()
      expect(result.needsEmailVerification).toBe(true)
    })

    it('throws error for duplicate email registration', async () => {
      vi.mocked(supabase.auth.signUp).mockResolvedValueOnce({
        data: { user: null, session: null },
        error: new Error('User already registered') as any,
      })

      await expect(
        authService.signUp('existing@example.com', 'SecurePass123!')
      ).rejects.toThrow('User already registered')
    })
  })

  describe('signIn', () => {
    it('successfully signs in valid user credentials', async () => {
      const mockUser = { id: 'usr-123', email: 'operator@dallr.app' }
      const mockSession = { access_token: 'jwt-123', user: mockUser }

      vi.mocked(supabase.auth.signInWithPassword).mockResolvedValueOnce({
        data: { user: mockUser as any, session: mockSession as any },
        error: null,
      })

      const result = await authService.signIn('operator@dallr.app', 'Password123!')

      expect(supabase.auth.signInWithPassword).toHaveBeenCalledWith({
        email: 'operator@dallr.app',
        password: 'Password123!',
      })
      expect(result.session?.access_token).toBe('jwt-123')
    })

    it('throws error on invalid login credentials', async () => {
      vi.mocked(supabase.auth.signInWithPassword).mockResolvedValueOnce({
        data: { user: null, session: null },
        error: new Error('Invalid login credentials') as any,
      })

      await expect(
        authService.signIn('operator@dallr.app', 'WrongPassword!')
      ).rejects.toThrow('Invalid login credentials')
    })
  })

  describe('signOut', () => {
    it('successfully calls supabase.auth.signOut', async () => {
      vi.mocked(supabase.auth.signOut).mockResolvedValueOnce({ error: null })

      await authService.signOut()

      expect(supabase.auth.signOut).toHaveBeenCalled()
    })
  })

  describe('getSession', () => {
    it('returns the active session on application restart', async () => {
      const mockSession = { access_token: 'stored-session-token' }
      vi.mocked(supabase.auth.getSession).mockResolvedValueOnce({
        data: { session: mockSession as any },
        error: null,
      })

      const session = await authService.getSession()
      expect(session?.access_token).toBe('stored-session-token')
    })

    it('returns null if session is expired or non-existent', async () => {
      vi.mocked(supabase.auth.getSession).mockResolvedValueOnce({
        data: { session: null },
        error: null,
      })

      const session = await authService.getSession()
      expect(session).toBeNull()
    })
  })
})
