import { useState } from 'react'
import { MOCK_WALLET } from '@/lib/mockData'

export function useWallet() {
  const [balanceUSD, setBalanceUSD] = useState<number>(MOCK_WALLET.initialBalanceUSD)
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const exchangeRateUSDToNGN = MOCK_WALLET.exchangeRateUSDToNGN

  const topUp = (amountUSD: number) => {
    setBalanceUSD((prev) => prev + amountUSD)
  }

  const simulateRefresh = () => {
    setIsLoading(true)
    setTimeout(() => {
      setIsLoading(false)
    }, 600)
  }

  return {
    balanceUSD,
    exchangeRateUSDToNGN,
    isLoading,
    topUp,
    simulateRefresh,
  }
}
