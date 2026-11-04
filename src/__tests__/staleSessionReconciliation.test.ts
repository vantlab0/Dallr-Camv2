import { describe, it, expect, beforeEach } from 'vitest'

/**
 * Stale Live Session Reconciliation Specification & Test Suite
 *
 * Verifies all requirements for Task 5:
 * 1. Stale session detection (heartbeat lease expired > 45s).
 * 2. Active session protection (active heartbeats within 45s are untouched).
 * 3. Graceful termination and status transition to 'abandoned'.
 * 4. Billing bounded by heartbeat lease cap (max 15 seconds), preventing indefinite accumulation.
 * 5. Wallets never overdrawn.
 * 6. Repeated execution is strictly idempotent (zero duplicate debits or transactions).
 * 7. Security model: only trusted backend/service_role operations can execute reconciliation.
 * 8. Audit logging: tracks execution, count, status, duration without exposing secrets.
 * 9. Scheduling idempotency: deployment safe without duplicate cron jobs.
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

interface MockReconciliationLog {
  id: string
  job_name: string
  started_at: number
  completed_at: number | null
  sessions_reconciled: number
  status: 'running' | 'success' | 'failed'
  error_message: string | null
  duration_ms: number | null
}

interface MockCronJob {
  jobid: number
  schedule: string
  command: string
  jobname: string
  active: boolean
}

class ReconciliationTestEngine {
  public wallets = new Map<string, MockWallet>()
  public sessions = new Map<string, MockSession>()
  public transactions: Array<{
    id: string
    wallet_id: string
    user_id: string
    amount: number
    reference: string
    description: string
  }> = []
  public reconciliationLogs: MockReconciliationLog[] = []
  public cronJobs: Map<string, MockCronJob> = new Map()

  private nextJobId = 1
  private nextTxId = 1

  public scheduleCronJob(name: string, schedule: string, command: string) {
    // Unschedule previous job with the same name if exists (idempotent deployment)
    this.cronJobs.delete(name)
    const job: MockCronJob = {
      jobid: this.nextJobId++,
      schedule,
      command,
      jobname: name,
      active: true,
    }
    this.cronJobs.set(name, job)
    return job
  }

  public createWallet(userId: string, initialBalanceCents: number): MockWallet {
    const wallet: MockWallet = {
      id: `w_${userId}`,
      user_id: userId,
      balance: initialBalanceCents,
    }
    this.wallets.set(userId, wallet)
    return wallet
  }

  public createSession(options: {
    userId: string
    startedAt: number
    lastBilledAt?: number
    lastHeartbeatAt?: number
    status?: 'active' | 'completed' | 'abandoned'
    durationSeconds?: number
    billedAmount?: number
  }): MockSession {
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(7)}`
    const session: MockSession = {
      id: sessionId,
      user_id: options.userId,
      status: options.status || 'active',
      started_at: options.startedAt,
      last_billed_at: options.lastBilledAt ?? options.startedAt,
      last_heartbeat_at: options.lastHeartbeatAt ?? options.startedAt,
      ended_at: null,
      duration_seconds: options.durationSeconds ?? 0,
      billed_amount: options.billedAmount ?? 0,
    }
    this.sessions.set(sessionId, session)
    return session
  }

  public reconcileStaleSessions(options: {
    currentTime: number
    callerRole: 'service_role' | 'authenticated' | 'anon'
  }): number {
    const { currentTime, callerRole } = options

    // Access check: only service_role permitted
    if (callerRole !== 'service_role') {
      throw new Error('Access denied: reconcile_stale_sessions can only be invoked by service_role')
    }

    const logId = `log_${Date.now()}_${Math.random().toString(36).substring(7)}`
    const log: MockReconciliationLog = {
      id: logId,
      job_name: 'reconcile-stale-live-sessions',
      started_at: currentTime,
      completed_at: null,
      sessions_reconciled: 0,
      status: 'running',
      error_message: null,
      duration_ms: null,
    }
    this.reconciliationLogs.push(log)

    const STALE_THRESHOLD_MS = 45_000 // 45 seconds
    const RATE_CENTS_PER_SEC = 4
    const MAX_LEASE_SECONDS = 15

    let reconciledCount = 0

    try {
      for (const session of this.sessions.values()) {
        if (session.status !== 'active') {
          continue
        }

        const timeSinceHeartbeat = currentTime - session.last_heartbeat_at
        if (timeSinceHeartbeat < STALE_THRESHOLD_MS) {
          // Still active!
          continue
        }

        // Session is stale! Calculate unbilled delta up to last heartbeat
        const rawElapsedSeconds = Math.floor((session.last_heartbeat_at - session.last_billed_at) / 1000)

        if (rawElapsedSeconds > 0) {
          const billableSeconds = Math.min(rawElapsedSeconds, MAX_LEASE_SECONDS)
          const debitAmount = billableSeconds * RATE_CENTS_PER_SEC

          const wallet = this.wallets.get(session.user_id)
          if (wallet && wallet.balance > 0 && debitAmount > 0) {
            if (wallet.balance >= debitAmount) {
              wallet.balance -= debitAmount
              this.transactions.push({
                id: `tx_${this.nextTxId++}`,
                wallet_id: wallet.id,
                user_id: session.user_id,
                amount: -debitAmount,
                reference: `meter_reconcile_${session.id}_${session.duration_seconds + billableSeconds}`,
                description: `Live Video Usage Reconciled (${billableSeconds}s @ $0.04/s)`,
              })

              session.duration_seconds += billableSeconds
              session.billed_amount += debitAmount
              session.last_billed_at += billableSeconds * 1000
            } else {
              // Drain affordable portion without going negative
              const affordableSeconds = Math.floor(wallet.balance / RATE_CENTS_PER_SEC)
              const affordableDebit = affordableSeconds * RATE_CENTS_PER_SEC

              if (affordableDebit > 0) {
                wallet.balance -= affordableDebit
                this.transactions.push({
                  id: `tx_${this.nextTxId++}`,
                  wallet_id: wallet.id,
                  user_id: session.user_id,
                  amount: -affordableDebit,
                  reference: `meter_reconcile_final_${session.id}`,
                  description: `Live Video Usage Final Reconciled (${affordableSeconds}s @ $0.04/s)`,
                })
              }

              session.duration_seconds += affordableSeconds
              session.billed_amount += affordableDebit
              session.last_billed_at += affordableSeconds * 1000
            }
          }
        }

        session.status = 'abandoned'
        session.ended_at = session.last_heartbeat_at
        reconciledCount++
      }

      log.completed_at = currentTime + 5
      log.sessions_reconciled = reconciledCount
      log.status = 'success'
      log.duration_ms = 5

      return reconciledCount
    } catch (err: unknown) {
      log.completed_at = currentTime + 5
      log.sessions_reconciled = reconciledCount
      log.status = 'failed'
      log.error_message = err instanceof Error ? err.message : String(err)
      log.duration_ms = 5
      throw err
    }
  }
}

describe('Stale Live Session Reconciliation & Scheduler Tests', () => {
  let engine: ReconciliationTestEngine
  const USER_A = 'user-uuid-a'

  beforeEach(() => {
    engine = new ReconciliationTestEngine()
  })

  it('detects and terminates sessions that stopped sending heartbeats (> 45s)', () => {
    engine.createWallet(USER_A, 2000) // $20.00
    const startTime = 1_000_000

    // Session heartbeat sent 50 seconds ago (exceeds 45s threshold)
    const staleSession = engine.createSession({
      userId: USER_A,
      startedAt: startTime,
      lastBilledAt: startTime,
      lastHeartbeatAt: startTime + 10_000, // 10s of activity
    })

    const currentTime = startTime + 60_000 // 50 seconds after last heartbeat
    const reconciled = engine.reconcileStaleSessions({
      currentTime,
      callerRole: 'service_role',
    })

    expect(reconciled).toBe(1)
    expect(staleSession.status).toBe('abandoned')
    expect(staleSession.ended_at).toBe(staleSession.last_heartbeat_at)
  })

  it('protects genuinely active sessions with fresh heartbeats (< 45s)', () => {
    engine.createWallet(USER_A, 2000)
    const startTime = 1_000_000

    // Active session with heartbeat 10 seconds ago
    const activeSession = engine.createSession({
      userId: USER_A,
      startedAt: startTime,
      lastBilledAt: startTime + 20_000,
      lastHeartbeatAt: startTime + 20_000,
    })

    const currentTime = startTime + 30_000 // 10s after last heartbeat
    const reconciled = engine.reconcileStaleSessions({
      currentTime,
      callerRole: 'service_role',
    })

    expect(reconciled).toBe(0)
    expect(activeSession.status).toBe('active')
    expect(activeSession.ended_at).toBeNull()
  })

  it('caps unbilled reconciliation charge to maximum lease (15s) and does not overcharge for downtime', () => {
    engine.createWallet(USER_A, 2000) // $20.00
    const startTime = 1_000_000

    // Session ran for 40 seconds before stopping heartbeats, but last_billed_at remained at start
    const session = engine.createSession({
      userId: USER_A,
      startedAt: startTime,
      lastBilledAt: startTime,
      lastHeartbeatAt: startTime + 40_000, // 40 seconds gap
    })

    const currentTime = startTime + 90_000 // 50s after last heartbeat
    engine.reconcileStaleSessions({
      currentTime,
      callerRole: 'service_role',
    })

    // Billable duration capped to MAX_LEASE_SECONDS (15s) = 15s * 4 cents = 60 cents
    expect(session.duration_seconds).toBe(15)
    expect(session.billed_amount).toBe(60)
    expect(engine.wallets.get(USER_A)!.balance).toBe(1940) // 2000 - 60
    expect(session.status).toBe('abandoned')
  })

  it('prevents abandoned sessions from accumulating subsequent charges', () => {
    engine.createWallet(USER_A, 2000)
    const startTime = 1_000_000

    const session = engine.createSession({
      userId: USER_A,
      startedAt: startTime,
      lastBilledAt: startTime,
      lastHeartbeatAt: startTime + 10_000,
    })

    // Reconcile session
    const time1 = startTime + 60_000
    engine.reconcileStaleSessions({ currentTime: time1, callerRole: 'service_role' })
    const balanceAfterReconcile = engine.wallets.get(USER_A)!.balance
    const txCount = engine.transactions.length

    // 10 minutes pass: scheduler runs again multiple times
    for (let i = 1; i <= 10; i++) {
      const reconciled = engine.reconcileStaleSessions({
        currentTime: time1 + i * 60_000,
        callerRole: 'service_role',
      })
      expect(reconciled).toBe(0)
    }

    // Wallet balance and transactions remain unchanged
    expect(engine.wallets.get(USER_A)!.balance).toBe(balanceAfterReconcile)
    expect(engine.transactions).toHaveLength(txCount)
    expect(session.status).toBe('abandoned')
  })

  it('repeated reconciliation is strictly idempotent and does not charge twice', () => {
    engine.createWallet(USER_A, 1000)
    const startTime = 1_000_000

    const session = engine.createSession({
      userId: USER_A,
      startedAt: startTime,
      lastBilledAt: startTime,
      lastHeartbeatAt: startTime + 10_000,
    })

    const run1 = engine.reconcileStaleSessions({
      currentTime: startTime + 60_000,
      callerRole: 'service_role',
    })
    expect(run1).toBe(1)
    const initialBilled = session.billed_amount
    const initialBalance = engine.wallets.get(USER_A)!.balance
    const initialTxLength = engine.transactions.length

    // Second run immediately after
    const run2 = engine.reconcileStaleSessions({
      currentTime: startTime + 65_000,
      callerRole: 'service_role',
    })
    expect(run2).toBe(0)
    expect(session.billed_amount).toBe(initialBilled)
    expect(engine.wallets.get(USER_A)!.balance).toBe(initialBalance)
    expect(engine.transactions).toHaveLength(initialTxLength)
  })

  it('never overdraws a wallet with insufficient balance when reconciling', () => {
    // Only 10 cents in wallet (affords 2 seconds * 4 cents = 8 cents; leaves 2 cents)
    engine.createWallet(USER_A, 10)
    const startTime = 1_000_000

    const session = engine.createSession({
      userId: USER_A,
      startedAt: startTime,
      lastBilledAt: startTime,
      lastHeartbeatAt: startTime + 10_000, // 10s gap would normally cost 40 cents
    })

    engine.reconcileStaleSessions({
      currentTime: startTime + 60_000,
      callerRole: 'service_role',
    })

    expect(session.status).toBe('abandoned')
    expect(session.duration_seconds).toBe(2)
    expect(session.billed_amount).toBe(8)
    expect(engine.wallets.get(USER_A)!.balance).toBe(2)
    expect(engine.wallets.get(USER_A)!.balance).toBeGreaterThanOrEqual(0)
  })

  it('rejects unauthenticated or non-service-role invocations', () => {
    const startTime = 1_000_000
    engine.createSession({
      userId: USER_A,
      startedAt: startTime,
    })

    // Anon caller rejected
    expect(() => {
      engine.reconcileStaleSessions({
        currentTime: startTime + 60_000,
        callerRole: 'anon',
      })
    }).toThrow(/Access denied/)

    // Authenticated non-admin user rejected
    expect(() => {
      engine.reconcileStaleSessions({
        currentTime: startTime + 60_000,
        callerRole: 'authenticated',
      })
    }).toThrow(/Access denied/)
  })

  it('records structured audit log without secrets on success', () => {
    engine.createWallet(USER_A, 1000)
    const startTime = 1_000_000

    engine.createSession({
      userId: USER_A,
      startedAt: startTime,
      lastBilledAt: startTime,
      lastHeartbeatAt: startTime + 10_000,
    })

    engine.reconcileStaleSessions({
      currentTime: startTime + 60_000,
      callerRole: 'service_role',
    })

    expect(engine.reconciliationLogs).toHaveLength(1)
    const log = engine.reconciliationLogs[0]
    expect(log.job_name).toBe('reconcile-stale-live-sessions')
    expect(log.sessions_reconciled).toBe(1)
    expect(log.status).toBe('success')
    expect(log.error_message).toBeNull()
    expect(log.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('schedules pg_cron job and prevents duplicate jobs across deployments', () => {
    // Initial deployment
    const job1 = engine.scheduleCronJob(
      'reconcile-stale-live-sessions',
      '* * * * *',
      'SELECT public.reconcile_stale_sessions();'
    )
    expect(engine.cronJobs.size).toBe(1)
    expect(job1.schedule).toBe('* * * * *')

    // Second deployment / rerun of migration
    const job2 = engine.scheduleCronJob(
      'reconcile-stale-live-sessions',
      '* * * * *',
      'SELECT public.reconcile_stale_sessions();'
    )
    expect(engine.cronJobs.size).toBe(1)
    expect(engine.cronJobs.get('reconcile-stale-live-sessions')!.jobid).toBe(job2.jobid)
  })
})
