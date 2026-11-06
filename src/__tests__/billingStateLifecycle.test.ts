import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sessionBillingService } from '@/services/sessionBillingService'
import { supabase } from '@/lib/supabase'

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
    },
    functions: {
      invoke: vi.fn(),
    },
  },
}))

describe('Explicit server-authoritative billing state', () => {
  beforeEach(async () => {
    await sessionBillingService.endSession()
    vi.clearAllMocks()
    sessionBillingService.removeListeners()

    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: {
        session: { access_token: 'valid-jwt-token' } as any,
      },
      error: null,
    })

    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: { success: true },
      error: null,
    })
  })

  afterEach(async () => {
    await sessionBillingService.endSession()
  })

  async function startActiveSession() {
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-billing-state',
        status: 'active',
        billing_state: 'idle',
        current_balance_cents: 2000,
      },
      error: null,
    })

    await sessionBillingService.startSession('decart-billing-state')
    expect(sessionBillingService.getState().isActive).toBe(true)
    expect(sessionBillingService.getState().billingState).toBe('idle')
  }

  it('does not start billing merely because a session was created', async () => {
    await startActiveSession()

    const startCalls = vi
      .mocked(supabase.functions.invoke)
      .mock.calls.filter((call) => (call[1]?.body as Record<string, unknown>)?.action === 'start')

    expect(startCalls).toHaveLength(1)
    expect(sessionBillingService.getState().billingState).toBe('idle')
  })

  it('resumes billing explicitly and sends only the server-authoritative transition', async () => {
    await startActiveSession()

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-billing-state',
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
      headers: { Authorization: 'Bearer valid-jwt-token' },
      body: {
        action: 'billing_state',
        session_id: 'session-billing-state',
        billing_state: 'billable',
      },
    })
  })

  it('pauses billing when the stream reconnects or drops', async () => {
    await startActiveSession()
    sessionBillingService['billingState'] = 'billable'

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-billing-state',
        billing_state: 'paused',
        status: 'active',
        cumulative_seconds: 12,
        billed_cents: 48,
        new_balance_cents: 1952,
        changed: true,
      },
      error: null,
    })

    await sessionBillingService.pauseBilling()

    expect(sessionBillingService.getState().billingState).toBe('paused')
    expect(supabase.functions.invoke).toHaveBeenLastCalledWith('session-heartbeat', {
      headers: { Authorization: 'Bearer valid-jwt-token' },
      body: {
        action: 'billing_state',
        session_id: 'session-billing-state',
        billing_state: 'paused',
      },
    })
    expect(sessionBillingService.getState().billedCents).toBe(48)
  })

  it('does not send duplicate transition requests when already paused', async () => {
    await startActiveSession()
    sessionBillingService['billingState'] = 'paused'

    await sessionBillingService.pauseBilling()

    const transitionCalls = vi
      .mocked(supabase.functions.invoke)
      .mock.calls.filter((call) => (call[1]?.body as Record<string, unknown>)?.action === 'billing_state')

    expect(transitionCalls).toHaveLength(0)
  })

  it('keeps sending keepalive heartbeats while paused without resuming billing', async () => {
    await startActiveSession()
    sessionBillingService['billingState'] = 'paused'

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-billing-state',
        status: 'active',
        billing_state: 'paused',
        cumulative_seconds: 30,
        billed_cents: 120,
        new_balance_cents: 1880,
        stop_requested: false,
      },
      error: null,
    })

    await sessionBillingService.sendHeartbeat()

    expect(supabase.functions.invoke).toHaveBeenLastCalledWith('session-heartbeat', {
      headers: { Authorization: 'Bearer valid-jwt-token' },
      body: {
        action: 'heartbeat',
        session_id: 'session-billing-state',
      },
    })
    expect(sessionBillingService.getState().billingState).toBe('paused')
    expect(sessionBillingService.getState().billedCents).toBe(120)
  })

  it('does not terminate a paused session just because the balance is below one second', async () => {
    await startActiveSession()
    sessionBillingService['billingState'] = 'paused'

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-billing-state',
        status: 'active',
        billing_state: 'paused',
        cumulative_seconds: 100,
        billed_cents: 400,
        new_balance_cents: 3,
        stop_requested: true,
        reason: 'Balance exhausted',
      },
      error: null,
    })

    await sessionBillingService.sendHeartbeat()

    expect(sessionBillingService.getState().isActive).toBe(true)
    expect(sessionBillingService.getState().billingState).toBe('paused')
  })
})
