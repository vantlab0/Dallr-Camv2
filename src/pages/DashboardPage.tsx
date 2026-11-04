import React, { useState } from 'react'
import { DashboardLayout } from '@/components/dashboard/DashboardLayout'
import { BalanceCard } from '@/components/dashboard/BalanceCard'
import { QuickActionCard } from '@/components/dashboard/QuickActionCard'
import { TopUpModal } from '@/components/wallet/TopUpModal'
import { TransactionHistory } from '@/components/wallet/TransactionHistory'
import { LiveSetupModal } from '@/components/live/LiveSetupModal'
import { CompactLiveStatus } from '@/components/live/CompactLiveStatus'
import { decartStreamService } from '@/services/decartStreamService'
import { videoWindowManager } from '@/services/videoWindowManager'
import { streamRelayService } from '@/services/streamRelayService'
import { useWallet } from '@/hooks/useWallet'
import { Layers, ShieldCheck, Zap } from 'lucide-react'

interface DashboardPageProps {
  userId?: string
  userEmail: string
  displayName?: string
  onSignOut: () => void
}

export const DashboardPage: React.FC<DashboardPageProps> = ({
  userId,
  userEmail,
  displayName,
  onSignOut,
}) => {
  const {
    balanceUSD,
    exchangeRateUSDToNGN,
    minimumTopUpUSD,
    transactions,
    isLoading,
    isProcessing,
    error,
    paymentFeedback,
    refreshWallet,
    startTopUpPayment,
    checkPaymentVerification,
    clearFeedback,
  } = useWallet({ userId })

  const [isTopUpOpen, setIsTopUpOpen] = useState(false)
  const [isLiveSetupOpen, setIsLiveSetupOpen] = useState(false)

  // Live session status tracking for dashboard
  const [isStreamActive, setIsStreamActive] = useState<boolean>(false)
  const [isConnected, setIsConnected] = useState<boolean>(false)
  const [isEnding, setIsEnding] = useState<boolean>(false)
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0)
  const [isOutputWindowOpen, setIsOutputWindowOpen] = useState<boolean>(false)

  const checkOutputWindow = React.useCallback(async () => {
    const open = await videoWindowManager.isWindowOpen()
    setIsOutputWindowOpen(open)
  }, [])

  React.useEffect(() => {
    decartStreamService.setListeners({
      onStateChange: (state) => {
        setIsConnected(state === 'connected')
        setIsStreamActive(state === 'connected' || state === 'connecting' || state === 'reconnecting')
        setIsEnding(state === 'ending')
        if (state === 'ended' || state === 'failed') {
          setIsStreamActive(false)
          setIsConnected(false)
          setIsEnding(false)
          setElapsedSeconds(0)
          void refreshWallet()
        }
      },
      onGenerationTick: (tick) => {
        setElapsedSeconds(tick.seconds)
      },
    })

    const interval = setInterval(() => {
      void checkOutputWindow()
    }, 1000)

    return () => {
      clearInterval(interval)
    }
  }, [checkOutputWindow, refreshWallet])

  const handleEndLiveSession = async () => {
    setIsEnding(true)
    try {
      streamRelayService.notifySessionEnded()
      await videoWindowManager.closeVideoWindow()
      await decartStreamService.endLiveStream()
    } finally {
      setIsStreamActive(false)
      setIsEnding(false)
      setIsOutputWindowOpen(false)
      setElapsedSeconds(0)
      void refreshWallet()
    }
  }

  const handleReopenOutputWindow = async () => {
    await videoWindowManager.openVideoWindow({
      onClose: () => {
        void handleEndLiveSession()
      },
    })
    setIsOutputWindowOpen(true)
    const remoteStream = decartStreamService.getRemoteStream()
    if (remoteStream) {
      streamRelayService.startBroadcasting(remoteStream)
    }
  }

  const handleFocusOutputWindow = async () => {
    await videoWindowManager.focusVideoWindow()
  }

  return (
    <DashboardLayout
      userEmail={userEmail}
      displayName={displayName}
      onSignOut={onSignOut}
    >
      <div className="space-y-8">
        {/* Welcome Section */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-[#f4f4f5]">
              Studio Dashboard
            </h1>
            <p className="text-xs text-[#a1a1aa] mt-1">
              Welcome back{displayName ? `, ${displayName}` : ''}. Manage your streaming wallet and initialize real-time live video calls.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="px-3 py-1.5 rounded-lg bg-[#121215] border border-[#27272a] text-xs text-[#a1a1aa] flex items-center gap-2">
              <Zap className="w-3.5 h-3.5 text-[#ef4444]" />
              <span>Decart Engine: Standby</span>
            </div>
          </div>
        </div>

        {/* COMPACT LIVE STATUS BAR (Visible when streaming) */}
        {isStreamActive && (
          <CompactLiveStatus
            isConnected={isConnected}
            isEnding={isEnding}
            elapsedSeconds={elapsedSeconds}
            balanceUSD={balanceUSD}
            isOutputWindowOpen={isOutputWindowOpen}
            onReopenOutputWindow={handleReopenOutputWindow}
            onFocusOutputWindow={handleFocusOutputWindow}
            onEndSession={handleEndLiveSession}
          />
        )}

        {/* Main Grid: Balance Card & Quick Action Card */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-1">
            <BalanceCard
              balanceUSD={balanceUSD}
              isLoading={isLoading}
              isProcessing={isProcessing}
              error={error}
              paymentFeedback={paymentFeedback}
              onTopUpClick={() => setIsTopUpOpen(true)}
              onRefresh={refreshWallet}
              onClearFeedback={clearFeedback}
            />
          </div>
          <div className="md:col-span-2">
            <QuickActionCard onStartCall={() => setIsLiveSetupOpen(true)} />
          </div>
        </div>

        {/* Transaction History Ledger */}
        <TransactionHistory transactions={transactions} isLoading={isLoading} />

        {/* Additional Studio Meta / System Specs Card */}
        <div className="rounded-xl border border-[#27272a] bg-[#121215]/50 p-5">
          <div className="flex items-center gap-2 mb-3 text-xs font-semibold text-[#a1a1aa] uppercase tracking-wider">
            <Layers className="w-4 h-4 text-[#ef4444]" />
            <span>Studio Environment Status</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
            <div className="p-3 rounded-lg bg-[#16161b] border border-[#27272a]">
              <span className="text-[#71717a] block text-[11px]">Desktop Target</span>
              <span className="font-medium text-[#e4e4e7] mt-0.5 block">Windows & macOS (Tauri 2)</span>
            </div>
            <div className="p-3 rounded-lg bg-[#16161b] border border-[#27272a]">
              <span className="text-[#71717a] block text-[11px]">Billing Engine</span>
              <span className="font-medium text-[#e4e4e7] mt-0.5 block">USD Wallet ($0.04/s usage)</span>
            </div>
            <div className="p-3 rounded-lg bg-[#16161b] border border-[#27272a]">
              <span className="text-[#71717a] block text-[11px]">Security Protocol</span>
              <span className="font-medium text-emerald-400 mt-0.5 flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5" />
                Row Level Security (Supabase)
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      <TopUpModal
        isOpen={isTopUpOpen}
        onClose={() => setIsTopUpOpen(false)}
        onInitiatePayment={startTopUpPayment}
        onVerifyPayment={checkPaymentVerification}
        exchangeRateUSDToNGN={exchangeRateUSDToNGN}
        minimumTopUpUSD={minimumTopUpUSD}
      />

      <LiveSetupModal
        isOpen={isLiveSetupOpen}
        userId={userId}
        currentBalanceUSD={balanceUSD}
        onClose={() => setIsLiveSetupOpen(false)}
        onTopUpClick={() => {
          setIsLiveSetupOpen(false)
          setIsTopUpOpen(true)
        }}
      />
    </DashboardLayout>
  )
}
