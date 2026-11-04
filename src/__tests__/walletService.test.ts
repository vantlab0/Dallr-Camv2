import { describe, it, expect, vi, beforeEach } from 'vitest'
import { walletService } from '../services/walletService'
import { supabase } from '../lib/supabase'

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    functions: {
      invoke: vi.fn(),
    },
  },
  isSupabaseConfigured: true,
}))

describe('walletService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('getWallet', () => {
    it('fetches existing USD wallet for user', async () => {
      const mockWallet = {
        id: 'w-123',
        user_id: 'usr-456',
        currency: 'USD',
        balance: 2500, // $25.00
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }

      vi.mocked(supabase.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: mockWallet, error: null }),
      } as any)

      const wallet = await walletService.getWallet('usr-456')
      expect(wallet?.balance).toBe(2500)
      expect(wallet?.currency).toBe('USD')
    })
  })

  describe('getTransactions', () => {
    it('fetches transaction ledger for user ordered by created_at descending', async () => {
      const mockTransactions = [
        {
          id: 'tx-1',
          wallet_id: 'w-123',
          user_id: 'usr-456',
          type: 'top_up',
          amount: 2500,
          currency: 'USD',
          status: 'completed',
          reference: 'ref-1',
          description: 'Top up',
          created_at: new Date().toISOString(),
        },
      ]

      vi.mocked(supabase.from).mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: mockTransactions, error: null }),
      } as any)

      const txs = await walletService.getTransactions('usr-456')
      expect(txs).toHaveLength(1)
      expect(txs[0].amount).toBe(2500)
    })
  })

  describe('initializeTopUp', () => {
    it('enforces minimum $15 top-up check before calling backend', async () => {
      await expect(walletService.initializeTopUp(14.99)).rejects.toThrow(
        'Minimum top-up amount is $15.00 USD'
      )
      expect(supabase.functions.invoke).not.toHaveBeenCalled()
    })

    it('invokes initialize-payment edge function for valid top-up', async () => {
      const mockResponse = {
        reference: 'dallr_ref_123',
        authorization_url: 'https://checkout.paystack.com/access123',
        access_code: 'access123',
        ngn_amount_kobo: 3875000,
        usd_credit_amount_cents: 2500,
        exchange_rate_used: 1550,
      }

      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: mockResponse,
        error: null,
      } as any)

      const res = await walletService.initializeTopUp(25)
      expect(supabase.functions.invoke).toHaveBeenCalledWith('initialize-payment', {
        body: {
          amount_usd: 25,
          callback_url: undefined,
        },
      })
      expect(res.reference).toBe('dallr_ref_123')
      expect(res.authorization_url).toBe('https://checkout.paystack.com/access123')
    })
  })

  describe('verifyPayment', () => {
    it('invokes verify-payment edge function with payment reference', async () => {
      const mockVerification = {
        status: 'success',
        reference: 'dallr_ref_123',
        usd_credit_amount_cents: 2500,
        new_balance: 5000,
      }

      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: mockVerification,
        error: null,
      } as any)

      const res = await walletService.verifyPayment('dallr_ref_123')
      expect(supabase.functions.invoke).toHaveBeenCalledWith('verify-payment', {
        body: { reference: 'dallr_ref_123' },
      })
      expect(res.status).toBe('success')
    })
  })

  describe('getExchangeRateConfig', () => {
    it('returns server-supplied exchange rate config or safe defaults', async () => {
      vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
        data: {
          usd_to_ngn_rate: 1600,
          wallet_currency: 'USD',
          payment_currency: 'NGN',
          minimum_top_up_usd: 15,
          live_usage_rate_per_second_usd: 0.04,
          updated_at: new Date().toISOString(),
        },
        error: null,
      } as any)

      const config = await walletService.getExchangeRateConfig()
      expect(config.usd_to_ngn_rate).toBe(1600)
      expect(config.minimum_top_up_usd).toBe(15)
    })
  })
})
