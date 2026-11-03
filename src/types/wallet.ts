export interface WalletState {
  balanceUSD: number
  exchangeRateUSDToNGN: number
  isLoading: boolean
}

export interface TopUpRequest {
  amountUSD: number
}
