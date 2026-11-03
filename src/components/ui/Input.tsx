import React, { useState } from 'react'
import { cn } from '@/lib/utils'
import { Eye, EyeOff } from 'lucide-react'

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  helperText?: string
  leftIcon?: React.ReactNode
  isPassword?: boolean
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', label, error, helperText, leftIcon, isPassword, id, ...props }, ref) => {
    const [showPassword, setShowPassword] = useState(false)
    const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined)
    const effectiveType = isPassword ? (showPassword ? 'text' : 'password') : type

    return (
      <div className="w-full space-y-1.5 text-left">
        {label && (
          <label htmlFor={inputId} className="block text-xs font-medium text-[#a1a1aa] tracking-wide">
            {label}
          </label>
        )}
        <div className="relative flex items-center">
          {leftIcon && (
            <div className="absolute left-3.5 flex items-center pointer-events-none text-[#71717a]">
              {leftIcon}
            </div>
          )}
          <input
            id={inputId}
            ref={ref}
            type={effectiveType}
            className={cn(
              'w-full rounded-lg bg-[#121215] border border-[#27272a] px-3.5 py-2.5 text-sm text-[#f4f4f5] placeholder:text-[#52525b] transition-all duration-150',
              'focus:outline-none focus:border-[#ef4444] focus:ring-1 focus:ring-[#ef4444]',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              leftIcon && 'pl-10',
              isPassword && 'pr-11',
              error && 'border-red-500/80 focus:border-red-500 focus:ring-red-500',
              className
            )}
            {...props}
          />
          {isPassword && (
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              tabIndex={-1}
              className="absolute right-3.5 text-[#71717a] hover:text-[#d4d4d8] transition-colors focus:outline-none cursor-pointer"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          )}
        </div>
        {error ? (
          <p className="text-xs text-red-400 font-medium animate-fadeIn">{error}</p>
        ) : helperText ? (
          <p className="text-xs text-[#71717a]">{helperText}</p>
        ) : null}
      </div>
    )
  }
)

Input.displayName = 'Input'
