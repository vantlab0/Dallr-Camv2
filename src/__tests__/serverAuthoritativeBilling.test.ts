import { describe, it, expect, beforeEach } from 'vitest'

/**
 * Server-Authoritative Billing Specification Tests
 *
 * Simulates the exact PostgreSQL database semantics defined in
 * supabase/migrations/20240105000000_server_authoritative_billing.sql:
 *
 * 1. start_live_session:
 *    - Prevents multiple concurrent active sessions for the same user.
 *    - Replaces abandoned session if older than 45s.
 *    - Requires minimum 4 cents ($0.04 USD) balance.
 *    - Initializes last_billed_at = started_at.
 * 2. heartbeat_and_meter_session:
 *    - Derives billable delta strictly from server elapsed time: floor(now - last_billed_at).
 *    - Enforces lease policy: caps delta to 15 seconds per interval to protect disconnected users.
 *    - Client cannot manipulate duration (client-reported seconds ignored).
 *    - Zero-interval / duplicate heartbeats bill 0 cents idempotently.
 *    - Prevents negative balances: if wallet < delta * 4 cents, bills only whole affordable seconds,
 *      sets status to 'terminated_insufficient_funds', and returns stop_requested: true.
 *    - Row locking semantics prevents race conditions and concurrent double-billing.
 * 3. end_live_session:
 *    - Performs final billing based on server elapsed time up to termination (capped by lease).
 *    - Idempotent: duplicate calls do not bill twice or change finalized state.
 *    - No charging after session termination.
 */

interface MockWallet {
  id: string
  user_id: string
  balance: number // cents
}

interface MockSession {
  id: string
  user_id: string
  status: 'active' | 'completed' | 'terminated_insufficient_funds' | 'abandoned'
  started_at: number // unix epoch ms
  last_heartbeat_at: number
  last_billed_at: number
  ended_at: number | null
  duration_seconds: number
  billed_amount: number // cents
}

interface MockTransaction {
  id: string
  wallet_id: string
  user_id: string
  amount: number
  reference: string
  description: string
  created_at: number
}

class AuthoritativeBillingEngine {
  public wallets: Map<string, MockWallet> = new Map()
  public sessions: Map<string, MockSession> = new Map()
  public transactions: MockTransaction[] = []

  public readonly RATE_CENTS_PER_SEC = 4
  public readonly MAX_LEASE_SECONDS = 15
  public readonly STALE_DISCONNECT_SECONDS = 45

  public createWallet(userId: string, initialBalanceCents: number): MockWallet {
    const wallet: MockWallet = {
      id: `wallet-${userId}`,
      user_id: userId,
      balance: initialBalanceCents,
    }
    this.wallets.set(userId, wallet)
    return wallet
  }

  public startLiveSession(userId: string, currentTime: number): {
    sessionId: string
    userId: string
    status: string
    startedAt: number
    currentBalance: number
  } {
    const wallet = this.wallets.get(userId)
    if (!wallet) {
      throw new Error(`Wallet not found for user ${userId}`)
    }

    // Check for existing active session
    for (const session of this.sessions.values()) {
      if (session.user_id === userId && session.status === 'active') {
        const timeSinceHb = (currentTime - session.last_heartbeat_at) / 1000
        if (timeSinceHb >= this.STALE_DISCONNECT_SECONDS) {
          session.status = 'abandoned'
          session.ended_at = session.last_heartbeat_at
        } else {
          throw new Error(`A live session (${session.id}) is already active for user ${userId}`)
        }
      }
    }

    if (wallet.balance < this.RATE_CENTS_PER_SEC) {
      throw new Error(`Insufficient balance to start live stream. Current balance: ${wallet.balance} cents`)
    }

    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    const session: MockSession = {
      id: sessionId,
      user_id: userId,
      status: 'active',
      started_at: currentTime,
      last_heartbeat_at: currentTime,
      last_billed_at: currentTime,
      ended_at: null,
      duration_seconds: 0,
      billed_amount: 0,
    }

    this.sessions.set(sessionId, session)

    return {
      sessionId,
      userId,
      status: 'active',
      startedAt: currentTime,
      currentBalance: wallet.balance,
    }
  }

