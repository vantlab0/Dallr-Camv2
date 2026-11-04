import React from 'react'
import { Button } from '@/components/ui/Button'
import {
  Wifi,
  Clock,
  DollarSign,
  PhoneOff,
  ExternalLink,
  Sparkles,
  Maximize2,
} from 'lucide-react'
import type { LiveStreamMetrics } from '@/types/live'

export interface CompactLiveStatusProps {
  isConnected: boolean
  isEnding?: boolean
  elapsedSeconds: number
  balanceUSD: number
  metrics?: LiveStreamMetrics | null
  isOutputWindowOpen?: boolean
  onReopenOutputWindow?: () => void
  onFocusOutputWindow?: () => void
  onEndSession: () => void
}

export const CompactLiveStatus: React.FC<CompactLiveStatusProps> = ({
  isConnected,
  isEnding = false,
  elapsedSeconds,
  balanceUSD,
  metrics,
  isOutputWindowOpen = true,
  onReopenOutputWindow,
  onFocusOutputWindow,
  onEndSession,
}) => {
  const formatDuration = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60)
    const secs = totalSeconds % 60
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  return (
    <div
      data-testid="compact-live-status"
      className="rounded-2xl border border-red-500/30 bg-[#121215] p-5 shadow-2xl relative overflow-hidden"
    >
      {/* Background ambient glow */}
      <div className="absolute top-0 right-0 w-48 h-48 bg-red-500/5 rounded-full blur-3xl pointer-events-none" />

      <div className="relative z-10 flex flex-col md:flex-row md:items-center justify-between gap-4">
        {/* Left: Connected status & model tag */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-red-950/70 border border-red-500/40 text-red-400 text-xs font-bold uppercase tracking-wider">
            <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-ping" />
            <span>LIVE SESSION ACTIVE</span>
          </div>

          <div className="flex items-center gap-1.5 px-3 py-1 rounded-lg bg-[#18181b] border border-[#27272a] text-xs text-[#a1a1aa]">
            <Sparkles className="w-3.5 h-3.5 text-[#ef4444]" />
            <span>Decart Lucy 2.5</span>
          </div>

          <div className="hidden sm:flex items-center gap-1.5 text-xs">
            {isConnected ? (
              <span className="text-emerald-400 flex items-center gap-1 font-medium">
                <Wifi className="w-3.5 h-3.5" /> Connected
              </span>
            ) : (
              <span className="text-amber-400 font-medium">Connecting...</span>
            )}
          </div>
        </div>

        {/* Center: Live session duration & current wallet balance */}
        <div className="flex items-center gap-4 bg-[#18181b] px-4 py-2 rounded-xl border border-[#27272a]">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-[#ef4444]" />
            <div>
              <span className="text-[10px] text-[#71717a] uppercase tracking-wider block">Duration</span>
              <span className="font-mono text-xs font-semibold text-[#f4f4f5]" data-testid="live-duration">
                {formatDuration(elapsedSeconds)}
              </span>
            </div>
          </div>

          <div className="w-px h-6 bg-[#27272a]" />

          <div className="flex items-center gap-2">
            <DollarSign className="w-4 h-4 text-emerald-400" />
            <div>
              <span className="text-[10px] text-[#71717a] uppercase tracking-wider block">Wallet Balance</span>
              <span className="font-mono text-xs font-semibold text-emerald-400" data-testid="live-balance">
                ${balanceUSD.toFixed(2)} USD
              </span>
            </div>
          </div>

          {metrics?.fps !== undefined && (
            <>
              <div className="w-px h-6 bg-[#27272a]" />
              <div>
                <span className="text-[10px] text-[#71717a] uppercase tracking-wider block">Engine</span>
                <span className="font-mono text-xs text-[#a1a1aa]">{metrics.fps} FPS</span>
              </div>
            </>
          )}
        </div>

        {/* Right: Window Controls & End Session Button */}
        <div className="flex items-center gap-2.5">
          {isOutputWindowOpen ? (
            <Button
              variant="outline"
              size="sm"
              onClick={onFocusOutputWindow}
              leftIcon={<Maximize2 className="w-3.5 h-3.5 text-[#ef4444]" />}
              className="border-[#27272a] text-[#f4f4f5] hover:bg-[#1f1f24]"
            >
              Focus Video Window
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={onReopenOutputWindow}
              leftIcon={<ExternalLink className="w-3.5 h-3.5 text-[#ef4444]" />}
            >
              Reopen Video Window
            </Button>
          )}

          <Button
            variant="danger"
            size="sm"
            onClick={onEndSession}
            isLoading={isEnding}
            leftIcon={<PhoneOff className="w-4 h-4" />}
          >
            End Session
          </Button>
        </div>
      </div>
    </div>
  )
}
