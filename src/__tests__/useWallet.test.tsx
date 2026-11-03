import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useWallet } from '../hooks/useWallet'
import { walletService } from '../services/walletService'

vi.mock('../services/walletService', () => ({
  walletService: {
    getWallet: vi.fn(),
    getTransactions: vi.fn(),
    getExchangeRateConfig: vi.fn(),
    initializeTopUp: vi.fn(),
    verifyPayment: vi.fn(),
  },
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    channel: vi.fn(() => ({
      on: vi.fn().mockReturnThis(),
      subscribe: vi.fn().mockReturnValue({}),
    })),
    removeChannel: vi.fn(),
  },
}))

describe('useWallet hook', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    vi.mocked(walletService.getWallet).mockResolvedValue({
      id: 'wallet-1',
      user_id: 'user-1',
      currency: 'USD',
      balance: 5000,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })

    vi.mocked(walletService.getTransactions).mockResolvedValue([
      {
        id: 'tx-1',
        wallet_id: 'wallet-1',
        user_id: 'user-1',
        type: 'top_up',
        amount: 5000,
        currency: 'USD',
        status: 'completed',
        reference: 'ref-1',
        description: 'Top up',
        created_at: new Date().toISOString(),
      },
    ])

    vi.mocked(walletService.getExchangeRateConfig).mockResolvedValue({
      usd_to_ngn_rate: 1550,
      wallet_currency: 'USD',
      payment_currency: 'NGN',
      minimum_top_up_usd: 15,
      live_usage_rate_per_second_usd: 0.04,
      updated_at: new Date().toISOString(),
    })
  })

  it('loads real wallet data and calculates USD balance accurately', async () => {
    const { result } = renderHook(() => useWallet({ userId: 'user-1' }))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    expect(result.current.balanceUSD).toBe(50)
    expect(result.current.balanceCents).toBe(5000)
    expect(result.current.currency).toBe('USD')
    expect(result.current.transactions).toHaveLength(1)
    expect(result.current.exchangeRateUSDToNGN).toBe(1550)
    expect(result.current.minimumTopUpUSD).toBe(15)
  })

  it('handles payment verification feedback on success', async () => {
    vi.mocked(walletService.verifyPayment).mockResolvedValueOnce({
      status: 'success',
      reference: 'ref-test',
      usd_credit_amount_cents: 2500,
      new_balance: 7500,
    })

    const { result } = renderHook(() => useWallet({ userId: 'user-1' }))

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false)
    })

    await act(async () => {
      await result.current.checkPaymentVerification('ref-test')
    })

    expect(result.current.paymentFeedback?.type).toBe('success')
    expect(result.current.paymentFeedback?.message).toContain('Payment verified!')
  })
})
