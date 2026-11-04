/**
 * Session Billing Service
 *
 * Implements server-authoritative live session usage metering:
 * - Sends periodic heartbeats with cumulative elapsed seconds every 5s.
 * - Receives authoritative wallet debits ($0.04 USD / sec) from backend Edge Function.
 * - Emits warnings at < 30s ($1.20) and < 10s ($0.40).
 * - Enforces immediate teardown if balance is exhausted.
 * - Tracks consecutive heartbeat failures and halts stream if heartbeats fail repeatedly.
 * - Idempotently ends session on:
 *   - User manual end call.
 *   - Output window closure.
 *   - App exit / page beforeunload.
 *   - WebRTC / Decart connection failure.
 */

import { supabase } from '@/lib/supabase'

export interface SessionBillingState {
  sessionId: string | null
  decartSessionId: string | null
  isActive: boolean
  isStarting: boolean
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
   * Starts a new authoritative live session on the backend.
   * Invoked once Decart connection is confirmed.
   */
  public async startSession(decartSessionId?: string): Promise<{ sessionId: string; currentBalanceCents: number }> {
    if (this.isActive) {
      return {
        sessionId: this.sessionId!,
        currentBalanceCents: this.currentBalanceCents,
      }
    }

    this.isStarting = true
    this.error = null
    this.cumulativeSeconds = 0
    this.billedCents = 0
    this.lowBalanceWarning = false
    this.criticalBalanceWarning = false
    this.exhausted = false
    this.consecutiveHeartbeatFailures = 0
    this.decartSessionId = decartSessionId || null
    this.emitState()

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
        const msg = data?.error || error?.message || 'Failed to start billing session'
        throw new Error(msg)
      }

      this.sessionId = data.session_id
      this.currentBalanceCents = data.current_balance_cents
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
      const errorMsg = err instanceof Error ? err.message : 'Error starting billing'
      this.error = errorMsg
      this.emitState()
      throw err
    }
  }

  /**
   * Called on every generation tick from Decart SDK.
   * Updates local cumulative seconds.
   */
  public onGenerationTick(seconds: number) {
    if (!this.isActive) return
    // Ensure monotonically increasing
    if (seconds > this.cumulativeSeconds) {
      this.cumulativeSeconds = Math.floor(seconds)
      this.billedCents = this.cumulativeSeconds * this.RATE_CENTS_PER_SECOND
      this.emitState()
    }
  }

  /**
   * Starts periodic heartbeat to send cumulative usage to backend.
   */
  private startHeartbeatLoop() {
    this.stopHeartbeatLoop()
    this.heartbeatIntervalTimer = setInterval(() => {
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
   * Sends cumulative usage to authoritative backend.
   * Halts stream if heartbeats fail beyond bounded threshold.
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
          cumulative_seconds: this.cumulativeSeconds,
        },
      })

      if (error) {
        this.consecutiveHeartbeatFailures += 1
        console.warn(`Billing heartbeat warning (${this.consecutiveHeartbeatFailures}/${this.MAX_CONSECUTIVE_FAILURES}):`, error.message)
        if (this.consecutiveHeartbeatFailures >= this.MAX_CONSECUTIVE_FAILURES) {
          this.handleHeartbeatExhaustedOrFailed('Billing heartbeat communication lost with server.')
        }
        return
      }

      if (data?.success) {
        this.consecutiveHeartbeatFailures = 0
        this.billedCents = data.billed_cents ?? this.billedCents
        this.currentBalanceCents = data.new_balance_cents ?? this.currentBalanceCents

        this.checkBalanceThresholds(this.currentBalanceCents)

        if (data.stop_requested || data.status === 'terminated_insufficient_funds') {
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
    this.stopHeartbeatLoop()
    this.error = reason
    this.emitState()
    this.listeners.onInsufficientFundsTerminated?.(
      this.cumulativeSeconds,
      Number((this.billedCents / 100).toFixed(2))
    )
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
   */
  public async endSession(finalSeconds?: number): Promise<{
    totalSeconds: number
    totalBilledUSD: number
    finalBalanceUSD: number
  }> {
    this.stopHeartbeatLoop()

    const activeSessionId = this.sessionId
    const secondsToReport = finalSeconds !== undefined
      ? Math.max(this.cumulativeSeconds, Math.floor(finalSeconds))
      : this.cumulativeSeconds

    this.isActive = false

    if (!activeSessionId) {
      return {
        totalSeconds: secondsToReport,
        totalBilledUSD: Number(((secondsToReport * this.RATE_CENTS_PER_SECOND) / 100).toFixed(2)),
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
            final_seconds: secondsToReport,
          },
        })

        const data = invokeRes?.data
        if (data?.success) {
          this.billedCents = data.total_billed_cents
          this.currentBalanceCents = data.final_balance_cents
          this.cumulativeSeconds = data.total_seconds
        }
      }
    } catch (err) {
      console.warn('Failed to cleanly finalize session with backend:', err)
    } finally {
      this.sessionId = null
      this.decartSessionId = null
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
