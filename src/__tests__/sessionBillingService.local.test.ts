import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sessionBillingService } from '@/services/sessionBillingService'
import { supabase } from '@/lib/supabase'

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: { getSession: vi.fn() },
    from: vi.fn(),
    functions: { invoke: vi.fn() },
  },
}))

/** Mock supabase.from() chained calls for wallet reads */
function mockWalletRead(balance: number, error: unknown = null) {
  const mockSingle = vi.fn().mockResolvedValue({ data: { balance }, error })
  const mockEq = vi.fn().mockReturnValue({ single: mockSingle })
  const mockSelect = vi.fn().mockReturnValue({ eq: mockEq })
  vi.mocked(supabase.from).mockReturnValue({ select: mockSelect })
}

/** Mock supabase.auth.getSession */
function mockAuthSession(token: string | null, userId: string = 'user-1', error: unknown = null) {
  vi.mocked(supabase.auth.getSession).mockResolvedValue({
    data: {
      session: token
        ? ({
            access_token: token,
            user: { id: userId },
          } as any)
        : null,
    },
    error: error as any,
  })
}

describe('SessionBillingService — local billing (personal app)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionBillingService.removeListeners()
  })

  afterEach(async () => {
    await sessionBillingService.endSession()
    vi.useRealTimers()
  })

  it('successfully initializes a billing session with sufficient wallet balance', async () => {
    mockAuthSession('valid_jwt_token')
    mockWalletRead(1500) // $15.00

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        session_id: 'sess-local-1',
        current_balance_cents: 1500,
      },
      error: null,
    })

    const result = await sessionBillingService.startSession('decart-local-1')

    expect(result.sessionId).toBe('sess-local-1')
    expect(result.currentBalanceCents).toBe(1500)
    expect(sessionBillingService.getState().isActive).toBe(true)
    expect(sessionBillingService.getState().sessionId).toBe('sess-local-1')
    expect(sessionBillingService.getState().billingState).toBe('idle')
  })

  it('rejects when wallet is missing', async () => {
    mockAuthSession('valid_jwt_token')
    mockWalletRead(0, new Error('Wallet not found'))

    await expect(sessionBillingService.startSession()).rejects.toThrow(
      'Wallet not found',
    )
    expect(sessionBillingService.getState().isActive).toBe(false)
    expect(sessionBillingService.getState().sessionId).toBeNull()
  })

  it('rejects when balance is insufficient to start', async () => {
    mockAuthSession('valid_jwt_token')
    mockWalletRead(0) // $0.00 — below 4 cent minimum

    await expect(sessionBillingService.startSession()).rejects.toThrow(
      'Insufficient balance',
    )
    expect(sessionBillingService.getState().isActive).toBe(false)
  })

  it('rejects when user is not authenticated', async () => {
    mockAuthSession(null)

    await expect(sessionBillingService.startSession()).rejects.toThrow(
      'Authentication required',
    )
    expect(sessionBillingService.getState().isActive).toBe(false)
    expect(sessionBillingService.getState().isStarting).toBe(false)
  })

  it('rejects on RPC failure at session start but allows retry', async () => {
    mockAuthSession('valid_jwt_token')
    mockWalletRead(1500)

    // First call fails
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: null,
      error: new Error('RPC failure contacting database'),
    })

    await expect(sessionBillingService.startSession()).rejects.toThrow(
      'RPC failure',
    )
    expect(sessionBillingService.getState().isActive).toBe(false)
    expect(sessionBillingService.getState().isStarting).toBe(false)

    // Retry succeeds
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        session_id: 'sess-retry',
        current_balance_cents: 3000,
      },
      error: null,
    })

    const retry = await sessionBillingService.startSession('decart-retry')
    expect(retry.sessionId).toBe('sess-retry')
    expect(sessionBillingService.getState().isActive).toBe(true)
  })

  it('activates billing explicitly via resumeBilling', async () => {
    mockAuthSession('valid_jwt_token')
    mockWalletRead(2000)

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        session_id: 'sess-billing',
        current_balance_cents: 2000,
      },
      error: null,
    })

    await sessionBillingService.startSession('decart-billing')
    expect(sessionBillingService.getState().billingState).toBe('idle')

    // resumeBilling is now local-only (no Edge Function call)
    await sessionBillingService.resumeBilling()
    expect(sessionBillingService.getState().billingState).toBe('billable')
  })

  it('deducts credits locally during billing and terminates on exhaustion', async () => {
    mockAuthSession('valid_jwt_token')
    mockWalletRead(12) // $0.12 — exactly 3 seconds at 4 cents/sec

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        session_id: 'sess-exhaust',
        current_balance_cents: 12,
      },
      error: null,
    })

    const terminatedSpy = vi.fn()
    sessionBillingService.setListeners({
      onInsufficientFundsTerminated: terminatedSpy,
    })

    await sessionBillingService.startSession('decart-exhaust')
    await sessionBillingService.resumeBilling() // make billable so deduction runs

    // Manually trigger local deduction: advance time by 4 seconds
    // (12 cents / 4 cents per sec = 3 seconds, so 4 seconds exhausts it)
    sessionBillingService['lastDeductionAt'] = Date.now() - 4000
    await sessionBillingService.sendHeartbeat()

    expect(sessionBillingService.getState().exhausted).toBe(true)
    expect(sessionBillingService.getState().isActive).toBe(false)
    expect(terminatedSpy).toHaveBeenCalled()
  })

  it('does not deduct credits when billing state is paused', async () => {
    mockAuthSession('valid_jwt_token')
    mockWalletRead(1000)

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        session_id: 'sess-paused',
        current_balance_cents: 1000,
      },
      error: null,
    })

    await sessionBillingService.startSession('decart-paused')
    await sessionBillingService.pauseBilling()

    sessionBillingService['lastDeductionAt'] = Date.now() - 10000
    await sessionBillingService.sendHeartbeat()

    // No deduction while paused
    expect(sessionBillingService.getState().billedCents).toBe(0)
    expect(sessionBillingService.getState().currentBalanceCents).toBe(1000)
  })

  it('syncs final state to cloud once at end of session', async () => {
    mockAuthSession('valid_jwt_token')
    mockWalletRead(1500)

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        session_id: 'sess-sync',
        current_balance_cents: 1500,
      },
      error: null,
    })

    await sessionBillingService.startSession('decart-sync')
    sessionBillingService.onGenerationTick(10) // 10 seconds = 40 cents

    // session-end is called once at end (not during session)
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: { success: true },
      error: null,
    })

    const result = await sessionBillingService.endSession()

    expect(result.totalSeconds).toBe(10)
    expect(result.totalBilledUSD).toBe(0.4)
    expect(sessionBillingService.getState().isActive).toBe(false)
    expect(sessionBillingService.getState().sessionId).toBeNull()
  })
})
