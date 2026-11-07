/**
 * Session Billing Service
 *
 * Implements server-authoritative live session usage metering through the
 * `session-heartbeat` and `session-end` Supabase Edge Functions, which in turn
 * execute the PostgreSQL RPCs `start_live_session`, `set_session_billing_state`,
 * `heartbeat_and_meter_session` and `end_live_session`.
 *
 * The client never mutates wallet or session rows directly. It asks the
 * backend to start, meter and end sessions, and adopts the server-authoritative
 * balance / duration returned by those functions.
 */

import { supabase } from '@/lib/supabase'
import { extractFunctionError, logFunctionError } from '@/lib/functionError'

export type SessionBillingMode = 'idle' | 'billable' | 'paused' | 'ended'

export interface SessionBillingState {
  sessionId: string | null
  decartSessionId: string | null
  isActive: boolean
  isStarting: boolean
  billingState: SessionBillingMode
  cumulativeSeconds: number
  billedCents: number
  billedUSD: number
  currentBalanceCents: number
  currentBalanceUSD: number
  lowBalanceWarning: boolean
  criticalBalanceWarning: boolean
  exhausted: boolean
  error: string | null
}

export interface SessionBillingListeners {
  onStateChange?: (state: SessionBillingState) => void
  onLowBalanceWarning?: (remainingSeconds: number, balanceUSD: number) => void
  onCriticalBalanceWarning?: (remainingSeconds: number, balanceUSD: number) => void
  onInsufficientFundsTerminated?: (finalSeconds: number, billedUSD: number) => void
  onError?: (error: string) => void
}

export class SessionBillingService {
  private sessionId: string | null = null
  private decartSessionId: string | null = null
  private isActive: boolean = false
  private isStarting: boolean = false
  private inFlightStartPromise: Promise<{ sessionId: string; currentBalanceCents: number }> | null = null
  private startupCancelled: boolean = false

  private billingState: SessionBillingMode = 'idle'
  private billingStateQueue: Promise<void> = Promise.resolve()
  private lastGenerationTickAt: number = 0

  private cumulativeSeconds: number = 0
  private billedCents: number = 0
  private currentBalanceCents: number = 0

  private lowBalanceWarning: boolean = false
  private criticalBalanceWarning: boolean = false
  private exhausted: boolean = false
  private error: string | null = null

  private consecutiveHeartbeatFailures: number = 0
  private readonly MAX_CONSECUTIVE_FAILURES: number = 3

  private heartbeatIntervalTimer: ReturnType<typeof setInterval> | null = null
  private listeners: SessionBillingListeners = {}

  private readonly HEARTBEAT_INTERVAL_MS = 5000
  private readonly RATE_CENTS_PER_SECOND = 4 // $0.04 / sec
  private readonly LOW_BALANCE_THRESHOLD_SECONDS = 30 // $1.20 USD
  private readonly CRITICAL_BALANCE_THRESHOLD_SECONDS = 10 // $0.40 USD
  private readonly IDLE_TIMEOUT_MS = 20000

  public setListeners(listeners: SessionBillingListeners) {
    this.listeners = { ...this.listeners, ...listeners }
  }

  public removeListeners() {
    this.listeners = {}
  }

  public getState(): SessionBillingState {
    return {
      sessionId: this.sessionId,
      decartSessionId: this.decartSessionId,
      isActive: this.isActive,
      isStarting: this.isStarting,
      billingState: this.billingState,
      cumulativeSeconds: this.cumulativeSeconds,
      billedCents: this.billedCents,
      billedUSD: Number((this.billedCents / 100).toFixed(2)),
      currentBalanceCents: this.currentBalanceCents,
      currentBalanceUSD: Number((this.currentBalanceCents / 100).toFixed(2)),
      lowBalanceWarning: this.lowBalanceWarning,
      criticalBalanceWarning: this.criticalBalanceWarning,
      exhausted: this.exhausted,
      error: this.error,
    }
  }