  public heartbeatAndMeterSession(
    sessionId: string,
    userId: string,
    currentTime: number,
    _clientSuppliedSeconds?: number // Demonstrates client duration is completely ignored
  ): {
    sessionId: string
    status: string
    cumulativeSeconds: number
    billedCents: number
    newBalance: number
    stopRequested: boolean
    reason: string
  } {
    const session = this.sessions.get(sessionId)
    if (!session || session.user_id !== userId) {
      throw new Error(`Live session ${sessionId} not found for user ${userId}`)
    }

    const wallet = this.wallets.get(userId)
    if (!wallet) {
      throw new Error(`Wallet not found for user ${userId}`)
    }

    // If session is already completed or terminated, return without charging further
    if (session.status !== 'active') {
      return {
        sessionId: session.id,
        status: session.status,
        cumulativeSeconds: session.duration_seconds,
        billedCents: session.billed_amount,
        newBalance: wallet.balance,
        stopRequested: true,
        reason: `Session already ${session.status}`,
      }
    }

    // Server-authoritative elapsed calculation
    const rawElapsedSeconds = Math.floor((currentTime - session.last_billed_at) / 1000)

    if (rawElapsedSeconds <= 0) {
      session.last_heartbeat_at = currentTime
      return {
        sessionId: session.id,
        status: session.status,
        cumulativeSeconds: session.duration_seconds,
        billedCents: session.billed_amount,
        newBalance: wallet.balance,
        stopRequested: wallet.balance < this.RATE_CENTS_PER_SEC,
        reason: wallet.balance < this.RATE_CENTS_PER_SEC ? 'Balance exhausted' : 'Heartbeat acknowledged',
      }
    }

    // Apply lease timeout policy
    const billableDeltaSeconds = Math.min(rawElapsedSeconds, this.MAX_LEASE_SECONDS)
    const debitAmountCents = billableDeltaSeconds * this.RATE_CENTS_PER_SEC

    if (wallet.balance >= debitAmountCents) {
      wallet.balance -= debitAmountCents
      this.transactions.push({
        id: `tx-${Date.now()}-${this.transactions.length}`,
        wallet_id: wallet.id,
        user_id: userId,
        amount: -debitAmountCents,
        reference: `meter_${session.id}_${session.duration_seconds + billableDeltaSeconds}`,
        description: `Live Video Usage (${billableDeltaSeconds}s @ $0.04/s)`,
        created_at: currentTime,
      })

      session.duration_seconds += billableDeltaSeconds
      session.billed_amount += debitAmountCents
      session.last_billed_at += billableDeltaSeconds * 1000
      session.last_heartbeat_at = currentTime

      return {
        sessionId: session.id,
        status: 'active',
        cumulativeSeconds: session.duration_seconds,
        billedCents: session.billed_amount,
        newBalance: wallet.balance,
        stopRequested: wallet.balance < this.RATE_CENTS_PER_SEC,
        reason: wallet.balance < this.RATE_CENTS_PER_SEC ? 'Balance exhausted after metering' : 'OK',
      }
    } else {
      // Insufficient funds: bill only what can be afforded in whole seconds
      const affordableSeconds = Math.floor(wallet.balance / this.RATE_CENTS_PER_SEC)
      const affordableDebitCents = affordableSeconds * this.RATE_CENTS_PER_SEC

      if (affordableDebitCents > 0) {
        wallet.balance -= affordableDebitCents
        this.transactions.push({
          id: `tx-${Date.now()}-${this.transactions.length}`,
          wallet_id: wallet.id,
          user_id: userId,
          amount: -affordableDebitCents,
          reference: `meter_final_${session.id}`,
          description: `Live Video Final Usage (${affordableSeconds}s @ $0.04/s)`,
          created_at: currentTime,
        })
      }

      session.duration_seconds += affordableSeconds
      session.billed_amount += affordableDebitCents
      session.last_billed_at += affordableSeconds * 1000
      session.status = 'terminated_insufficient_funds'
      session.ended_at = currentTime
      session.last_heartbeat_at = currentTime

      return {
        sessionId: session.id,
        status: 'terminated_insufficient_funds',
        cumulativeSeconds: session.duration_seconds,
        billedCents: session.billed_amount,
        newBalance: wallet.balance,
        stopRequested: true,
        reason: 'Session terminated due to insufficient balance',
      }
    }
  }

