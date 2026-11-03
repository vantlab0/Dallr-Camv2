import React from 'react'
import { Video, ArrowRight, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'

interface QuickActionCardProps {
  onStartCall: () => void
}

export const QuickActionCard: React.FC<QuickActionCardProps> = ({ onStartCall }) => {
  return (
    <div className="relative overflow-hidden rounded-xl border border-[#27272a] shadow-xl group min-h-[220px] flex flex-col justify-between p-6 bg-[#121215]">
      {/* Cinematic Studio Dark Image Background with Overlay */}
      <div
        className="absolute inset-0 bg-cover bg-center opacity-30 group-hover:opacity-40 transition-opacity duration-500 scale-105 group-hover:scale-100"
        style={{
          backgroundImage:
            'radial-gradient(ellipse at 80% 20%, rgba(239, 68, 68, 0.15), transparent 70%), linear-gradient(180deg, rgba(18, 18, 21, 0.6) 0%, rgba(9, 9, 11, 0.95) 100%), url("https://images.unsplash.com/photo-1598488035139-bdbb2231ce04?q=80&w=1200&auto=format&fit=crop")',
        }}
      />

      {/* Subtle vignette border gradient */}
      <div className="absolute inset-0 border border-white/[0.04] rounded-xl pointer-events-none" />

      {/* Top Tag & Status */}
      <div className="relative z-10 flex items-center justify-between">
        <Badge variant="accent" className="flex items-center gap-1.5 py-1 px-2.5">
          <Sparkles className="w-3 h-3 text-[#ef4444]" />
          <span>Real-time Live Engine</span>
        </Badge>
        <span className="flex h-2 w-2 relative">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
          <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
        </span>
      </div>

      {/* Content */}
      <div className="relative z-10 my-4">
        <h2 className="text-xl font-bold tracking-tight text-[#f4f4f5] flex items-center gap-2">
          Start Live Video Call
        </h2>
        <p className="text-xs text-[#a1a1aa] mt-1.5 max-w-md leading-relaxed">
          Upload reference identity portrait and spin up high-fidelity real-time streaming pipeline.
        </p>
      </div>

      {/* Action button */}
      <div className="relative z-10">
        <Button
          onClick={onStartCall}
          variant="primary"
          size="md"
          className="w-full sm:w-auto px-6 font-semibold"
          leftIcon={<Video className="w-4 h-4" />}
          rightIcon={<ArrowRight className="w-4 h-4 ml-1" />}
        >
          Configure & Launch Call
        </Button>
      </div>
    </div>
  )
}
