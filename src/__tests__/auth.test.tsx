import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from '../App'
import { supabase } from '../lib/supabase'

vi.mock('../lib/supabase', () => {
  return {
    supabase: {
      auth: {
        getSession: vi.fn(),
        signUp: vi.fn(),
        signInWithPassword: vi.fn(),
        signOut: vi.fn(),
        onAuthStateChange: vi.fn(() => ({
          data: {
            subscription: {
              unsubscribe: vi.fn(),
            },
          },
        })),
      },
      channel: vi.fn(() => ({
        on: vi.fn().mockReturnThis(),
        subscribe: vi.fn().mockReturnValue({}),
      })),
      removeChannel: vi.fn(),
      functions: {
        invoke: vi.fn().mockResolvedValue({
          data: {
            usd_to_ngn_rate: 1550,
            wallet_currency: 'USD',
            payment_currency: 'NGN',
            minimum_top_up_usd: 15,
            live_usage_rate_per_second_usd: 0.04,
            updated_at: new Date().toISOString(),
          },
          error: null,
        }),
      },
      from: vi.fn((table: string) => ({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockImplementation(() => Promise.resolve({ data: [], error: null })),
        maybeSingle: vi.fn().mockImplementation(() => {
          if (table === 'wallets') {
            return Promise.resolve({
              data: {
                id: 'w-1',
                user_id: 'usr-456',
                currency: 'USD',
                balance: 10000,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              },
              error: null,
            })
          }
          return Promise.resolve({
            data: {
              id: 'usr-123',
              email: 'mock@dallr.app',
              display_name: 'Lead Pilot',
            },
            error: null,
          })
        }),
        upsert: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: '123',
                email: 'operator@dallr.app',
                display_name: 'Operator',
              },
              error: null,
            }),
          }),
        }),
      })),
    },
    isSupabaseConfigured: true,
  }
})

