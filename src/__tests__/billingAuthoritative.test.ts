import { describe, it, expect, vi, beforeEach } from 'vitest'
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

describe('Authoritative Session Billing & Failure Teardown', () => {
  beforeEach(async () => {
    await sessionBillingService.endSession()
    vi.clearAllMocks()
    vi.useFakeTimers()
    sessionBillingService.removeListeners()
  })

  it('automatically terminates session when 3 consecutive heartbeats fail', async () => {
    let terminatedData: { seconds: number; billedUSD: number } | null = null

    sessionBillingService.setListeners({
      onInsufficientFundsTerminated: (seconds, billedUSD) => {
        terminatedData = { seconds, billedUSD }
      },
    })

    // Setup active session
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: {
        session: {
          access_token: 'valid-jwt-token',
          user: { id: 'test-user-uuid' },
        } as any,
      },
      error: null,
    })

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-12345',
        status: 'active',
        current_balance_cents: 500, // $5.00
      },
      error: null,
    })

    await sessionBillingService.startSession()
    expect(sessionBillingService.getState().isActive).toBe(true)

    // Tick 10 seconds locally
    sessionBillingService.onGenerationTick(10)
    expect(sessionBillingService.getState().cumulativeSeconds).toBe(10)

    // Heartbeat fails 3 times
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: new Error('Network timeout contacting heartbeat endpoint'),
    })

    // Heartbeat 1 (failure 1)
    await sessionBillingService.sendHeartbeat()
    expect(sessionBillingService.getState().isActive).toBe(true)
    expect(terminatedData).toBeNull()

    // Heartbeat 2 (failure 2)
    await sessionBillingService.sendHeartbeat()
    expect(sessionBillingService.getState().isActive).toBe(true)
    expect(terminatedData).toBeNull()

    // Heartbeat 3 (failure 3 => threshold reached)
    await sessionBillingService.sendHeartbeat()
    expect(sessionBillingService.getState().isActive).toBe(false)
    expect(sessionBillingService.getState().exhausted).toBe(true)
    expect(terminatedData).toEqual({
      seconds: 10,
      billedUSD: 0.4,
    })
  })

  it('triggers low balance warning at <= 30s remaining and critical at <= 10s', async () => {
    let lowWarning = false
    let critWarning = false

    sessionBillingService.setListeners({
      onLowBalanceWarning: () => {
        lowWarning = true
      },
      onCriticalBalanceWarning: () => {
        critWarning = true
      },
    })

    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: {
        session: {
          access_token: 'valid-jwt-token',
          user: { id: 'test-user-uuid' },
        } as any,
      },
      error: null,
    })

    // Start with 110 cents ($1.10 = 27 seconds, < 30s)
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-warning-test',
        status: 'active',
        current_balance_cents: 110,
      },
      error: null,
    })

    await sessionBillingService.startSession()
    expect(lowWarning).toBe(true)
    expect(critWarning).toBe(false)

    // Heartbeat returns 35 cents (< 10 seconds)
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-warning-test',
        status: 'active',
        billed_cents: 40,
        new_balance_cents: 35,
        stop_requested: false,
      },
      error: null,
    })

    await sessionBillingService.sendHeartbeat()
    expect(critWarning).toBe(true)
  })

  it('ensures client heartbeat sends session_id without client-supplied seconds', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: {
        session: {
          access_token: 'valid-jwt-token',
          user: { id: 'test-user-uuid' },
        } as any,
      },
      error: null,
    })

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-authoritative-1',
        status: 'active',
        current_balance_cents: 2000,
      },
      error: null,
    })

    await sessionBillingService.startSession()

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-authoritative-1',
        status: 'active',
        cumulative_seconds: 5,
        billed_cents: 20,
        new_balance_cents: 1980,
        stop_requested: false,
      },
      error: null,
    })

    await sessionBillingService.sendHeartbeat()

    // Assert that invocation payload did NOT include cumulative_seconds
    expect(supabase.functions.invoke).toHaveBeenLastCalledWith('session-heartbeat', {
      headers: { Authorization: 'Bearer valid-jwt-token' },
      body: {
        action: 'heartbeat',
        session_id: 'session-authoritative-1',
      },
    })

    expect(sessionBillingService.getState().cumulativeSeconds).toBe(5)
    expect(sessionBillingService.getState().billedCents).toBe(20)
    expect(sessionBillingService.getState().currentBalanceCents).toBe(1980)
  })
})
