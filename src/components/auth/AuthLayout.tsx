import React from 'react'
import { motion } from 'framer-motion'
import { Video } from 'lucide-react'

interface AuthLayoutProps {
  children: React.ReactNode
  title: string
  subtitle: string
}

export const AuthLayout: React.FC<AuthLayoutProps> = ({
  children,
  title,
  subtitle,
}) => {
  return (
    <div className="min-h-screen w-full flex items-center justify-center p-6 bg-[#09090b] relative overflow-hidden select-none">
      {/* Subtle radial dark lighting in the background */}
      <div className="absolute top-1/4 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[600px] h-[600px] bg-red-600/[0.03] rounded-full blur-3xl pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.25 }}
        className="w-full max-w-md bg-[#121215] border border-[#27272a] rounded-2xl p-8 shadow-2xl relative z-10"
      >
        {/* Header with App Logo */}
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-[#1f1f24] to-[#121215] border border-[#27272a] flex items-center justify-center mb-4 shadow-inner">
            <Video className="w-6 h-6 text-[#ef4444]" />
          </div>
          <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-[#1a1a1f] border border-[#27272a] text-[10px] uppercase font-semibold text-[#a1a1aa] tracking-widest mb-2">
            Desktop Studio
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-[#f4f4f5]">
            {title}
          </h1>
          <p className="text-xs text-[#a1a1aa] mt-1.5 max-w-xs leading-relaxed">
            {subtitle}
          </p>
        </div>

        {children}
      </motion.div>
    </div>
  )
}
