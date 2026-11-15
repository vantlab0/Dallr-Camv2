import React, { useState } from 'react'
import { DashboardLayout } from '@/components/dashboard/DashboardLayout'
import { BalanceCard } from '@/components/dashboard/BalanceCard'
import { QuickActionCard } from '@/components/dashboard/QuickActionCard'
import { TopUpModal } from '@/components/wallet/TopUpModal'
import { TransactionHistory } from '@/components/wallet/TransactionHistory'
import { LiveSetupModal } from '@/components/live/LiveSetupModal'
import { CompactLiveStatus } from '@/components/live/CompactLiveStatus'
import { VirtualCameraInstallModal } from '@/components/live/VirtualCameraInstallModal'
import { decartStreamService } from '@/services/decartStreamService'
import { sessionBillingService } from '@/services/sessionBillingService'
import { virtualCameraService, type VirtualCameraStatus } from '@/services/virtualCameraService'
import { useWallet } from '@/hooks/useWallet'
import { Layers, ShieldCheck, Zap } from 'lucide-react'

interface DashboardPageProps {
  userId?: string
  userEmail: string
  displayName?: string
  onSignOut: () => void
  onOpenSettings?: () => void
}

export const DashboardPage: React.FC<DashboardPageProps> = ({
  userId,
  userEmail,
  displayName,
  onSignOut,
  onOpenSettings,
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
    checkPaymentVerification,
    clearFeedback,
  } = useWallet({ userId })

  const [isTopUpOpen, setIsTopUpOpen] = useState(false)
  const [isLiveSetupOpen, setIsLiveSetupOpen] = useState(false)

  // Virtual camera setup prompt (shown on app open if not installed)
  const [isVirtualCamModalOpen, setIsVirtualCamModalOpen] = useState(false)
  const [virtualCamStatus, setVirtualCamStatus] = useState<VirtualCameraStatus | null>(null)

  // Live session status tracking for dashboard
  const [isStreamActive, setIsStreamActive] = useState<boolean>(false)
  const [isConnected, setIsConnected] = useState<boolean>(false)
  const [isEnding, setIsEnding] = useState<boolean>(false)
  const [elapsedSeconds, setElapsedSeconds] = useState<number>(0)
  const [billingBalanceUSD, setBillingBalanceUSD] = useState<number | null>(null)

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
          setBillingBalanceUSD(null)
          void refreshWallet()
        }
      },
      onGenerationTick: (tick) => {
        setElapsedSeconds(tick.seconds)
      },
    })

    sessionBillingService.setListeners({
      onStateChange: (state) => {
        if (state.isActive || state.billingState === 'paused') {
          setBillingBalanceUSD(state.currentBalanceUSD)
        } else if (state.billingState === 'ended' || state.billingState === 'idle') {
          // Keep last known billing balance briefly until DB refresh completes.
          setBillingBalanceUSD((prev) => (state.billedCents > 0 ? state.currentBalanceUSD : prev))
        }
      },
    })

    return () => {}
  }, [refreshWallet])

  const handleEndLiveSession = async () => {
    setIsEnding(true)
    try {
      await decartStreamService.endLiveStream()
      await sessionBillingService.endSession()
    } finally {
      setIsStreamActive(false)
      setIsEnding(false)
      setElapsedSeconds(0)
      setBillingBalanceUSD(null)
      void refreshWallet()
    }
  }

  // Handle application unload / window close cleanup
  React.useEffect(() => {
    const handleBeforeUnload = () => {
      if (sessionBillingService.getState().isActive) {
        void sessionBillingService.endSession()
      }
    }
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }, [])

  // Prompt to install "Dallr Cam" virtual camera on app open if not detected.
  React.useEffect(() => {
    let cancelled = false
    const checkVirtualCamera = async () => {
      try {
        // Small delay to allow device enumeration to settle after startup.
        await new Promise((r) => setTimeout(r, 800))
        const status = await virtualCameraService.getStatus()
        if (!cancelled) {
          setVirtualCamStatus(status)
          if (!status.installed) {
            setIsVirtualCamModalOpen(true)
          }
        }
      } catch {
        // ignore detection errors on startup
      }
    }
    void checkVirtualCamera()
    return () => {
      cancelled = true
    }
  }, [])

  // Output is published to the OS-level "Dallr Cam" virtual camera (no borderless output window).

  const effectiveBalanceUSD = billingBalanceUSD ?? balanceUSD

  return (
    <DashboardLayout
      userEmail={userEmail}
      displayName={displayName}
      onSignOut={onSignOut}
      onOpenSettings={onOpenSettings}
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
            balanceUSD={effectiveBalanceUSD}
            onEndSession={handleEndLiveSession}
          />
        )}

        {/* Main Grid: Balance Card & Quick Action Card */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-1">
            <BalanceCard
              balanceUSD={effectiveBalanceUSD}
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
        onVerifyPayment={checkPaymentVerification}
        exchangeRateUSDToNGN={exchangeRateUSDToNGN}
        minimumTopUpUSD={minimumTopUpUSD}
        userId={userId}
        userEmail={userEmail}
        appUrl={window.location.origin}
      />

      <LiveSetupModal
        isOpen={isLiveSetupOpen}
        userId={userId}
        currentBalanceUSD={effectiveBalanceUSD}
        onClose={() => {
          setIsLiveSetupOpen(false)
          setBillingBalanceUSD(null)
          void refreshWallet()
        }}
        onTopUpClick={() => {
          setIsLiveSetupOpen(false)
          setIsTopUpOpen(true)
        }}
      />

      <VirtualCameraInstallModal
        isOpen={isVirtualCamModalOpen}
        status={virtualCamStatus}
        onClose={() => setIsVirtualCamModalOpen(false)}
        onInstalled={() => {
          setIsVirtualCamModalOpen(false)
        }}
      />
    </DashboardLayout>
  )
}
