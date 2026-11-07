import { supabase } from '@/lib/supabase'
import type { Wallet, WalletTransaction, PaymentRecord } from '@/types/database'
import type { ExchangeRateConfig, VerifyPaymentResult } from '@/types/wallet'

const DEFAULT_USD_TO_NGN_RATE = 1550
const DEFAULT_MINIMUM_TOP_UP_USD = 15
const DEFAULT_LIVE_USAGE_PER_SEC_USD = 0.04

export const walletService = {
  /**
   * Fetch user's USD wallet.
   * If not yet created (e.g. before trigger execution), returns null.
   */
  async getWallet(userId: string): Promise<Wallet | null> {
    const { data, error } = await supabase
      .from('wallets')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) {
      console.error('Error fetching wallet:', error)
      throw error
    }

    return data
  },

  /**
   * Fetch wallet transactions ordered by creation date descending
   */
  async getTransactions(userId: string, limit = 20): Promise<WalletTransaction[]> {
    const { data, error } = await supabase
      .from('wallet_transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      console.error('Error fetching transactions:', error)
      throw error
    }

    return data || []
  },

  /**
   * Fetch payment records
   */
  async getPaymentRecords(userId: string, limit = 10): Promise<PaymentRecord[]> {
    const { data, error } = await supabase
      .from('payment_records')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(limit)

    if (error) {
      console.error('Error fetching payment records:', error)
      throw error
    }

    return data || []
  },

  /**
   * Fetch trusted exchange rate & business config from backend Edge Function
   */
  async getExchangeRateConfig(): Promise<ExchangeRateConfig> {
    try {
      const { data, error } = await supabase.functions.invoke<ExchangeRateConfig>('get-exchange-rate')

      if (error || !data) {
        return {
          usd_to_ngn_rate: DEFAULT_USD_TO_NGN_RATE,
          wallet_currency: 'USD',
          payment_currency: 'NGN',
          minimum_top_up_usd: DEFAULT_MINIMUM_TOP_UP_USD,
          live_usage_rate_per_second_usd: DEFAULT_LIVE_USAGE_PER_SEC_USD,
          updated_at: new Date().toISOString(),
        }
      }

      return data
    } catch {
      return {
        usd_to_ngn_rate: DEFAULT_USD_TO_NGN_RATE,
        wallet_currency: 'USD',
        payment_currency: 'NGN',
        minimum_top_up_usd: DEFAULT_MINIMUM_TOP_UP_USD,
        live_usage_rate_per_second_usd: DEFAULT_LIVE_USAGE_PER_SEC_USD,
        updated_at: new Date().toISOString(),
      }
    }
  },

  /**
   * Verify a payment reference via the secure backend Edge Function.
   * Backend uses PAYSTACK_SECRET_KEY to verify and invoke credit_verified_payment.
   */
  async verifyPayment(reference: string): Promise<VerifyPaymentResult> {
    const { data, error } = await supabase.functions.invoke<VerifyPaymentResult>('verify-payment', {
      body: { reference },
    })

    if (error || !data) {
      throw new Error(error?.message || 'Failed to verify payment status')
    }

    return data
  },
}
