import React, { useRef, useEffect, useState } from 'react'
import { Button } from '@/components/ui/Button'
import {
  PhoneOff,
  Sparkles,
  Wifi,
  ShieldAlert,
  Loader2,
  Clock,
  DollarSign,
  Send,
  Video,
} from 'lucide-react'
import type {
  LiveSessionStatus,
  LiveStreamSessionInfo,
  LiveStreamMetrics,
} from '@/types/live'

interface LiveStreamViewProps {
  status: LiveSessionStatus
  isLoading?: boolean
  error: string | null
  sessionInfo: LiveStreamSessionInfo | null
  remoteStream: MediaStream | null
  localStream: MediaStream | null
  elapsedSeconds?: number
  usageUSD?: number
  metrics?: LiveStreamMetrics | null
  onUpdatePrompt: (prompt: string) => Promise<void>
  onEndStream: () => Promise<void>
  onDismissError?: () => void
}

export const LiveStreamView: React.FC<LiveStreamViewProps> = ({
  status,
  error,
  sessionInfo,
  remoteStream,
  localStream,
  elapsedSeconds = 0,
  usageUSD = 0,
  metrics,
  onUpdatePrompt,
  onEndStream,
  onDismissError,
}) => {
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const localVideoRef = useRef<HTMLVideoElement>(null)

  const [promptInput, setPromptInput] = useState<string>(() => sessionInfo?.prompt || '')
  const [isUpdatingPrompt, setIsUpdatingPrompt] = useState<boolean>(false)

  // Track session prompt sync without invalid setState in render effect
  const prevSessionPromptRef = useRef(sessionInfo?.prompt)
  useEffect(() => {
    if (sessionInfo?.prompt && sessionInfo.prompt !== prevSessionPromptRef.current) {
      prevSessionPromptRef.current = sessionInfo.prompt
      setPromptInput(sessionInfo.prompt)
    }
  }, [sessionInfo?.prompt])

  // Bind remote transformed stream to video element
  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream
      const playPromise = remoteVideoRef.current.play()
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err) => {
          console.warn('Auto-play blocked or error on remote video:', err)
        })
      }
    }
  }, [remoteStream])

  // Bind local camera stream to preview element
  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream
      const playPromise = localVideoRef.current.play()
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err) => {
          console.warn('Auto-play blocked or error on local video:', err)
        })
      }
    }
  }, [localStream])

  const handlePromptSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!promptInput.trim() || isUpdatingPrompt) return

    setIsUpdatingPrompt(true)
    try {
      await onUpdatePrompt(promptInput.trim())
    } finally {
      setIsUpdatingPrompt(false)
    }
  }

  const formatDuration = (totalSeconds: number) => {
    const mins = Math.floor(totalSeconds / 60)
    const secs = totalSeconds % 60
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  const isConnected = status === 'connected'
  const isConnecting = status === 'connecting' || status === 'preparing'
  const isReconnecting = status === 'reconnecting'
  const isEnding = status === 'ending'

  return (
    <div className="relative flex flex-col h-full w-full bg-[#09090b] text-[#f4f4f5] overflow-hidden rounded-2xl border border-[#27272a] shadow-2xl">
      {/* Top Header Bar */}
      <div className="flex items-center justify-between px-4 py-3 bg-[#121215]/90 backdrop-blur-md border-b border-[#27272a] z-20">
        <div className="flex items-center gap-3">
          {/* Live Pulsing Indicator */}
          <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-950/70 border border-red-500/40 text-red-400 text-xs font-semibold">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-ping" />
            <span>LIVE</span>
          </div>

          {/* Model Tag */}
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-[#1a1a20] border border-[#27272a] text-[11px] text-[#a1a1aa]">
            <Sparkles className="w-3 h-3 text-[#ef4444]" />
            <span>Decart Lucy 2.5 (720p)</span>
          </div>

          {/* State Indicator */}
          <div className="text-xs">
            {isConnected && (
              <span className="text-emerald-400 flex items-center gap-1">
                <Wifi className="w-3.5 h-3.5" /> Connected
              </span>
            )}
            {isConnecting && (
              <span className="text-amber-400 flex items-center gap-1">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Establishing WebRTC...
              </span>
            )}
            {isReconnecting && (
              <span className="text-amber-400 flex items-center gap-1 animate-pulse">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Reconnecting...
              </span>
            )}
            {isEnding && (
              <span className="text-[#a1a1aa] flex items-center gap-1">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Disconnecting...
              </span>
            )}
          </div>
        </div>

        {/* Right Info: Live Usage & End Call */}
        <div className="flex items-center gap-3">
          {/* Session Timer & Billing Metrics */}
          <div className="hidden sm:flex items-center gap-3 text-xs bg-[#18181b] px-3 py-1.5 rounded-lg border border-[#27272a]">
            <div className="flex items-center gap-1 text-[#a1a1aa]">
              <Clock className="w-3.5 h-3.5 text-[#ef4444]" />
              <span className="font-mono text-[#f4f4f5]">{formatDuration(elapsedSeconds)}</span>
            </div>
            <div className="w-px h-3 bg-[#27272a]" />
            <div className="flex items-center gap-1 text-[#a1a1aa]">
              <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
              <span className="font-mono text-[#f4f4f5]">${usageUSD.toFixed(2)} USD</span>
            </div>
            {metrics?.fps && (
              <>
                <div className="w-px h-3 bg-[#27272a]" />
                <span className="text-[11px] text-[#71717a]">{metrics.fps} FPS</span>
              </>
            )}
          </div>

          <Button
            variant="danger"
            size="sm"
            onClick={onEndStream}
            isLoading={isEnding}
            leftIcon={<PhoneOff className="w-4 h-4" />}
          >
            End Stream
          </Button>
        </div>
      </div>

      {/* Main Video Viewport */}
      <div className="relative flex-1 bg-black flex items-center justify-center overflow-hidden">
        {/* Remote AI Transformed Output Video (Primary) */}
        <video
          ref={remoteVideoRef}
          autoPlay
          playsInline
          className={`w-full h-full object-contain transition-opacity duration-300 ${
            remoteStream ? 'opacity-100' : 'opacity-0'
          }`}
        />

        {/* Loading Overlay while WebRTC connection is forming */}
        {(!remoteStream || isConnecting || isReconnecting) && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm z-10 space-y-3">
            <div className="w-14 h-14 rounded-full bg-[#18181b] border border-[#ef4444]/40 flex items-center justify-center text-[#ef4444] shadow-lg">
              <Loader2 className="w-7 h-7 animate-spin" />
            </div>
            <div className="text-center">
              <h4 className="text-sm font-semibold text-[#f4f4f5]">
                {isReconnecting
                  ? 'Reconnecting Live Stream to Decart...'
                  : 'Initializing Decart Lucy 2.5 WebRTC Stream...'}
              </h4>
              <p className="text-xs text-[#a1a1aa] mt-1 max-w-xs">
                Establishing peer connection and negotiating transformation tracks at 720p 30fps.
              </p>
            </div>
          </div>
        )}

        {/* Local Camera Input & Reference Portrait Picture-in-Picture PIP */}
        <div className="absolute bottom-4 right-4 z-20 flex flex-col items-end gap-2.5">
          {/* Reference Portrait Thumbnail */}
          {sessionInfo?.referenceImage && (
            <div className="w-24 h-24 rounded-xl overflow-hidden border-2 border-[#ef4444] shadow-2xl bg-[#121215] relative group">
              <img
                src={sessionInfo.referenceImage.dataUrl}
                alt="Reference identity"
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-[10px] text-white font-medium p-1 text-center">
                Reference
              </div>
            </div>
          )}

          {/* Local Camera Input Feed Thumbnail */}
          <div className="w-32 h-24 rounded-xl overflow-hidden border border-[#3f3f46] shadow-2xl bg-[#121215] relative">
            <video
              ref={localVideoRef}
              autoPlay
              playsInline
              muted
              className="w-full h-full object-cover -scale-x-100"
            />
            <div className="absolute bottom-1 left-1 px-1.5 py-0.5 rounded bg-black/70 text-[9px] text-white/80 border border-white/10 flex items-center gap-1">
              <Video className="w-2.5 h-2.5 text-[#ef4444]" />
              <span>Camera</span>
            </div>
          </div>
        </div>

        {/* Error Banner */}
        {error && (
          <div className="absolute top-4 left-4 right-4 z-30 max-w-lg mx-auto bg-red-950/90 border border-red-500/50 rounded-xl p-3.5 shadow-2xl backdrop-blur-md flex items-start gap-3 text-xs text-red-200">
            <ShieldAlert className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div className="flex-1 space-y-1">
              <span className="font-semibold block text-red-100">Live Stream Error</span>
              <p className="leading-relaxed">{error}</p>
            </div>
            {onDismissError && (
              <button
                onClick={onDismissError}
                className="text-red-400 hover:text-red-200 text-xs font-semibold px-2 py-0.5 rounded"
              >
                Dismiss
              </button>
            )}
          </div>
        )}
      </div>

      {/* Dynamic Prompt Control Bar */}
      <div className="p-3 bg-[#121215] border-t border-[#27272a] z-20">
        <form onSubmit={handlePromptSubmit} className="flex items-center gap-2 max-w-3xl mx-auto">
          <div className="relative flex-1">
            <div className="absolute left-3 top-1/2 -translate-y-1/2 text-[#ef4444]">
              <Sparkles className="w-4 h-4" />
            </div>
            <input
              type="text"
              value={promptInput}
              onChange={(e) => setPromptInput(e.target.value)}
              placeholder="Update Lucy 2.5 transformation style on the fly..."
              disabled={isUpdatingPrompt || !isConnected}
              className="w-full pl-9 pr-3 py-2 text-xs bg-[#09090b] border border-[#27272a] rounded-lg text-[#f4f4f5] focus:outline-none focus:border-[#ef4444] placeholder:text-[#52525b]"
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            size="sm"
            isLoading={isUpdatingPrompt}
            disabled={!isConnected || !promptInput.trim() || promptInput === sessionInfo?.prompt}
            leftIcon={<Send className="w-3.5 h-3.5" />}
          >
            Update
          </Button>
        </form>
      </div>
    </div>
  )
}