  public endLiveSession(
    sessionId: string,
    userId: string,
    currentTime: number
  ): {
    sessionId: string
    status: string
    totalSeconds: number
    totalBilledCents: number
    finalBalance: number
  } {
    const session = this.sessions.get(sessionId)
    if (!session || session.user_id !== userId) {
      throw new Error(`Live session ${sessionId} not found for user ${userId}`)
    }

    const wallet = this.wallets.get(userId)
    if (!wallet) {
      throw new Error(`Wallet not found for user ${userId}`)
    }

    // Idempotent: already ended or terminated
    if (session.status !== 'active') {
      return {
        sessionId: session.id,
        status: session.status,
        totalSeconds: session.duration_seconds,
        totalBilledCents: session.billed_amount,
        finalBalance: wallet.balance,
      }
    }

    // Meter final elapsed interval
    this.heartbeatAndMeterSession(sessionId, userId, currentTime)

    if (session.status === 'active') {
      session.status = 'completed'
      session.ended_at = currentTime
    }

    return {
      sessionId: session.id,
      status: session.status,
      totalSeconds: session.duration_seconds,
      totalBilledCents: session.billed_amount,
      finalBalance: wallet.balance,
    }
  }
}

describe('Server-Authoritative Metering Specification Tests', () => {
  let engine: AuthoritativeBillingEngine
  const USER_ID = 'test-user-uuid-1'

  beforeEach(() => {
    engine = new AuthoritativeBillingEngine()
  })

  it('normal 60-second session billed at 12 heartbeats of 5s each ($2.40 USD)', () => {
    // 60 seconds * 4 cents = 240 cents = $2.40 USD
    engine.createWallet(USER_ID, 1000) // $10.00
    let now = 1_000_000

    const { sessionId } = engine.startLiveSession(USER_ID, now)

    // 12 heartbeats every 5 seconds (5s * 12 = 60s)
    for (let i = 1; i <= 12; i++) {
      now += 5_000
      const res = engine.heartbeatAndMeterSession(sessionId, USER_ID, now)
      expect(res.status).toBe('active')
      expect(res.cumulativeSeconds).toBe(i * 5)
      expect(res.billedCents).toBe(i * 20)
      expect(res.newBalance).toBe(1000 - i * 20)
    }

    // End session with 0 remaining seconds
    const endRes = engine.endLiveSession(sessionId, USER_ID, now)
    expect(endRes.status).toBe('completed')
    expect(endRes.totalSeconds).toBe(60)
    expect(endRes.totalBilledCents).toBe(240) // $2.40
    expect(endRes.finalBalance).toBe(760) // $7.60

    expect(engine.wallets.get(USER_ID)!.balance).toBe(760)
    expect(engine.transactions).toHaveLength(12)
  })

  it('normal 10-minute session billed accurately (600s * $0.04 = $24.00 USD)', () => {
    // 600s * 4 cents = 2400 cents ($24.00)
    engine.createWallet(USER_ID, 5000) // $50.00
    let now = 1_000_000

    const { sessionId } = engine.startLiveSession(USER_ID, now)

    // 120 heartbeats every 5s = 600s
    for (let i = 1; i <= 120; i++) {
      now += 5_000
      engine.heartbeatAndMeterSession(sessionId, USER_ID, now)
    }

    const endRes = engine.endLiveSession(sessionId, USER_ID, now)
    expect(endRes.totalSeconds).toBe(600)
    expect(endRes.totalBilledCents).toBe(2400)
    expect(endRes.finalBalance).toBe(2600) // $26.00 remaining
  })

  it('client reports zero seconds while time passes: server clock still bills correctly', () => {
    engine.createWallet(USER_ID, 1000)
    let now = 1_000_000

    const { sessionId } = engine.startLiveSession(USER_ID, now)

    // Attacker client sends cumulative_seconds: 0
    now += 5_000
    const res1 = engine.heartbeatAndMeterSession(sessionId, USER_ID, now, 0)
    expect(res1.cumulativeSeconds).toBe(5)
    expect(res1.billedCents).toBe(20)

    now += 5_000
    const res2 = engine.heartbeatAndMeterSession(sessionId, USER_ID, now, 0)
    expect(res2.cumulativeSeconds).toBe(10)
    expect(res2.billedCents).toBe(40)
    expect(res2.newBalance).toBe(960)
  })

  it('client reports artificially large duration (e.g. 999999s): server ignores it', () => {
    engine.createWallet(USER_ID, 1000)
    let now = 1_000_000

    const { sessionId } = engine.startLiveSession(USER_ID, now)

    // Rogue client attempts to drain or manipulate duration
    now += 5_000
    const res = engine.heartbeatAndMeterSession(sessionId, USER_ID, now, 999999)
    expect(res.cumulativeSeconds).toBe(5)
    expect(res.billedCents).toBe(20)
    expect(res.newBalance).toBe(980)
  })

  it('duplicate and zero-interval heartbeats: zero additional charge', () => {
    engine.createWallet(USER_ID, 1000)
    let now = 1_000_000

    const { sessionId } = engine.startLiveSession(USER_ID, now)

    now += 5_000
    engine.heartbeatAndMeterSession(sessionId, USER_ID, now)
    expect(engine.wallets.get(USER_ID)!.balance).toBe(980)

    // Same millisecond / zero elapsed time heartbeat
    const dupRes = engine.heartbeatAndMeterSession(sessionId, USER_ID, now)
    expect(dupRes.cumulativeSeconds).toBe(5)
    expect(dupRes.billedCents).toBe(20)
    expect(dupRes.newBalance).toBe(980)
    expect(dupRes.reason).toBe('Heartbeat acknowledged')

    // Only 1 transaction recorded
    expect(engine.transactions).toHaveLength(1)
  })

  it('delayed heartbeat bounded by lease policy (never charges unbounded downtime)', () => {
    engine.createWallet(USER_ID, 2000) // $20.00
    let now = 1_000_000

    const { sessionId } = engine.startLiveSession(USER_ID, now)

    // First normal heartbeat at 5s
    now += 5_000
    engine.heartbeatAndMeterSession(sessionId, USER_ID, now)
    expect(engine.sessions.get(sessionId)!.duration_seconds).toBe(5)
    expect(engine.wallets.get(USER_ID)!.balance).toBe(1980)

    // Client freezes or network delays for 40 seconds (less than stale timeout)
    now += 40_000
    // Lease policy bounds billable duration to MAX_LEASE_SECONDS (15s) instead of 40s
    const delayedRes = engine.heartbeatAndMeterSession(sessionId, USER_ID, now)
    expect(delayedRes.cumulativeSeconds).toBe(20) // 5s + 15s capped
    expect(delayedRes.billedCents).toBe(80) // 20s * 4 cents = 80 cents
    expect(delayedRes.newBalance).toBe(1920) // 2000 - 80 = 1920
  })

  it('lost connection & stale session crash cleanup', () => {
    engine.createWallet(USER_ID, 1000)
    let now = 1_000_000

    const { sessionId } = engine.startLiveSession(USER_ID, now)
    now += 5_000
    engine.heartbeatAndMeterSession(sessionId, USER_ID, now)

    // 50 seconds elapse without heartbeat (stale > 45s)
    now += 50_000

    // New session attempt reconciles stale session and allows user to start clean
    const newSession = engine.startLiveSession(USER_ID, now)
    expect(newSession.sessionId).not.toBe(sessionId)

    // Old session marked abandoned
    expect(engine.sessions.get(sessionId)!.status).toBe('abandoned')
  })

  it('insufficient balance terminates session automatically without negative balance', () => {
    // Wallet has only 14 cents: can afford floor(14 / 4) = 3 seconds (12 cents), 2 cents remain
    engine.createWallet(USER_ID, 14)
    let now = 1_000_000

    const { sessionId } = engine.startLiveSession(USER_ID, now)

    // 5 seconds elapse on server
    now += 5_000
    const res = engine.heartbeatAndMeterSession(sessionId, USER_ID, now)

    expect(res.status).toBe('terminated_insufficient_funds')
    expect(res.stopRequested).toBe(true)
    expect(res.cumulativeSeconds).toBe(3)
    expect(res.billedCents).toBe(12)
    expect(res.newBalance).toBe(2)
    expect(engine.wallets.get(USER_ID)!.balance).toBe(2)
    expect(res.newBalance).toBeGreaterThanOrEqual(0)

    // Subsequent heartbeat returns terminated state with no further debits
    now += 5_000
    const resAfter = engine.heartbeatAndMeterSession(sessionId, USER_ID, now)
    expect(resAfter.status).toBe('terminated_insufficient_funds')
    expect(resAfter.cumulativeSeconds).toBe(3)
    expect(resAfter.newBalance).toBe(2)
  })

  it('duplicate session termination is idempotent and does not charge twice', () => {
    engine.createWallet(USER_ID, 1000)
    let now = 1_000_000

    const { sessionId } = engine.startLiveSession(USER_ID, now)
    now += 10_000

    const end1 = engine.endLiveSession(sessionId, USER_ID, now)
    expect(end1.status).toBe('completed')
    expect(end1.totalSeconds).toBe(10)
    expect(end1.totalBilledCents).toBe(40)
    expect(end1.finalBalance).toBe(960)

    // Duplicate call 1 minute later
    now += 60_000
    const end2 = engine.endLiveSession(sessionId, USER_ID, now)
    expect(end2.status).toBe('completed')
    expect(end2.totalSeconds).toBe(10)
    expect(end2.totalBilledCents).toBe(40)
    expect(end2.finalBalance).toBe(960)

    // Wallet balance untouched
    expect(engine.wallets.get(USER_ID)!.balance).toBe(960)
  })

  it('multiple simultaneous sessions are rejected to prevent wallet circumvention', () => {
    engine.createWallet(USER_ID, 1000)
    const now = 1_000_000

    engine.startLiveSession(USER_ID, now)

    // Attempting to start a concurrent live session while active
    expect(() => {
      engine.startLiveSession(USER_ID, now + 1_000)
    }).toThrow(/already active/)
  })

  it('does not charge for time after a session has been terminated', () => {
    engine.createWallet(USER_ID, 1000)
    let now = 1_000_000

    const { sessionId } = engine.startLiveSession(USER_ID, now)
    now += 5_000
    engine.heartbeatAndMeterSession(sessionId, USER_ID, now)
    expect(engine.wallets.get(USER_ID)!.balance).toBe(980)

    // User ends session
    engine.endLiveSession(sessionId, USER_ID, now)

    // Client continues sending heartbeats for 2 minutes after termination
    now += 120_000
    const lateRes = engine.heartbeatAndMeterSession(sessionId, USER_ID, now)
    expect(lateRes.status).toBe('completed')
    expect(lateRes.cumulativeSeconds).toBe(5)
    expect(lateRes.billedCents).toBe(20)
    expect(engine.wallets.get(USER_ID)!.balance).toBe(980)
  })
})
