import React from 'react'
import { cn } from '@/lib/utils'
import { Loader2 } from 'lucide-react'

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  isLoading?: boolean
  leftIcon?: React.ReactNode
  rightIcon?: React.ReactNode
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'primary',
      size = 'md',
      isLoading = false,
      leftIcon,
      rightIcon,
      children,
      disabled,
      ...props
    },
    ref
  ) => {
    const baseStyles =
      'inline-flex items-center justify-center font-medium rounded-lg transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-[#09090b] disabled:opacity-50 disabled:pointer-events-none cursor-pointer select-none active:scale-[0.98]'

    const variantStyles = {
      primary:
        'bg-[#ef4444] text-white hover:bg-[#dc2626] focus:ring-[#ef4444] shadow-sm shadow-[#ef4444]/20 border border-transparent',
      secondary:
        'bg-[#1a1a1f] text-[#f4f4f5] hover:bg-[#24242c] border border-[#27272a] focus:ring-[#3f3f46]',
      ghost:
        'bg-transparent text-[#a1a1aa] hover:text-[#f4f4f5] hover:bg-[#1a1a1f] focus:ring-[#27272a]',
      outline:
        'bg-transparent text-[#f4f4f5] border border-[#27272a] hover:border-[#3f3f46] hover:bg-[#121215] focus:ring-[#3f3f46]',
      danger:
        'bg-red-950/40 text-red-400 border border-red-900/60 hover:bg-red-900/40 focus:ring-red-500',
    }

    const sizeStyles = {
      sm: 'text-xs px-3 py-1.5 gap-1.5',
      md: 'text-sm px-4 py-2 gap-2',
      lg: 'text-base px-5 py-2.5 gap-2.5 font-semibold',
    }

    return (
      <button
        ref={ref}
        className={cn(baseStyles, variantStyles[variant], sizeStyles[size], className)}
        disabled={disabled || isLoading}
        {...props}
      >
        {isLoading ? (
          <Loader2 className="w-4 h-4 animate-spin shrink-0" />
        ) : (
          leftIcon && <span className="shrink-0">{leftIcon}</span>
        )}
        <span>{children}</span>
        {!isLoading && rightIcon && <span className="shrink-0">{rightIcon}</span>}
      </button>
    )
  }
)

Button.displayName = 'Button'
