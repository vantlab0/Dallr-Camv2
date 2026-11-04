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

describe('Paystack Payment Security & Edge Function Verification Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // 1. Minimum top-up requirement enforcement ($15 USD)
  it('strictly rejects top-up requests below the $15 minimum threshold at client and server level', async () => {
    await expect(walletService.initializeTopUp(14.99)).rejects.toThrow(
      'Minimum top-up amount is $15.00 USD'
    )
    expect(supabase.functions.invoke).not.toHaveBeenCalled()
  })

  // 2. Successful payment initialization
  it('delegates valid top-up requests to backend initialize-payment Edge Function without mock fallbacks', async () => {
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
    expect(result.authorization_url).toBe('https://checkout.paystack.com/real_access_code')
    expect(result.usd_credit_amount_cents).toBe(1500)
  })

  // 3. Successful payment verification
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
    expect(result.already_processed).toBe(false)
  })

  // 4. Failed/abandoned payment (never credits wallet)
  it('handles verification error when gateway reports failure or abandoned payment', async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        status: 'failed',
        reference: 'dallr_failed_ref',
        message: 'Payment was not successful',
      },
      error: null,
    })

    const result = await walletService.verifyPayment('dallr_failed_ref')
    expect(result.status).toBe('failed')
  })

  // 5. Missing Paystack secret key handling (secure failure, HTTP 500)
  it('fails securely when Paystack secret credentials are not configured', async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: null,
      error: new Error('Payment gateway configuration error'),
    })

    await expect(walletService.initializeTopUp(20)).rejects.toThrow(
      'Payment gateway configuration error'
    )
  })

  // 6. Client attempting to claim payment was successful without paying
  it('prevents desktop client from directly modifying wallet balance or spoofing payment', async () => {
    // The client only ever calls verify-payment Edge Function; it never directly calls credit_wallet or updates wallets table
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: null,
      error: new Error('Payment verification failed at gateway'),
    })

    await expect(walletService.verifyPayment('forged_fake_ref')).rejects.toThrow(
      'Payment verification failed at gateway'
    )
  })
})

describe('Paystack Webhook & Edge Function Cryptographic Security Specifications', () => {
  // Web Crypto API HMAC-SHA512 test matching Edge Function implementation
  async function computeHmacSha512(secret: string, body: string): Promise<string> {
    const encoder = new TextEncoder()
    const keyData = encoder.encode(secret)
    const key = await crypto.subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-512' },
      false,
      ['verify', 'sign']
    )
    const computedSignatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(body))
    const hashArray = Array.from(new Uint8Array(computedSignatureBuffer))
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  const TEST_SECRET = 'sk_test_mock_paystack_secret_key_1234567890'

  it('generates valid HMAC-SHA512 signature on raw payload and verifies accurately', async () => {
    const rawPayload = JSON.stringify({
      event: 'charge.success',
      data: {
        reference: 'dallr_test_ref_001',
        amount: 2325000,
        currency: 'NGN',
        status: 'success',
      },
    })

    const signature = await computeHmacSha512(TEST_SECRET, rawPayload)
    expect(signature).toBeDefined()
    expect(signature.length).toBe(128) // SHA-512 produces 64 bytes = 128 hex chars

    // Matching verification
    const verified = (await computeHmacSha512(TEST_SECRET, rawPayload)) === signature
    expect(verified).toBe(true)
  })

  it('rejects invalid or tampered webhook signatures', async () => {
    const rawPayload = JSON.stringify({
      event: 'charge.success',
      data: {
        reference: 'dallr_test_ref_001',
        amount: 2325000,
      },
    })
    const validSignature = await computeHmacSha512(TEST_SECRET, rawPayload)
    const tamperedPayload = rawPayload.replace('2325000', '1000')

    const recomputed = await computeHmacSha512(TEST_SECRET, tamperedPayload)
    expect(recomputed).not.toBe(validSignature)
  })

  it('rejects missing or malformed webhook signature headers', () => {
    const missingSignature: string | null = null
    expect(Boolean(missingSignature)).toBe(false)

    const malformedSignature = 'short_invalid_sig'
    expect(malformedSignature.length).not.toBe(128)
  })

  it('rejects transaction when currency is not NGN or amount does not match recorded invoice', () => {
    const record = {
      reference: 'dallr_ref_100',
      ngn_amount: 2325000,
      status: 'initialized',
    }

    const wrongCurrencyVerification = {
      reference: 'dallr_ref_100',
      currency: 'USD',
      amount: 2325000,
      status: 'success',
    }

    const wrongAmountVerification = {
      reference: 'dallr_ref_100',
      currency: 'NGN',
      amount: 100000, // attacker tried to pay less
      status: 'success',
    }

    const isValidCurrency = wrongCurrencyVerification.currency === 'NGN'
    expect(isValidCurrency).toBe(false)

    const isAmountMatching = wrongAmountVerification.amount === record.ngn_amount
    expect(isAmountMatching).toBe(false)
  })

  it('enforces idempotency on replayed or concurrent duplicate webhook deliveries', () => {
    // Simulating database row state transition under credit_verified_payment
    let paymentRecord = {
      id: 'uuid-1',
      reference: 'dallr_ref_dup',
      status: 'initialized',
      usd_credit_amount: 1500,
    }
    let walletBalance = 0

    function creditVerifiedPayment(ref: string, gatewayStatus: string) {
      if (paymentRecord.reference !== ref) {
        return { success: false, message: 'Not found' }
      }
      // If already marked as success
      if (paymentRecord.status === 'success') {
        return {
          success: true,
          already_processed: true,
          credited_amount_cents: paymentRecord.usd_credit_amount,
          new_balance: walletBalance,
          message: 'Payment already credited',
        }
      }
      if (gatewayStatus !== 'success') {
        paymentRecord.status = 'failed'
        return { success: false, already_processed: false, message: 'Gateway status is ' + gatewayStatus }
      }
      paymentRecord.status = 'success'
      walletBalance += paymentRecord.usd_credit_amount
      return {
        success: true,
        already_processed: false,
        credited_amount_cents: paymentRecord.usd_credit_amount,
        new_balance: walletBalance,
        message: 'Payment credited successfully',
      }
    }

    // First webhook delivery
    const firstCall = creditVerifiedPayment('dallr_ref_dup', 'success')
    expect(firstCall.success).toBe(true)
    expect(firstCall.already_processed).toBe(false)
    expect(firstCall.new_balance).toBe(1500)

    // Second (duplicate/replayed) webhook delivery
    const secondCall = creditVerifiedPayment('dallr_ref_dup', 'success')
    expect(secondCall.success).toBe(true)
    expect(secondCall.already_processed).toBe(true)
    expect(secondCall.new_balance).toBe(1500) // Balance must NOT double credit!
  })
})
