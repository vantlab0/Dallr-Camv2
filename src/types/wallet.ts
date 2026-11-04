import type { WalletTransaction } from './database'

export interface WalletState {
  balanceUSD: number
  balanceCents: number
  currency: string
  exchangeRateUSDToNGN: number
  minimumTopUpUSD: number
  liveUsageRatePerSecondUSD: number
  isLoading: boolean
  isProcessing: boolean
  error: string | null
  transactions: WalletTransaction[]
}

export interface TopUpInitResponse {
  reference: string
  authorization_url: string
  access_code: string
  ngn_amount_kobo: number
  usd_credit_amount_cents: number
  exchange_rate_used: number
}

export interface ExchangeRateConfig {
  usd_to_ngn_rate: number
  wallet_currency: string
  payment_currency: string
  minimum_top_up_usd: number
  live_usage_rate_per_second_usd: number
  updated_at: string
}

export interface VerifyPaymentResult {
  status: 'success' | 'failed' | 'abandoned' | 'pending'
  reference: string
  usd_credit_amount_cents?: number
  new_balance?: number
  already_processed?: boolean
  message?: string
}