  private emitState() {
    this.listeners.onStateChange?.(this.getState())
  }

  public setBillingState(next: SessionBillingMode): Promise<void> {
    if (next === 'ended') {
      this.billingState = 'ended'
      this.emitState()
      return Promise.resolve()
    }

    const run = async () => {
      await this.applyBillingState(next)
    }

    this.billingStateQueue = this.billingStateQueue.then(run, run)
    return this.billingStateQueue
  }

  public pauseBilling(): Promise<void> {
    return this.setBillingState('paused')
  }

  public resumeBilling(): Promise<void> {
    return this.setBillingState('billable')
  }

  private async applyBillingState(next: Exclude<SessionBillingMode, 'ended'>): Promise<void> {
    if (!this.isActive || !this.sessionId) {
      return
    }

    if (this.billingState === next) {
      return
    }

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      const token = session?.access_token
      if (!token) return

      const invokeResult = await supabase.functions.invoke('session-heartbeat', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: {
          action: 'billing_state',
          session_id: this.sessionId,
          billing_state: next,
        },
      })
      // `invoke` always returns a response object in production; in unit tests an
      // unmocked vi.fn() may return undefined, so read defensively.
      const data = invokeResult?.data
      const error = invokeResult?.error

      if (error || !data) {
        const err = await extractFunctionError(error)
        logFunctionError('session-heartbeat', err.status, err.statusText, err.message)
        return
      }

      this.billingState = (data.billing_state as SessionBillingMode) ?? next
      if (data.billed_cents !== undefined) this.billedCents = Number(data.billed_cents)
      if (data.new_balance_cents !== undefined) this.currentBalanceCents = Number(data.new_balance_cents)
      if (data.cumulative_seconds !== undefined) this.cumulativeSeconds = Number(data.cumulative_seconds)

