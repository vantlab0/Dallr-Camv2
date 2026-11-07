import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sessionBillingService } from '@/services/sessionBillingService'
import { supabase } from '@/lib/supabase'

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn() },
    functions: { invoke: vi.fn() },
  },
}))

/** Mock a successful Edge Function response. */
function mockInvoke(result: unknown) {
  vi.mocked(supabase.functions.invoke).mockResolvedValue(result as any)
}

/**
 * Mock a failing Edge Function by returning a FunctionsHttpError-shaped object
 * whose `context` is a real Response carrying the HTTP status and body.
 */
function mockInvokeError(status: number, body: unknown) {
  const statusText = status === 404 ? 'Not Found' : status === 402 ? 'Payment Required' : 'Error'
  const context = new Response(JSON.stringify(body), { status, statusText })
  const error = {
    name: 'FunctionsHttpError',
    message: 'Edge Function returned a non-2xx status code',
    context,
  }
  vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: null, error } as any)
}

describe('Live-stream billing initialization chain (session-heartbeat -> start_live_session)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionBillingService.removeListeners()
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { access_token: 'valid_jwt_token', user: { id: 'user-1' } } as any },
      error: null,
    })
  })

  afterEach(async () => {
    await sessionBillingService.endSession()
    vi.useRealTimers()
  })

  it('successfully initializes a billing session via session-heartbeat action: start', async () => {
    mockInvoke({
      data: {
        success: true,
        session_id: 'sess-1',
        status: 'active',
        billing_state: 'idle',
        started_at: '2025-01-01T00:00:00Z',
        current_balance_cents: 1500,
      },
      error: null,
    })

    const result = await sessionBillingService.startSession('decart-sess-1')

    expect(result.sessionId).toBe('sess-1')
    expect(result.currentBalanceCents).toBe(1500)
    expect(sessionBillingService.getState().isActive).toBe(true)
    expect(sessionBillingService.getState().sessionId).toBe('sess-1')
    expect(sessionBillingService.getState().billingState).toBe('idle')
    expect(supabase.functions.invoke).toHaveBeenCalledWith('session-heartbeat', {
      headers: { Authorization: 'Bearer valid_jwt_token' },
      body: { action: 'start', decart_session_id: 'decart-sess-1' },
    })
  })

  it('rejects with the real server error when the wallet is missing (404)', async () => {
    mockInvokeError(404, { error: 'Wallet not found for user user-1' })

    await expect(sessionBillingService.startSession()).rejects.toThrow('Wallet not found')
    expect(sessionBillingService.getState().isActive).toBe(false)
    expect(sessionBillingService.getState().sessionId).toBeNull()
  })

  it('rejects with the real server error when the balance is insufficient (402)', async () => {
    mockInvokeError(402, {
      error: 'Insufficient balance to start live stream. Current balance: 0 cents',
    })

    await expect(sessionBillingService.startSession()).rejects.toThrow('Insufficient balance')
    expect(sessionBillingService.getState().isActive).toBe(false)
    expect(sessionBillingService.getState().sessionId).toBeNull()
  })

  it('rejects when the user is not authenticated', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: null },
      error: null,
    })

    await expect(sessionBillingService.startSession()).rejects.toThrow(
      'Authentication required to start billing session.'
    )
    expect(sessionBillingService.getState().isActive).toBe(false)
    expect(sessionBillingService.getState().isStarting).toBe(false)
  })

  it('rejects on RPC failure and releases in-flight state so a retry is possible', async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: new Error('RPC failure contacting database'),
    })

    await expect(sessionBillingService.startSession()).rejects.toThrow('RPC failure')
    expect(sessionBillingService.getState().isActive).toBe(false)
    expect(sessionBillingService.getState().isStarting).toBe(false)

    // Retry after failure should work cleanly.
    mockInvoke({
      data: {
        success: true,
        session_id: 'sess-retry',
        status: 'active',
        current_balance_cents: 3000,
      },
      error: null,
    })
    const retry = await sessionBillingService.startSession('decart-retry')
    expect(retry.sessionId).toBe('sess-retry')
    expect(sessionBillingService.getState().isActive).toBe(true)
  })

  it('activates billing explicitly via resumeBilling (session-heartbeat action: billing_state)', async () => {
    mockInvoke({
      data: {
        success: true,
        session_id: 'sess-2',
        status: 'active',
        current_balance_cents: 2000,
      },
      error: null,
    })
    await sessionBillingService.startSession('decart-sess-2')
    expect(sessionBillingService.getState().billingState).toBe('idle')

    mockInvoke({
      data: {
        success: true,
        session_id: 'sess-2',
        billing_state: 'billable',
        status: 'active',
        cumulative_seconds: 0,
        billed_cents: 0,
        new_balance_cents: 2000,
        changed: true,
      },
      error: null,
    })
    await sessionBillingService.resumeBilling()

    expect(sessionBillingService.getState().billingState).toBe('billable')
    expect(supabase.functions.invoke).toHaveBeenLastCalledWith('session-heartbeat', {
      headers: { Authorization: 'Bearer valid_jwt_token' },
      body: { action: 'billing_state', session_id: 'sess-2', billing_state: 'billable' },
    })
  })
})
