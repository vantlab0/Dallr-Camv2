import { useState, useEffect, useCallback } from 'react'
import { walletService } from '@/services/walletService'
import { supabase } from '@/lib/supabase'
import type { WalletTransaction } from '@/types/database'

interface UseWalletOptions {
  userId?: string
}

export function useWallet(options?: UseWalletOptions) {
  const userId = options?.userId

  const [balanceUSD, setBalanceUSD] = useState<number>(0)
  const [balanceCents, setBalanceCents] = useState<number>(0)
  const [currency, setCurrency] = useState<string>('USD')
  const [exchangeRateUSDToNGN, setExchangeRateUSDToNGN] = useState<number>(1550)
  const [minimumTopUpUSD, setMinimumTopUpUSD] = useState<number>(15)
  const [liveUsageRatePerSecondUSD, setLiveUsageRatePerSecondUSD] = useState<number>(0.04)

  const [transactions, setTransactions] = useState<WalletTransaction[]>([])
  const [isLoading, setIsLoading] = useState<boolean>(true)
  const [isProcessing, setIsProcessing] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [paymentFeedback, setPaymentFeedback] = useState<{
    type: 'success' | 'error'
    message: string
  } | null>(null)

  // 1. Fetch wallet, transactions, and exchange rate configuration
  const loadWalletData = useCallback(async () => {
    if (!userId) {
      setIsLoading(false)
      return
    }

    try {
      setError(null)
      const [walletData, txData, config] = await Promise.all([
        walletService.getWallet(userId),
        walletService.getTransactions(userId),
        walletService.getExchangeRateConfig(),
      ])

      if (walletData) {
        setBalanceCents(walletData.balance)
        // Convert integer cents to USD for display without precision drift
        setBalanceUSD(walletData.balance / 100)
        setCurrency(walletData.currency)
      } else {
        setBalanceCents(0)
        setBalanceUSD(0)
      }

      setTransactions(txData)
      setExchangeRateUSDToNGN(config.usd_to_ngn_rate)
      setMinimumTopUpUSD(config.minimum_top_up_usd)
      setLiveUsageRatePerSecondUSD(config.live_usage_rate_per_second_usd)
    } catch (err) {
      console.error('Failed to load wallet data:', err)
      setError(err instanceof Error ? err.message : 'Could not fetch wallet data')
    } finally {
      setIsLoading(false)
    }
  }, [userId])

  useEffect(() => {
    let isMounted = true
    const run = async () => {
      try {
        setIsLoading(true)
        setError(null)

        const [rateConfig, userWallet] = await Promise.all([
          walletService.getExchangeRateConfig(),
          userId ? walletService.getWallet(userId) : Promise.resolve(null),
        ])

        if (!isMounted) return

        if (rateConfig) {
          setExchangeRateUSDToNGN(rateConfig.usd_to_ngn_rate)
          setMinimumTopUpUSD(rateConfig.minimum_top_up_usd)
        }

        if (userWallet) {
          setBalanceCents(userWallet.balance)
          setBalanceUSD(userWallet.balance / 100)
        } else if (userId) {
          setBalanceCents(0)
          setBalanceUSD(0)
        }

        if (userId) {
          const txs = await walletService.getTransactions(userId, 20)
          if (isMounted) setTransactions(txs)
        }
      } catch (err: unknown) {
        if (!isMounted) return
        const message = err instanceof Error ? err.message : 'Failed to load wallet data'
        console.error('Wallet data error:', message)
        setError(message)
      } finally {
        if (isMounted) setIsLoading(false)
      }
    }
    void run()
    return () => {
      isMounted = false
    }
  }, [userId])

  // 2. Supabase Realtime Subscription: auto-updates balance & transactions
  useEffect(() => {
    if (!userId) return

    const walletChannel = supabase
      .channel(`wallet_changes_${userId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'wallets',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (payload.new && 'balance' in payload.new) {
            const newCents = (payload.new as { balance: number }).balance
            setBalanceCents(newCents)
            setBalanceUSD(newCents / 100)
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'wallet_transactions',
          filter: `user_id=eq.${userId}`,
        },
        (payload) => {
          if (payload.new) {
            setTransactions((prev) => [payload.new as WalletTransaction, ...prev])
          }
        }
      )
      .subscribe()

    return () => {
      void supabase.removeChannel(walletChannel)
    }
  }, [userId])

  // 3. Manual refresh
  const refreshWallet = async () => {
    setIsLoading(true)
    await loadWalletData()
  }

  // 4. Verify Payment Status & Update Wallet Feedback
  const checkPaymentVerification = async (reference: string) => {
    setIsProcessing(true)
    try {
      const result = await walletService.verifyPayment(reference)
      if (result.status === 'success') {
        setPaymentFeedback({
          type: 'success',
          message: 'Payment verified! Your USD wallet balance has been credited.',
        })
        await loadWalletData()
      } else if (result.status === 'failed' || result.status === 'abandoned') {
        setPaymentFeedback({
          type: 'error',
          message: result.message || 'Payment was unsuccessful or abandoned.',
        })
      }
      return result
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Verification failed'
      setPaymentFeedback({ type: 'error', message: msg })
      throw err
    } finally {
      setIsProcessing(false)
    }
  }

  const clearFeedback = () => setPaymentFeedback(null)

  return {
    balanceUSD,
    balanceCents,
    currency,
    exchangeRateUSDToNGN,
    minimumTopUpUSD,
    liveUsageRatePerSecondUSD,
    transactions,
    isLoading,
    isProcessing,
    error,
    paymentFeedback,
    refreshWallet,
    checkPaymentVerification,
    clearFeedback,
  }
}
