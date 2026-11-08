/**
 * Session Billing Service
 *
 * Local-first billing for a personal single-user application.
 *
 * - Wallet balance is read locally from Supabase at session start.
 * - Credits are deducted locally at $0.04 USD per billable second.
 * - No Edge Function is called during the session (no constant heartbeat
 *   metering). The heartbeat loop only updates local state.
 * - When the session ends, the final state is synced to the cloud once via
 *   the `session-end` Edge Function (which runs `end_live_session()`).
 *
 * Because this is a personal application, the Decart API key and billing
 * logic live entirely in the desktop client.
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

  private billingState: SessionBillingMode = 'idle'
  private lastGenerationTickAt: number = 0
  private lastDeductionAt: number = 0

  private cumulativeSeconds: number = 0
  private billedCents: number = 0
  private currentBalanceCents: number = 0

  private lowBalanceWarning: boolean = false
  private criticalBalanceWarning: boolean = false
  private exhausted: boolean = false
  private error: string | null = null

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

    if (this.billingState === next) {
      return Promise.resolve()
    }

    this.billingState = next
    this.emitState()
    return Promise.resolve()
  }

  public pauseBilling(): Promise<void> {
    return this.setBillingState('paused')
  }

  public resumeBilling(): Promise<void> {
    return this.setBillingState('billable')
  }

  public startSession(decartSessionId?: string): Promise<{ sessionId: string; currentBalanceCents: number }> {
    if (this.isActive && this.sessionId) {
      return Promise.resolve({
        sessionId: this.sessionId,
        currentBalanceCents: this.currentBalanceCents,
      })
    }

    if (this.isStarting) {
      // Return a promise that resolves once the current start completes
      return new Promise((resolve) => {
        const check = () => {
          if (!this.isStarting) {
            resolve({
              sessionId: this.sessionId!,
              currentBalanceCents: this.currentBalanceCents,
            })
          } else {
            setTimeout(check, 50)
          }
        }
        check()
      })
    }

    this.isStarting = true
    this.billingState = 'idle'
    this.lastGenerationTickAt = 0
    this.lastDeductionAt = Date.now()
    this.error = null
    this.cumulativeSeconds = 0
    this.billedCents = 0
    this.lowBalanceWarning = false
    this.criticalBalanceWarning = false
    this.exhausted = false
    this.decartSessionId = decartSessionId || null
    this.emitState()

    const startPromise = (async () => {
      try {
        const {
          data: { session },
          error: authError,
        } = await supabase.auth.getSession()

        if (authError || !session?.access_token) {
          throw new Error('Authentication required to start billing session.')
        }

        // Read wallet balance locally from Supabase (SELECT only, allowed by RLS)
        const { data: wallet, error: walletError } = await supabase
          .from('wallets')
          .select('balance')
          .eq('user_id', session.user.id)
          .single()

        if (walletError || !wallet) {
          throw new Error('Wallet not found. Please add funds before starting a live stream.')
        }

        if (wallet.balance < 4) {
          throw new Error(
            `Insufficient balance to start live stream. ` +
              `Current balance: $${(wallet.balance / 100).toFixed(2)} USD. ` +
              `Minimum required: $0.04 USD.`,
          )
        }

        // Create the live session record via Edge Function (one call at start)
        const { data: sessionData, error: sessionError } = await supabase.functions.invoke(
          'session-heartbeat',
          {
            headers: {
              Authorization: `Bearer ${session.access_token}`,
            },
            body: {
              action: 'start',
              decart_session_id: decartSessionId || null,
            },
          },
        )

        if (sessionError || !sessionData) {
          throw new Error(sessionError?.message || 'Failed to create live session.')
        }

        this.sessionId = sessionData.session_id ?? null
        this.currentBalanceCents = Number(sessionData.current_balance_cents ?? wallet.balance)
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
      }
    })()

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
    this.lastDeductionAt = Date.now()
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

  /**
   * Local-only credit deduction. No Edge Function is called.
   * Runs every heartbeat interval while billingState is 'billable'.
   */
  public async sendHeartbeat(): Promise<void> {
    if (!this.isActive || !this.sessionId) return

    if (this.billingState !== 'billable') {
      // Paused / idle: just emit state, no deduction
      this.emitState()
      return
    }

    const now = Date.now()
    const elapsedSeconds = Math.floor((now - this.lastDeductionAt) / 1000)

    if (elapsedSeconds > 0) {
      const debitCents = elapsedSeconds * this.RATE_CENTS_PER_SECOND

      if (this.currentBalanceCents >= debitCents) {
        this.currentBalanceCents -= debitCents
        this.billedCents += debitCents
        this.cumulativeSeconds += elapsedSeconds
      } else {
        // Not enough to cover the full elapsed interval: bill what's affordable
        const affordableSeconds = Math.floor(this.currentBalanceCents / this.RATE_CENTS_PER_SECOND)
        const affordableCents = affordableSeconds * this.RATE_CENTS_PER_SECOND

        if (affordableCents > 0) {
          this.currentBalanceCents -= affordableCents
          this.billedCents += affordableCents
          this.cumulativeSeconds += affordableSeconds
        }

        this.handleExhaustion('Balance exhausted')
        return
      }
    }

    this.lastDeductionAt = now
    this.checkBalanceThresholds(this.currentBalanceCents)
    this.emitState()
  }

  private handleExhaustion(reason: string) {
    this.exhausted = true
    this.isActive = false
    this.billingState = 'ended'
    this.stopHeartbeatLoop()
    this.error = reason
    this.emitState()
    this.listeners.onInsufficientFundsTerminated?.(
      this.cumulativeSeconds,
      Number((this.billedCents / 100).toFixed(2))
    )
    this.listeners.onError?.(reason)
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

  /**
   * Ends the local billing session and syncs the final state to the cloud once
   * via the `session-end` Edge Function (not called during the session).
   */
  public async endSession(): Promise<{
    totalSeconds: number
    totalBilledUSD: number
    finalBalanceUSD: number
  }> {
    this.stopHeartbeatLoop()

    const activeSessionId = this.sessionId
    this.isActive = false
    this.isStarting = false

    if (!activeSessionId) {
      this.billingState = 'idle'
      return {
        totalSeconds: this.cumulativeSeconds,
        totalBilledUSD: Number((this.billedCents / 100).toFixed(2)),
        finalBalanceUSD: Number((this.currentBalanceCents / 100).toFixed(2)),
      }
    }

    try {
      const {
        data: { session },
      } = await supabase.auth.getSession()

      const token = session?.access_token
      if (token) {
        // Single cloud sync at end of session (not constant)
        await supabase.functions.invoke('session-end', {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: { session_id: activeSessionId },
        })
      }
    } catch (err) {
      console.warn('[sessionBillingService] Failed to sync session end to cloud:', err)
    } finally {
      this.sessionId = null
      this.decartSessionId = null
      this.billingState = 'idle'
      this.lastGenerationTickAt = 0
      this.lastDeductionAt = 0
      this.lowBalanceWarning = false
      this.criticalBalanceWarning = false
      this.exhausted = false
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
