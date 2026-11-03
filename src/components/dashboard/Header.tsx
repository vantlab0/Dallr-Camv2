import React from 'react'
import { Video, LogOut, ShieldCheck, Activity } from 'lucide-react'

interface HeaderProps {
  userEmail: string
  onSignOut: () => void
}

export const Header: React.FC<HeaderProps> = ({ userEmail, onSignOut }) => {
  return (
    <header className="h-16 border-b border-[#27272a] bg-[#0c0c0e]/80 backdrop-blur-md px-6 flex items-center justify-between sticky top-0 z-40">
      {/* Brand */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-[#1a1a1f] border border-[#27272a] flex items-center justify-center">
          <Video className="w-4 h-4 text-[#ef4444]" />
        </div>
        <div className="flex items-center gap-2">
          <span className="font-bold text-sm tracking-tight text-[#f4f4f5]">
            DALLR CAM
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-500/10 text-[#ef4444] border border-red-500/20 font-medium">
            STUDIO
          </span>
        </div>
      </div>

      {/* Center status indicator */}
      <div className="hidden md:flex items-center gap-2 px-3 py-1 rounded-full bg-[#121215] border border-[#27272a] text-xs text-[#a1a1aa]">
        <Activity className="w-3.5 h-3.5 text-emerald-400" />
        <span className="text-[11px]">System Ready</span>
        <span className="text-[#3f3f46]">|</span>
        <span className="text-[11px] text-[#71717a]">Latency &lt; 45ms</span>
      </div>

      {/* User profile & actions */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-full bg-[#1a1a1f] border border-[#27272a] flex items-center justify-center text-[#a1a1aa] text-xs font-semibold">
            {userEmail.charAt(0).toUpperCase()}
          </div>
          <div className="hidden sm:block text-left">
            <p className="text-xs font-medium text-[#f4f4f5] leading-none">{userEmail}</p>
            <p className="text-[10px] text-[#71717a] mt-0.5 flex items-center gap-1">
              <ShieldCheck className="w-2.5 h-2.5 text-emerald-400" />
              Verified Operator
            </p>
          </div>
        </div>

        <button
          onClick={onSignOut}
          title="Sign out"
          aria-label="Sign out"
          className="text-[#71717a] hover:text-[#ef4444] p-1.5 rounded-lg hover:bg-[#1a1a1f] transition-colors cursor-pointer"
        >
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </header>
  )
}
