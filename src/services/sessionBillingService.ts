/**
 * Session Billing Service
 *
 * Implements server-authoritative live session usage metering:
 * - Sends periodic heartbeats every 5s. The backend only charges while the
 *   server-side billing_state is exactly 'billable'.
 * - Explicitly pauses billing whenever the stream is reconnecting, disconnected,
 *   or idle, so users are never charged for dead time.
 * - Resumes billing only after the stream is re-established.
 * - Receives authoritative wallet debits ($0.04 USD / sec) from the backend.
 * - Emits warnings at < 30s ($1.20) and < 10s ($0.40).
 * - Enforces immediate teardown if balance is exhausted.
 * - Tracks consecutive heartbeat failures and halts stream if heartbeats fail repeatedly.
 */

import { supabase } from '@/lib/supabase'

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

  // 5-second metering heartbeat
  private readonly HEARTBEAT_INTERVAL_MS = 5000
  private readonly RATE_CENTS_PER_SECOND = 4 // $0.04 / sec
  private readonly LOW_BALANCE_THRESHOLD_SECONDS = 30 // $1.20 USD
  private readonly CRITICAL_BALANCE_THRESHOLD_SECONDS = 10 // $0.40 USD
  // If the stream is marked billable but no generation tick arrives for this long,
  // the client implicitly pauses billing. The backend is always the final authority.
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

  /**
   * Explicit server-authoritative billing state transition.
   * - billable: stream is connected and generating.
   * - paused: reconnecting, disconnected, or temporarily idle.
   * - idle: startup / no active stream.
   *
   * Transitions are serialized so rapid connect/reconnect events cannot race.
   */
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

      const { data, error } = await supabase.functions.invoke('session-heartbeat', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: {
          action: 'billing_state',
          session_id: this.sessionId,
          billing_state: next,
        },
      })

      if (error || !data?.success) {
        const errorMsg = (data as { error?: string; message?: string })?.error
          || (data as { message?: string })?.message
          || error?.message
          || 'Unknown error'
        const statusCode = (error as { status?: number })?.status || 'unknown'
        const statusText = (error as { statusText?: string })?.statusText || ''
        console.warn(
          `Failed to set billing state to ${next}: Edge Function error (${statusCode} ${statusText}): ${errorMsg}`
        )
        return
      }

      this.billingState = (data.billing_state as SessionBillingMode) || next

      if (typeof data.billed_cents === 'number') {
        this.billedCents = data.billed_cents
      }
      if (typeof data.cumulative_seconds === 'number' && data.cumulative_seconds > this.cumulativeSeconds) {
        this.cumulativeSeconds = data.cumulative_seconds
      }
      if (typeof data.new_balance_cents === 'number') {
        this.currentBalanceCents = data.new_balance_cents
        this.checkBalanceThresholds(this.currentBalanceCents)
      }

      this.emitState()
    } catch (err) {
      console.warn(`Billing state transition to ${next} failed:`, err)
    }
  }

  /**
   * Starts a new authoritative live session on the backend.
   * Invoked once Decart connection is confirmed.
   * The session starts in 'idle'; callers must explicitly resumeBilling()
   * once the stream is actually generating.
   * Idempotent and thread-safe against concurrent startup attempts.
   */
  public startSession(decartSessionId?: string): Promise<{ sessionId: string; currentBalanceCents: number }> {
    // 1. If already active, return current session idempotently
    if (this.isActive && this.sessionId) {
      return Promise.resolve({
        sessionId: this.sessionId,
        currentBalanceCents: this.currentBalanceCents,
      })
    }

    // 2. If already starting, reuse the existing in-flight promise to prevent duplicates
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

        const { data, error } = await supabase.functions.invoke('session-heartbeat', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: {
            action: 'start',
            decart_session_id: decartSessionId,
          },
        })

        if (error || !data?.success) {
          const errorMsg = (data as { error?: string; message?: string })?.error
            || (data as { message?: string })?.message
            || error?.message
            || 'Unknown error'
          const statusCode = (error as { status?: number })?.status || 'unknown'
          const statusText = (error as { statusText?: string })?.statusText || ''
          throw new Error(`Edge Function error (${statusCode} ${statusText}): ${errorMsg}`)
        }

        // If the session was cancelled or ended while this asynchronous request was in-flight,
        // immediately close the newly created session on the backend and do not activate locally.
        if (this.startupCancelled) {
          const orphanedSessionId = data.session_id
          if (orphanedSessionId && token) {
            try {
              const invokeEnd = supabase.functions.invoke('session-end', {
                headers: { Authorization: `Bearer ${token}` },
                body: { session_id: orphanedSessionId, final_seconds: 0 },
              })
              if (invokeEnd && typeof invokeEnd.catch === 'function') {
                invokeEnd.catch((err) => {
                  console.warn('Failed to end cancelled startup session:', err)
                })
              }
            } catch (err) {
              console.warn('Failed to invoke session-end for cancelled startup:', err)
            }
          }
          throw new Error('Live session startup was cancelled.')
        }

        this.sessionId = data.session_id
        this.currentBalanceCents = data.current_balance_cents
        this.billingState = (data.billing_state as SessionBillingMode) || 'idle'
        this.isActive = true
        this.isStarting = false

        this.checkBalanceThresholds(this.currentBalanceCents)
        this.emitState()

        // Start periodic heartbeat timer
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

  /**
   * Called on every generation tick from Decart SDK.
   * Updates local display counters. The server remains authoritative for charges.
   */
  public onGenerationTick(seconds: number) {
    if (!this.isActive) return
    this.lastGenerationTickAt = Date.now()
    // Ensure monotonically increasing
    if (seconds > this.cumulativeSeconds) {
      this.cumulativeSeconds = Math.floor(seconds)
      this.billedCents = this.cumulativeSeconds * this.RATE_CENTS_PER_SECOND
      this.emitState()
    }
  }

  /**
   * Starts periodic heartbeat to keep the session alive and meter billable usage.
   */
  private startHeartbeatLoop() {
    this.stopHeartbeatLoop()
    this.heartbeatIntervalTimer = setInterval(() => {
      // Safety net: a billable stream that stops producing frames is effectively idle.
      // Pause billing so the user is not charged for a frozen/disconnected stream.
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

  /**
   * Sends a keepalive / metering heartbeat to the authoritative backend.
   * The backend only charges when billing_state is 'billable'.
   */
  public async sendHeartbeat(): Promise<void> {
    if (!this.isActive || !this.sessionId) return

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      const token = session?.access_token
      if (!token) return

      const { data, error } = await supabase.functions.invoke('session-heartbeat', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: {
          action: 'heartbeat',
          session_id: this.sessionId,
        },
      })

      if (error) {
        this.consecutiveHeartbeatFailures += 1
        const errorMsg = error?.message || 'Unknown error'
        const statusCode = (error as { status?: number })?.status || 'unknown'
        const statusText = (error as { statusText?: string })?.statusText || ''
        console.warn(`Billing heartbeat warning (${this.consecutiveHeartbeatFailures}/${this.MAX_CONSECUTIVE_FAILURES}): Edge Function error (${statusCode} ${statusText}): ${errorMsg}`)
        if (this.consecutiveHeartbeatFailures >= this.MAX_CONSECUTIVE_FAILURES) {
          this.handleHeartbeatExhaustedOrFailed(`Billing heartbeat communication lost: Edge Function error (${statusCode} ${statusText}): ${errorMsg}`)
        }
        return
      }

      if (data?.success) {
        this.consecutiveHeartbeatFailures = 0
        if (
          data.billing_state === 'idle' ||
          data.billing_state === 'billable' ||
          data.billing_state === 'paused' ||
          data.billing_state === 'ended'
        ) {
          this.billingState = data.billing_state
        }
        this.billedCents = data.billed_cents ?? this.billedCents
        this.currentBalanceCents = data.new_balance_cents ?? this.currentBalanceCents
        if (typeof data.cumulative_seconds === 'number' && data.cumulative_seconds > this.cumulativeSeconds) {
          this.cumulativeSeconds = data.cumulative_seconds
        }

        this.checkBalanceThresholds(this.currentBalanceCents)

        if (data.status === 'terminated_insufficient_funds') {
          this.handleHeartbeatExhaustedOrFailed('Balance exhausted')
        } else if (data.stop_requested && this.billingState === 'billable') {
          this.handleHeartbeatExhaustedOrFailed('Balance exhausted')
        } else {
          this.emitState()
        }
      }
    } catch (err) {
      this.consecutiveHeartbeatFailures += 1
      console.warn(`Billing heartbeat network failure (${this.consecutiveHeartbeatFailures}/${this.MAX_CONSECUTIVE_FAILURES}):`, err)
      if (this.consecutiveHeartbeatFailures >= this.MAX_CONSECUTIVE_FAILURES) {
        this.handleHeartbeatExhaustedOrFailed('Billing heartbeat network communication lost.')
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

  /**
   * Checks balance against warning thresholds.
   */
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

  /**
   * Finalizes the active session on the backend.
   * The backend only bills a final interval if billing_state is still 'billable'.
   */
  public async endSession(_finalSeconds?: number): Promise<{
    totalSeconds: number
    totalBilledUSD: number
    finalBalanceUSD: number
  }> {
    // Mark any in-flight startup as cancelled
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
      } = (await supabase.auth.getSession()) || {}

      const token = session?.access_token
      if (token) {
        const invokeRes = await supabase.functions.invoke('session-end', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: {
            session_id: activeSessionId,
          },
        })

        const data = invokeRes?.data
        if (data?.success) {
          this.billedCents = data.total_billed_cents ?? this.billedCents
          this.currentBalanceCents = data.final_balance_cents ?? this.currentBalanceCents
          this.cumulativeSeconds = data.total_seconds ?? this.cumulativeSeconds
        }
      }
    } catch (err) {
      console.warn('Failed to cleanly finalize session with backend:', err)
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
