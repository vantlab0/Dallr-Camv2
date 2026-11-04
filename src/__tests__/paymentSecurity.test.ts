import { describe, it, expect, vi, beforeEach } from 'vitest'
import { walletService } from '@/services/walletService'
import { supabase } from '@/lib/supabase'

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: vi.fn(),
    functions: {
      invoke: vi.fn(),
    },
  },
}))

describe('Paystack Payment Security & Verification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('strictly rejects top-up requests below the $15 minimum threshold', async () => {
    await expect(walletService.initializeTopUp(14.99)).rejects.toThrow(
      'Minimum top-up amount is $15.00 USD'
    )
    expect(supabase.functions.invoke).not.toHaveBeenCalled()
  })

  it('delegates valid top-up requests to backend initialize-payment Edge Function', async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        reference: 'dallr_test_12345',
        authorization_url: 'https://checkout.paystack.com/real_access_code',
        access_code: 'real_access_code',
        ngn_amount_kobo: 2325000,
        usd_credit_amount_cents: 1500,
        exchange_rate_used: 1550,
      },
      error: null,
    })

    const result = await walletService.initializeTopUp(15)
    expect(supabase.functions.invoke).toHaveBeenCalledWith('initialize-payment', {
      body: {
        amount_usd: 15,
        callback_url: undefined,
      },
    })
    expect(result.reference).toBe('dallr_test_12345')
    expect(result.usd_credit_amount_cents).toBe(1500)
  })

  it('delegates payment verification directly to backend verify-payment Edge Function', async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        status: 'success',
        reference: 'dallr_test_12345',
        usd_credit_amount_cents: 1500,
        new_balance: 1500,
        already_processed: false,
      },
      error: null,
    })

    const result = await walletService.verifyPayment('dallr_test_12345')
    expect(supabase.functions.invoke).toHaveBeenCalledWith('verify-payment', {
      body: { reference: 'dallr_test_12345' },
    })
    expect(result.status).toBe('success')
    expect(result.new_balance).toBe(1500)
  })

  it('handles verification error when gateway reports failure', async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: null,
      error: new Error('Payment verification request failed'),
    })

    await expect(walletService.verifyPayment('dallr_bad_ref')).rejects.toThrow(
      'Payment verification request failed'
    )
  })
})