describe('Supabase Authentication Flows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
  })

  it('unauthenticated user sees sign in view with validation checks', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    })

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('Sign In to Dallr Cam')).toBeInTheDocument()
    })

    const user = userEvent.setup()

    // Weak password and invalid email validation
    const submitBtn = screen.getByRole('button', { name: /sign in to dallr cam/i })
    await user.click(submitBtn)

    expect(await screen.findByText('Email address is required')).toBeInTheDocument()
    expect(await screen.findByText('Password is required')).toBeInTheDocument()

    const emailInput = screen.getByPlaceholderText('operator@dallrcam.app')
    const passwordInput = screen.getByPlaceholderText('••••••••')

    await user.type(emailInput, 'invalid-email-format')
    await user.type(passwordInput, '123')
    await user.click(submitBtn)

    expect(await screen.findByText('Please enter a valid email address')).toBeInTheDocument()
    expect(await screen.findByText('Password must be at least 8 characters')).toBeInTheDocument()
  })

  it('handles invalid login credentials failure', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    })

    vi.mocked(supabase.auth.signInWithPassword).mockResolvedValueOnce({
      data: { user: null, session: null },
      error: new Error('Invalid login credentials') as any,
    })

    render(<App />)

    const user = userEvent.setup()
    await waitFor(() => {
      expect(screen.getByText('Sign In to Dallr Cam')).toBeInTheDocument()
    })

    await user.type(screen.getByPlaceholderText('operator@dallrcam.app'), 'test@dallr.app')
    await user.type(screen.getByPlaceholderText('••••••••'), 'Password123!')
    await user.click(screen.getByRole('button', { name: /sign in to dallr cam/i }))

    expect(
      await screen.findByText('Invalid credentials. Please verify your email and password.')
    ).toBeInTheDocument()
  })

  it('successful login restores authenticated state and displays dashboard', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    })

    const mockSession = {
      access_token: 'valid-jwt',
      user: {
        id: 'usr-456',
        email: 'pilot@dallr.app',
        user_metadata: { display_name: 'Lead Pilot' },
      },
    }

    vi.mocked(supabase.auth.signInWithPassword).mockResolvedValueOnce({
      data: { user: mockSession.user as any, session: mockSession as any },
      error: null,
    })

    render(<App />)

    const user = userEvent.setup()
    await waitFor(() => {
      expect(screen.getByText('Sign In to Dallr Cam')).toBeInTheDocument()
    })

    await user.type(screen.getByPlaceholderText('operator@dallrcam.app'), 'pilot@dallr.app')
    await user.type(screen.getByPlaceholderText('••••••••'), 'SecurePassword123!')
    await user.click(screen.getByRole('button', { name: /sign in to dallr cam/i }))

    expect(await screen.findByText('Studio Dashboard')).toBeInTheDocument()
    expect(await screen.findByText('Lead Pilot')).toBeInTheDocument()
  })

  it('restores session automatically when application restarts with existing session', async () => {
    const existingSession = {
      access_token: 'existing-saved-token',
      user: {
        id: 'usr-persisted',
        email: 'returned@dallr.app',
        user_metadata: { display_name: 'Lead Pilot' },
      },
    }

    vi.mocked(supabase.auth.getSession).mockResolvedValueOnce({
      data: { session: existingSession as any },
      error: null,
    })

    render(<App />)

    expect(await screen.findByText('Studio Dashboard')).toBeInTheDocument()
    expect(await screen.findByText('Lead Pilot')).toBeInTheDocument()
  })

  it('allows logging out and returns user to authentication view', async () => {
    const activeSession = {
      access_token: 'logout-token',
      user: {
        id: 'usr-logout',
        email: 'logout@dallr.app',
        user_metadata: { display_name: 'Logout Operator' },
      },
    }

    vi.mocked(supabase.auth.getSession).mockResolvedValueOnce({
      data: { session: activeSession as any },
      error: null,
    })

    vi.mocked(supabase.auth.signOut).mockResolvedValueOnce({ error: null })

    render(<App />)

    expect(await screen.findByText('Studio Dashboard')).toBeInTheDocument()

    const user = userEvent.setup()
    const logoutBtn = screen.getByRole('button', { name: /sign out/i })
    await user.click(logoutBtn)

    expect(await screen.findByText('Sign in to Dallr Cam')).toBeInTheDocument()
  })

  it('handles sign up flow including duplicate email error and email verification notice', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValueOnce({
      data: { session: null },
      error: null,
    })

    render(<App />)

    const user = userEvent.setup()
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /create account/i })).toBeInTheDocument()
    })

    // Switch to SignUp view
    await user.click(screen.getByRole('button', { name: /create account/i }))
    expect(screen.getByText('Create your account')).toBeInTheDocument()

    // Test password matching validation
    await user.type(screen.getByPlaceholderText('Alex Morgan'), 'Jordan Miles')
    await user.type(screen.getByPlaceholderText('operator@dallrcam.app'), 'jordan@dallr.app')
    await user.type(screen.getByPlaceholderText('Minimum 8 characters'), 'Password123!')
    await user.type(screen.getByPlaceholderText('Repeat your password'), 'Mismatch123!')
    await user.click(screen.getByRole('button', { name: /create dallr account/i }))

    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument()

    // Test duplicate email error from Supabase
    vi.mocked(supabase.auth.signUp).mockResolvedValueOnce({
      data: { user: null, session: null },
      error: new Error('User already registered') as any,
    })

    const confirmInput = screen.getByPlaceholderText('Repeat your password')
    await user.clear(confirmInput)
    await user.type(confirmInput, 'Password123!')
    await user.click(screen.getByRole('button', { name: /create dallr account/i }))

    expect(
      await screen.findByText('An account with this email already exists. Please sign in.')
    ).toBeInTheDocument()

    // Test successful sign up with email verification required
    vi.mocked(supabase.auth.signUp).mockResolvedValueOnce({
      data: {
        user: { id: 'usr-new', email: 'jordan@dallr.app' } as any,
        session: null,
      },
      error: null,
    })

    await user.click(screen.getByRole('button', { name: /create dallr account/i }))
    expect(await screen.findByText('Check your email')).toBeInTheDocument()
  })
})
