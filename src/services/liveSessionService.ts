import { walletService } from '@/services/walletService'
import { promptManager } from '@/config/prompts'
import type {
  PreparedImageReference,
  PreparedLiveSession,
  LiveSessionValidationResult,
} from '@/types/live'

export interface ValidateSessionEligibilityOptions {
  userId?: string | null
  referenceImage: PreparedImageReference | null
  requiredSeconds?: number
}

export interface PrepareSessionOptions {
  userId: string
  referenceImage: PreparedImageReference
  prompt?: string
  signal?: AbortSignal
}

export const liveSessionService = {
  /**
   * Pre-flight validation prior to initializing Decart live streaming.
   * Checks:
   * 1. Reference image is selected.
   * 2. User is authenticated.
   * 3. Fresh wallet balance is retrieved from backend.
   * 4. Wallet has sufficient balance for live streaming (at least requiredSeconds * ratePerSecond, default 1 second).
   * Does NOT charge the user.
   */
  async validateSessionEligibility(
    options: ValidateSessionEligibilityOptions
  ): Promise<LiveSessionValidationResult> {
    const { userId, referenceImage, requiredSeconds = 1 } = options

    // 1. Reference image validation
    if (!referenceImage) {
      return {
        isValid: false,
        errorCode: 'NO_IMAGE',
        errorMessage: 'A reference portrait image must be selected before starting the live video call.',
      }
    }

    // 2. Authentication check
    if (!userId || !userId.trim()) {
      return {
        isValid: false,
        errorCode: 'UNAUTHENTICATED',
        errorMessage: 'You must be signed in to configure and start a live video call.',
      }
    }

    // 3. Fetch fresh wallet balance and rate configuration
    try {
      const [wallet, config] = await Promise.all([
        walletService.getWallet(userId),
        walletService.getExchangeRateConfig(),
      ])

      const ratePerSec = config.live_usage_rate_per_second_usd || 0.04
      const requiredUsd = requiredSeconds * ratePerSec
      const requiredCents = Math.round(requiredUsd * 100)

      if (!wallet) {
        return {
          isValid: false,
          errorCode: 'WALLET_NOT_FOUND',
          errorMessage: 'USD wallet not found. Please reload or initialize your wallet.',
          currentBalanceUSD: 0,
          currentBalanceCents: 0,
          requiredBalanceUSD: requiredUsd,
        }
      }

      const balanceCents = wallet.balance
      const balanceUSD = balanceCents / 100

      // 4. Sufficient balance check
      if (balanceCents < requiredCents) {
        return {
          isValid: false,
          errorCode: 'INSUFFICIENT_BALANCE',
          errorMessage: `Insufficient wallet balance. You have $${balanceUSD.toFixed(2)} USD, but at least $${requiredUsd.toFixed(2)} USD is required to start live streaming ($${ratePerSec.toFixed(2)}/sec). Please top up your wallet.`,
          currentBalanceUSD: balanceUSD,
          currentBalanceCents: balanceCents,
          requiredBalanceUSD: requiredUsd,
        }
      }

      return {
        isValid: true,
        currentBalanceUSD: balanceUSD,
        currentBalanceCents: balanceCents,
        requiredBalanceUSD: requiredUsd,
      }
    } catch (err) {
      console.error('Error validating live session eligibility:', err)
      return {
        isValid: false,
        errorCode: 'FETCH_ERROR',
        errorMessage: err instanceof Error ? err.message : 'Unable to verify wallet balance with server.',
      }
    }
  },

  /**
   * Prepares the session data structure for Decart SDK initialization.
   * Handles cancellation via AbortSignal.
   * Does NOT fake Decart connection or charge user.
   */
  async prepareSession(options: PrepareSessionOptions): Promise<PreparedLiveSession> {
    const { userId, referenceImage, prompt, signal } = options

    if (signal?.aborted) {
      throw new DOMException('Live session preparation cancelled', 'AbortError')
    }

    const validation = await this.validateSessionEligibility({
      userId,
      referenceImage,
    })

    if (signal?.aborted) {
      throw new DOMException('Live session preparation cancelled', 'AbortError')
    }

    if (!validation.isValid) {
      throw new Error(validation.errorMessage || 'Session validation failed')
    }

    const config = await walletService.getExchangeRateConfig()
    if (signal?.aborted) {
      throw new DOMException('Live session preparation cancelled', 'AbortError')
    }

    const finalPrompt = prompt?.trim() || promptManager.getActivePrompt()
    const sessionId = `live_${userId.slice(0, 8)}_${Date.now()}`

    return {
      sessionId,
      userId,
      referenceImage,
      prompt: finalPrompt,
      ratePerSecondUSD: config.live_usage_rate_per_second_usd || 0.04,
      initialBalanceUSD: validation.currentBalanceUSD ?? 0,
      initialBalanceCents: validation.currentBalanceCents ?? 0,
      preparedAt: new Date().toISOString(),
    }
  },
}
