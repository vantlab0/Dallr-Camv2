import { describe, it, expect, beforeEach, vi } from 'vitest'
import { liveSessionService } from '@/services/liveSessionService'
import { walletService } from '@/services/walletService'
import { promptManager, DEFAULT_TRANSFORMATION_PROMPT } from '@/config/prompts'
import type { PreparedImageReference } from '@/types/live'

describe('liveSessionService', () => {
  const dummyImage: PreparedImageReference = {
    file: new File([''], 'avatar.png', { type: 'image/png' }),
    name: 'avatar.png',
    size: 2048,
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,abc1234',
    base64Data: 'abc1234',
    width: 640,
    height: 480,
    aspectRatio: 640 / 480,
  }

  beforeEach(() => {
    vi.restoreAllMocks()
    promptManager.resetPrompt()
  })

  it('fails validation when reference image is missing', async () => {
    const result = await liveSessionService.validateSessionEligibility({
      userId: 'user-123',
      referenceImage: null,
    })

    expect(result.isValid).toBe(false)
    expect(result.errorCode).toBe('NO_IMAGE')
    expect(result.errorMessage).toContain('A reference portrait image must be selected')
  })

  it('fails validation when user is unauthenticated', async () => {
    const result = await liveSessionService.validateSessionEligibility({
      userId: null,
      referenceImage: dummyImage,
    })

    expect(result.isValid).toBe(false)
    expect(result.errorCode).toBe('UNAUTHENTICATED')
    expect(result.errorMessage).toContain('You must be signed in')
  })

  it('fails validation when user wallet is not found', async () => {
    vi.spyOn(walletService, 'getWallet').mockResolvedValue(null)
    vi.spyOn(walletService, 'getExchangeRateConfig').mockResolvedValue({
      usd_to_ngn_rate: 1550,
      wallet_currency: 'USD',
      payment_currency: 'NGN',
      minimum_top_up_usd: 15,
      live_usage_rate_per_second_usd: 0.04,
      updated_at: new Date().toISOString(),
    })

    const result = await liveSessionService.validateSessionEligibility({
      userId: 'user-123',
      referenceImage: dummyImage,
    })

    expect(result.isValid).toBe(false)
    expect(result.errorCode).toBe('WALLET_NOT_FOUND')
  })

  it('fails validation when wallet balance is insufficient for live streaming rate', async () => {
    vi.spyOn(walletService, 'getWallet').mockResolvedValue({
      id: 'wallet-1',
      user_id: 'user-123',
      currency: 'USD',
      balance: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    vi.spyOn(walletService, 'getExchangeRateConfig').mockResolvedValue({
      usd_to_ngn_rate: 1550,
      wallet_currency: 'USD',
      payment_currency: 'NGN',
      minimum_top_up_usd: 15,
      live_usage_rate_per_second_usd: 0.04,
      updated_at: new Date().toISOString(),
    })

    const result = await liveSessionService.validateSessionEligibility({
      userId: 'user-123',
      referenceImage: dummyImage,
    })

    expect(result.isValid).toBe(false)
    expect(result.errorCode).toBe('INSUFFICIENT_BALANCE')
    expect(result.errorMessage).toContain('Insufficient wallet balance')
    expect(result.currentBalanceUSD).toBe(0)
  })

  it('passes validation when user has sufficient wallet balance', async () => {
    vi.spyOn(walletService, 'getWallet').mockResolvedValue({
      id: 'wallet-1',
      user_id: 'user-123',
      currency: 'USD',
      balance: 1500,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    vi.spyOn(walletService, 'getExchangeRateConfig').mockResolvedValue({
      usd_to_ngn_rate: 1550,
      wallet_currency: 'USD',
      payment_currency: 'NGN',
      minimum_top_up_usd: 15,
      live_usage_rate_per_second_usd: 0.04,
      updated_at: new Date().toISOString(),
    })

    const result = await liveSessionService.validateSessionEligibility({
      userId: 'user-123',
      referenceImage: dummyImage,
    })

    expect(result.isValid).toBe(true)
    expect(result.currentBalanceUSD).toBe(15)
    expect(result.currentBalanceCents).toBe(1500)
  })

  it('prepares live session payload with custom or default transformation prompt', async () => {
    vi.spyOn(walletService, 'getWallet').mockResolvedValue({
      id: 'wallet-1',
      user_id: 'user-123',
      currency: 'USD',
      balance: 2000,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    vi.spyOn(walletService, 'getExchangeRateConfig').mockResolvedValue({
      usd_to_ngn_rate: 1550,
      wallet_currency: 'USD',
      payment_currency: 'NGN',
      minimum_top_up_usd: 15,
      live_usage_rate_per_second_usd: 0.04,
      updated_at: new Date().toISOString(),
    })

    const session = await liveSessionService.prepareSession({
      userId: 'user-123',
      referenceImage: dummyImage,
    })

    expect(session.sessionId).toContain('live_user-123_')
    expect(session.prompt).toBe(DEFAULT_TRANSFORMATION_PROMPT)
    expect(session.initialBalanceUSD).toBe(20)
    expect(session.ratePerSecondUSD).toBe(0.04)
    expect(session.referenceImage).toEqual(dummyImage)
  })

  it('supports cancellation during preparation via AbortSignal', async () => {
    vi.spyOn(walletService, 'getWallet').mockResolvedValue({
      id: 'wallet-1',
      user_id: 'user-123',
      currency: 'USD',
      balance: 2000,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    vi.spyOn(walletService, 'getExchangeRateConfig').mockResolvedValue({
      usd_to_ngn_rate: 1550,
      wallet_currency: 'USD',
      payment_currency: 'NGN',
      minimum_top_up_usd: 15,
      live_usage_rate_per_second_usd: 0.04,
      updated_at: new Date().toISOString(),
    })

    const controller = new AbortController()
    controller.abort()

    await expect(
      liveSessionService.prepareSession({
        userId: 'user-123',
        referenceImage: dummyImage,
        signal: controller.signal,
      })
    ).rejects.toThrow('Live session preparation cancelled')
  })
})
