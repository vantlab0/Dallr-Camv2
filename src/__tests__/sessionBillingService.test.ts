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

describe('sessionBillingService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    sessionBillingService.removeListeners()
  })

  afterEach(async () => {
    await sessionBillingService.endSession()
    vi.useRealTimers()
  })

  it('initializes with default idle state', () => {
    const state = sessionBillingService.getState()
    expect(state.isActive).toBe(false)
    expect(state.isStarting).toBe(false)
    expect(state.sessionId).toBeNull()
    expect(state.cumulativeSeconds).toBe(0)
    expect(state.billedCents).toBe(0)
    expect(state.billedUSD).toBe(0)
  })

  it('starts session successfully and begins heartbeat loop', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: {
        session: {
          access_token: 'valid_jwt_token',
        } as any,
      },
      error: null,
    })

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-1234',
        status: 'active',
        started_at: '2025-01-01T00:00:00Z',
        current_balance_cents: 1500, // $15.00
      },
      error: null,
    })

    const result = await sessionBillingService.startSession('decart-xyz')
    expect(result.sessionId).toBe('session-1234')
    expect(result.currentBalanceCents).toBe(1500)

    const state = sessionBillingService.getState()
    expect(state.isActive).toBe(true)
    expect(state.sessionId).toBe('session-1234')
    expect(state.currentBalanceUSD).toBe(15.0)

    // Verify invoke was called with start action
    expect(supabase.functions.invoke).toHaveBeenCalledWith('session-heartbeat', {
      headers: { Authorization: 'Bearer valid_jwt_token' },
      body: { action: 'start', decart_session_id: 'decart-xyz' },
    })
  })

  it('tracks cumulative generation ticks monotonically', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { access_token: 'token' } as any },
      error: null,
    })
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-abc',
        status: 'active',
        current_balance_cents: 2000,
      },
      error: null,
    })

    await sessionBillingService.startSession()

    // 10 seconds tick: 10 * 4 = 40 cents = $0.40 USD
    sessionBillingService.onGenerationTick(10)
    expect(sessionBillingService.getState().cumulativeSeconds).toBe(10)
    expect(sessionBillingService.getState().billedCents).toBe(40)
    expect(sessionBillingService.getState().billedUSD).toBe(0.4)

    // Ensure non-decreasing: smaller ticks ignored
    sessionBillingService.onGenerationTick(8)
    expect(sessionBillingService.getState().cumulativeSeconds).toBe(10)

    // Advance to 60 seconds: 60 * 4 = 240 cents = $2.40 USD
    sessionBillingService.onGenerationTick(60)
    expect(sessionBillingService.getState().cumulativeSeconds).toBe(60)
    expect(sessionBillingService.getState().billedCents).toBe(240)
    expect(sessionBillingService.getState().billedUSD).toBe(2.4)
  })

  it('triggers low-balance and critical-balance warnings as balance depletes', async () => {
    const lowWarningSpy = vi.fn()
    const criticalWarningSpy = vi.fn()

    sessionBillingService.setListeners({
      onLowBalanceWarning: lowWarningSpy,
      onCriticalBalanceWarning: criticalWarningSpy,
    })

    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { access_token: 'token' } as any },
      error: null,
    })

    // Start with 100 cents ($1.00 USD = 25 seconds of streaming at 4 cents/sec -> <= 30 seconds threshold)
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-low',
        status: 'active',
        current_balance_cents: 100, // 25 seconds left
      },
      error: null,
    })

    await sessionBillingService.startSession()
    expect(lowWarningSpy).toHaveBeenCalledWith(25, 1.0)

    // Critical balance check (< 10 seconds = < 40 cents)
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-low',
        status: 'active',
        new_balance_cents: 24, // 6 seconds left
        stop_requested: false,
      },
      error: null,
    })

    await sessionBillingService.sendHeartbeat()
    expect(criticalWarningSpy).toHaveBeenCalledWith(6, 0.24)
  })

  it('handles backend stop_requested on insufficient funds and fires termination callback', async () => {
    const terminatedSpy = vi.fn()
    sessionBillingService.setListeners({
      onInsufficientFundsTerminated: terminatedSpy,
    })

    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { access_token: 'token' } as any },
      error: null,
    })

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-stop',
        status: 'active',
        current_balance_cents: 12,
      },
      error: null,
    })

    await sessionBillingService.startSession()
    sessionBillingService.onGenerationTick(3)

    // Simulate backend reporting funds exhausted
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-stop',
        status: 'terminated_insufficient_funds',
        cumulative_seconds: 3,
        billed_cents: 12,
        new_balance_cents: 0,
        stop_requested: true,
        reason: 'Session terminated due to insufficient balance',
      },
      error: null,
    })

    await sessionBillingService.sendHeartbeat()

    expect(terminatedSpy).toHaveBeenCalledWith(3, 0.12)
    expect(sessionBillingService.getState().exhausted).toBe(true)
    expect(sessionBillingService.getState().isActive).toBe(false)
  })

  it('ends session and reconciles final cumulative seconds with backend without sending client seconds', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: { session: { access_token: 'token' } as any },
      error: null,
    })

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-final',
        status: 'active',
        current_balance_cents: 1500,
      },
      error: null,
    })

    await sessionBillingService.startSession()
    sessionBillingService.onGenerationTick(120) // 120s = $4.80

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-final',
        status: 'completed',
        total_seconds: 120,
        total_billed_cents: 480, // $4.80
        final_balance_cents: 1020, // $10.20
      },
      error: null,
    })

    const finalResult = await sessionBillingService.endSession()
    expect(finalResult.totalSeconds).toBe(120)
    expect(finalResult.totalBilledUSD).toBe(4.8)
    expect(finalResult.finalBalanceUSD).toBe(10.2)

    expect(supabase.functions.invoke).toHaveBeenCalledWith('session-end', {
      headers: { Authorization: 'Bearer token' },
      body: { session_id: 'session-final' },
    })

    expect(sessionBillingService.getState().isActive).toBe(false)
    expect(sessionBillingService.getState().sessionId).toBeNull()
  })
})
