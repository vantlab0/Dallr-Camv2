import React from 'react'
import { Wallet, Plus, RefreshCw, AlertCircle, CheckCircle } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { formatUSD } from '@/lib/utils'

interface BalanceCardProps {
  balanceUSD: number
  isLoading: boolean
  isProcessing?: boolean
  error?: string | null
  paymentFeedback?: {
    type: 'success' | 'error'
    message: string
  } | null
  onTopUpClick: () => void
  onRefresh?: () => void
  onClearFeedback?: () => void
}

export const BalanceCard: React.FC<BalanceCardProps> = ({
  balanceUSD,
  isLoading,
  isProcessing,
  error,
  paymentFeedback,
  onTopUpClick,
  onRefresh,
  onClearFeedback,
}) => {
  return (
    <div className="relative overflow-hidden rounded-xl bg-[#121215] border border-[#27272a] p-6 shadow-xl flex flex-col justify-between">
      {/* Top Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-[#1a1a1f] border border-[#27272a] flex items-center justify-center text-[#a1a1aa]">
            <Wallet className="w-4 h-4" />
          </div>
          <div>
            <span className="text-xs font-medium text-[#a1a1aa] tracking-wide uppercase">
              Available Balance
            </span>
            <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-[#1a1a1f] text-[#71717a] border border-[#27272a]">
              USD
            </span>
          </div>
        </div>
        {onRefresh && (
          <button
            onClick={onRefresh}
            disabled={isLoading || isProcessing}
            className="text-[#71717a] hover:text-[#d4d4d8] p-1.5 rounded-lg hover:bg-[#1a1a1f] transition-colors cursor-pointer disabled:opacity-50"
            title="Refresh balance"
            aria-label="Refresh balance"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading || isProcessing ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>

      {/* Main Balance Display */}
      <div className="my-5">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-9 w-36" />
            <Skeleton className="h-4 w-24" />
          </div>
        ) : (
          <div>
            <div className="text-3xl font-bold tracking-tight text-[#f4f4f5] flex items-baseline">
              <span>{formatUSD(balanceUSD)}</span>
            </div>
            <p className="text-xs text-[#71717a] mt-1">Live video usage: $0.04 per second</p>
          </div>
        )}
      </div>

      {/* Payment Feedback Banner */}
      {paymentFeedback && (
        <div
          className={`mb-4 p-2.5 rounded-lg text-xs flex items-start gap-2 border ${
            paymentFeedback.type === 'success'
              ? 'bg-emerald-950/40 border-emerald-800 text-emerald-300'
              : 'bg-red-950/40 border-red-800 text-red-300'
          }`}
        >
          {paymentFeedback.type === 'success' ? (
            <CheckCircle className="w-4 h-4 shrink-0 text-emerald-400 mt-0.5" />
          ) : (
            <AlertCircle className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
          )}
          <div className="flex-1 text-[11px] leading-relaxed">{paymentFeedback.message}</div>
          {onClearFeedback && (
            <button
              onClick={onClearFeedback}
              className="text-[#a1a1aa] hover:text-[#f4f4f5] text-[10px] font-medium"
            >
              ✕
            </button>
          )}
        </div>
      )}

      {error && !paymentFeedback && (
        <div className="mb-4 p-2 rounded-lg bg-red-950/30 border border-red-800 text-red-400 text-xs flex items-center gap-2">
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
          <span className="truncate">{error}</span>
        </div>
      )}

      {/* Action footer */}
      <div>
        <Button
          onClick={onTopUpClick}
          variant="secondary"
          size="sm"
          className="w-full justify-center border-[#27272a] hover:border-[#3f3f46] hover:bg-[#1a1a1f]"
          leftIcon={<Plus className="w-4 h-4 text-[#ef4444]" />}
        >
          Top Up Balance
        </Button>
      </div>
    </div>
  )
}
