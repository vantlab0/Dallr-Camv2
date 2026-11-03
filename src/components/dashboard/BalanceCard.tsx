import React from 'react'
import { Wallet, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Skeleton } from '@/components/ui/Skeleton'
import { formatUSD } from '@/lib/utils'

interface BalanceCardProps {
  balanceUSD: number
  isLoading: boolean
  onTopUpClick: () => void
  onRefresh?: () => void
}

export const BalanceCard: React.FC<BalanceCardProps> = ({
  balanceUSD,
  isLoading,
  onTopUpClick,
  onRefresh,
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
            className="text-[#71717a] hover:text-[#d4d4d8] p-1.5 rounded-lg hover:bg-[#1a1a1f] transition-colors cursor-pointer"
            title="Refresh balance"
            aria-label="Refresh balance"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        )}
      </div>

      {/* Main Balance Display */}
      <div className="my-6">
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
            <p className="text-xs text-[#71717a] mt-1">Ready for studio broadcast sessions</p>
          </div>
        )}
      </div>

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
