import React, { useState } from 'react'
import { DashboardLayout } from '@/components/dashboard/DashboardLayout'
import { BalanceCard } from '@/components/dashboard/BalanceCard'
import { QuickActionCard } from '@/components/dashboard/QuickActionCard'
import { TopUpModal } from '@/components/wallet/TopUpModal'
import { LiveSetupModal } from '@/components/live/LiveSetupModal'
import { useWallet } from '@/hooks/useWallet'
import { Layers, ShieldCheck, Zap } from 'lucide-react'

interface DashboardPageProps {
  userEmail: string
  onSignOut: () => void
}

export const DashboardPage: React.FC<DashboardPageProps> = ({
  userEmail,
  onSignOut,
}) => {
  const { balanceUSD, exchangeRateUSDToNGN, isLoading, topUp, simulateRefresh } = useWallet()
  const [isTopUpOpen, setIsTopUpOpen] = useState(false)
  const [isLiveSetupOpen, setIsLiveSetupOpen] = useState(false)

  return (
    <DashboardLayout userEmail={userEmail} onSignOut={onSignOut}>
      <div className="space-y-8">
        {/* Welcome Section */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-[#f4f4f5]">
              Studio Dashboard
            </h1>
            <p className="text-xs text-[#a1a1aa] mt-1">
              Manage your streaming wallet and initialize real-time live video calls.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="px-3 py-1.5 rounded-lg bg-[#121215] border border-[#27272a] text-xs text-[#a1a1aa] flex items-center gap-2">
              <Zap className="w-3.5 h-3.5 text-[#ef4444]" />
              <span>Decart Engine: Standby</span>
            </div>
          </div>
        </div>

        {/* Main Grid: Balance Card & Quick Action Card */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="md:col-span-1">
            <BalanceCard
              balanceUSD={balanceUSD}
              isLoading={isLoading}
              onTopUpClick={() => setIsTopUpOpen(true)}
              onRefresh={simulateRefresh}
            />
          </div>
          <div className="md:col-span-2">
            <QuickActionCard onStartCall={() => setIsLiveSetupOpen(true)} />
          </div>
        </div>

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
              <span className="text-[#71717a] block text-[11px]">Stream Architecture</span>
              <span className="font-medium text-[#e4e4e7] mt-0.5 block">Client-side WebRTC Pipeline</span>
            </div>
            <div className="p-3 rounded-lg bg-[#16161b] border border-[#27272a]">
              <span className="text-[#71717a] block text-[11px]">Security Protocol</span>
              <span className="font-medium text-emerald-400 mt-0.5 flex items-center gap-1">
                <ShieldCheck className="w-3.5 h-3.5" />
                End-to-End Isolated
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Modals */}
      <TopUpModal
        isOpen={isTopUpOpen}
        onClose={() => setIsTopUpOpen(false)}
        onSuccess={(amount) => topUp(amount)}
        exchangeRateUSDToNGN={exchangeRateUSDToNGN}
      />

      <LiveSetupModal
        isOpen={isLiveSetupOpen}
        onClose={() => setIsLiveSetupOpen(false)}
      />
    </DashboardLayout>
  )
}
