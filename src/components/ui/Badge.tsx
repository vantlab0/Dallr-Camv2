import React from 'react'
import { cn } from '@/lib/utils'

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: 'default' | 'success' | 'warning' | 'danger' | 'accent'
}

export const Badge: React.FC<BadgeProps> = ({
  className,
  variant = 'default',
  children,
  ...props
}) => {
  const variantStyles = {
    default: 'bg-[#1a1a1f] text-[#a1a1aa] border-[#27272a]',
    success: 'bg-emerald-950/40 text-emerald-400 border-emerald-900/60',
    warning: 'bg-amber-950/40 text-amber-400 border-amber-900/60',
    danger: 'bg-red-950/40 text-red-400 border-red-900/60',
    accent: 'bg-red-500/10 text-[#ef4444] border-red-500/20',
  }

  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border tracking-wide uppercase',
        variantStyles[variant],
        className
      )}
      {...props}
    >
      {children}
    </span>
  )
}