      this.emitState()
    } catch (err) {
      console.warn(`Billing state transition to ${next} failed:`, err)
    }
  }

  public startSession(decartSessionId?: string): Promise<{ sessionId: string; currentBalanceCents: number }> {
    if (this.isActive && this.sessionId) {
      return Promise.resolve({
        sessionId: this.sessionId,
        currentBalanceCents: this.currentBalanceCents,
      })
    }

    if (this.isStarting && this.inFlightStartPromise) {
      return this.inFlightStartPromise
    }

    this.startupCancelled = false
    this.isStarting = true
    this.billingState = 'idle'
    this.lastGenerationTickAt = 0
    this.error = null
    this.cumulativeSeconds = 0
    this.billedCents = 0
    this.lowBalanceWarning = false
    this.criticalBalanceWarning = false
    this.exhausted = false
    this.consecutiveHeartbeatFailures = 0
    this.decartSessionId = decartSessionId || null
    this.emitState()

    const startPromise = (async () => {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()

        const token = session?.access_token
        if (!token) {
          throw new Error('Authentication required to start billing session.')
        }

        // Ask the backend to create the live session via the session-heartbeat
        // Edge Function, which executes the server-authoritative start_live_session()
        // RPC (wallet check, duplicate-session prevention, idle initial state).
        const invokeResult = await supabase.functions.invoke('session-heartbeat', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: {
            action: 'start',
            decart_session_id: decartSessionId || null,
          },
        })
        // `invoke` always returns a response object in production; in unit tests an
        // unmocked vi.fn() may return undefined, so read defensively.
        const data = invokeResult?.data
        const error = invokeResult?.error

        if (error || !data) {
          const err = await extractFunctionError(error)
          logFunctionError('session-heartbeat', err.status, err.statusText, err.message)
          throw new Error(
            `Edge Function error (${err.status ?? 'unknown'} ${err.statusText}): ${err.message}`
          )
        }

        // If startup was cancelled while the request was in flight, terminate the
        // session the backend just created so no orphaned active session remains.
        if (this.startupCancelled) {
          try {
            await supabase.functions.invoke('session-end', {
              headers: {
                Authorization: `Bearer ${token}`,
              },
              body: { session_id: data.session_id, final_seconds: 0 },
            })
          } catch (endErr) {
            console.warn(
              '[sessionBillingService] Failed to terminate orphaned session:',
              endErr
            )
          }
          throw new Error('Live session startup was cancelled.')
        }

        this.sessionId = data.session_id ?? null
        this.currentBalanceCents = Number(data.current_balance_cents ?? 0)
        this.billingState = 'idle'
        this.isActive = true
        this.isStarting = false

        this.checkBalanceThresholds(this.currentBalanceCents)
        this.emitState()

        this.startHeartbeatLoop()

        return {
          sessionId: this.sessionId!,
          currentBalanceCents: this.currentBalanceCents,
        }
      } catch (err) {
        this.isStarting = false
        this.isActive = false
        this.billingState = 'idle'
        const errorMsg = err instanceof Error ? err.message : 'Error starting billing'
        this.error = errorMsg
        this.emitState()
        this.listeners.onError?.(errorMsg)
        throw err
      } finally {
        this.inFlightStartPromise = null
        this.isStarting = false
      }
    })()

    this.inFlightStartPromise = startPromise
    return startPromise
  }

  public onGenerationTick(seconds: number) {
    if (!this.isActive) return
    this.lastGenerationTickAt = Date.now()
    if (seconds > this.cumulativeSeconds) {
      this.cumulativeSeconds = Math.floor(seconds)
      this.billedCents = this.cumulativeSeconds * this.RATE_CENTS_PER_SECOND
      this.emitState()
    }
  }

  private startHeartbeatLoop() {
    this.stopHeartbeatLoop()
    this.heartbeatIntervalTimer = setInterval(() => {
      if (
        this.billingState === 'billable' &&
        this.lastGenerationTickAt > 0 &&
        Date.now() - this.lastGenerationTickAt > this.IDLE_TIMEOUT_MS
      ) {
        void this.pauseBilling()
      }
      void this.sendHeartbeat()
    }, this.HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeatLoop() {
    if (this.heartbeatIntervalTimer) {
      clearInterval(this.heartbeatIntervalTimer)
      this.heartbeatIntervalTimer = null
    }
  }

  public async sendHeartbeat(): Promise<void> {
    if (!this.isActive || !this.sessionId) return

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      const token = session?.access_token
      if (!token) return

      const invokeResult = await supabase.functions.invoke('session-heartbeat', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: {
          action: 'heartbeat',
          session_id: this.sessionId,
        },
      })
      const data = invokeResult?.data
      const error = invokeResult?.error

      if (error || !data) {
        const err = await extractFunctionError(error)
        logFunctionError('session-heartbeat', err.status, err.statusText, err.message)
        throw new Error(
          `Edge Function error (${err.status ?? 'unknown'} ${err.statusText}): ${err.message}`
        )
      }

      // Adopt server-authoritative values. The backend only bills while
      // billing_state is 'billable'; paused/idle heartbeats are keepalives.
      this.cumulativeSeconds = Number(data.cumulative_seconds ?? this.cumulativeSeconds)
      this.billedCents = Number(data.billed_cents ?? this.billedCents)
      this.currentBalanceCents = Number(data.new_balance_cents ?? this.currentBalanceCents)
      if (data.billing_state) {
        this.billingState = data.billing_state as SessionBillingMode
      }

      this.checkBalanceThresholds(this.currentBalanceCents)
      this.consecutiveHeartbeatFailures = 0
      this.emitState()

      // A paused session is not streaming, so a low-balance stop_requested must
      // not terminate it. Only actively billable sessions are terminated on
      // balance exhaustion.
      if (data.stop_requested === true && this.billingState !== 'paused') {
        this.handleHeartbeatExhaustedOrFailed(
          typeof data.reason === 'string' && data.reason.length > 0
            ? data.reason
            : 'Balance exhausted'
        )
      }
    } catch (err) {
      this.consecutiveHeartbeatFailures += 1
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.warn('Billing heartbeat error:', errorMsg)
      if (this.consecutiveHeartbeatFailures >= this.MAX_CONSECUTIVE_FAILURES) {
        this.handleHeartbeatExhaustedOrFailed(
          `Billing heartbeat communication lost: ${errorMsg}`
        )
      }
    }
  }

  private handleHeartbeatExhaustedOrFailed(reason: string) {
    this.exhausted = true
    this.isActive = false
    this.billingState = reason === 'Balance exhausted' ? 'ended' : 'paused'
    this.stopHeartbeatLoop()
    this.error = reason
    this.emitState()
    this.listeners.onInsufficientFundsTerminated?.(
      this.cumulativeSeconds,
      Number((this.billedCents / 100).toFixed(2))
    )
    if (reason !== 'Balance exhausted') {
      this.listeners.onError?.(reason)
    }
  }

  private checkBalanceThresholds(balanceCents: number) {
    const remainingSeconds = Math.floor(balanceCents / this.RATE_CENTS_PER_SECOND)
    const balanceUSD = balanceCents / 100

    if (remainingSeconds <= this.CRITICAL_BALANCE_THRESHOLD_SECONDS) {
      if (!this.criticalBalanceWarning) {
        this.criticalBalanceWarning = true
        this.lowBalanceWarning = true
        this.listeners.onCriticalBalanceWarning?.(remainingSeconds, balanceUSD)
      }
    } else if (remainingSeconds <= this.LOW_BALANCE_THRESHOLD_SECONDS) {
      if (!this.lowBalanceWarning) {
        this.lowBalanceWarning = true
        this.listeners.onLowBalanceWarning?.(remainingSeconds, balanceUSD)
      }
    }
  }

  public async endSession(_finalSeconds?: number): Promise<{
    totalSeconds: number
    totalBilledUSD: number
    finalBalanceUSD: number
  }> {
    if (this.isStarting) {
      this.startupCancelled = true
    }

    this.stopHeartbeatLoop()

    const activeSessionId = this.sessionId
    this.isActive = false
    this.isStarting = false

    if (!activeSessionId) {
      this.billingState = 'idle'
      return {
        totalSeconds: this.cumulativeSeconds,
        totalBilledUSD: Number(((this.cumulativeSeconds * this.RATE_CENTS_PER_SECOND) / 100).toFixed(2)),
        finalBalanceUSD: Number((this.currentBalanceCents / 100).toFixed(2)),
      }
    }

    try {
      const {
        data: { session } = {},
      } = await supabase.auth.getSession()

      const token = session?.access_token
      if (token) {
        // Finalize the session on the backend via the session-end Edge Function,
        // which executes the server-authoritative end_live_session() RPC.
        const invokeResult = await supabase.functions.invoke('session-end', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: { session_id: activeSessionId },
        })
        const data = invokeResult?.data
        const error = invokeResult?.error

        if (!error && data) {
          this.cumulativeSeconds = Number(data.total_seconds ?? this.cumulativeSeconds)
          this.billedCents = Number(data.total_billed_cents ?? this.billedCents)
          this.currentBalanceCents = Number(data.final_balance_cents ?? this.currentBalanceCents)
        } else if (error || !data) {
          const err = await extractFunctionError(error)
          logFunctionError('session-end', err.status, err.statusText, err.message)
        }
      }
    } finally {
      this.sessionId = null
      this.decartSessionId = null
      this.billingState = 'idle'
      this.lastGenerationTickAt = 0
      this.lowBalanceWarning = false
      this.criticalBalanceWarning = false
      this.exhausted = false
      this.consecutiveHeartbeatFailures = 0
      this.emitState()
    }

    return {
      totalSeconds: this.cumulativeSeconds,
      totalBilledUSD: Number((this.billedCents / 100).toFixed(2)),
      finalBalanceUSD: Number((this.currentBalanceCents / 100).toFixed(2)),
    }
  }
}

export const sessionBillingService = new SessionBillingService()
