import React, { useState } from 'react'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Mail, Lock, AlertCircle } from 'lucide-react'

interface SignInFormProps {
  onSuccess: (email: string) => void
  onSwitchToSignUp: () => void
}

export const SignInForm: React.FC<SignInFormProps> = ({
  onSuccess,
  onSwitchToSignUp,
}) => {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<{ email?: string; password?: string; general?: string }>({})
  const [isLoading, setIsLoading] = useState(false)

  const validate = () => {
    const errs: { email?: string; password?: string } = {}
    if (!email) {
      errs.email = 'Email address is required'
    } else if (!/\S+@\S+\.\S+/.test(email)) {
      errs.email = 'Please enter a valid email address'
    }
    if (!password) {
      errs.password = 'Password is required'
    } else if (password.length < 8) {
      errs.password = 'Password must be at least 8 characters'
    }
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return

    setIsLoading(true)
    // Simulate UI authentication check (Supabase auth will follow in later phase)
    setTimeout(() => {
      setIsLoading(false)
      if (email === 'fail@error.com') {
        setErrors({ general: 'Invalid credentials. Please verify your email and password.' })
      } else {
        onSuccess(email)
      }
    }, 800)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {errors.general && (
        <div className="flex items-center gap-2.5 p-3 rounded-lg bg-red-950/30 border border-red-900/50 text-xs text-red-300">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
          <span>{errors.general}</span>
        </div>
      )}

      <Input
        label="Email address"
        type="email"
        placeholder="operator@dallrcam.app"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={errors.email}
        leftIcon={<Mail className="w-4 h-4" />}
        autoComplete="email"
      />

      <Input
        label="Password"
        isPassword
        placeholder="••••••••"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.password}
        leftIcon={<Lock className="w-4 h-4" />}
        autoComplete="current-password"
      />

      <div className="pt-2">
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          isLoading={isLoading}
        >
          Sign In to Dallr Cam
        </Button>
      </div>

      <div className="text-center pt-3 border-t border-[#1f1f24]">
        <p className="text-xs text-[#a1a1aa]">
          Don't have an account?{' '}
          <button
            type="button"
            onClick={onSwitchToSignUp}
            className="text-[#ef4444] hover:text-[#f87171] font-medium transition-colors cursor-pointer hover:underline"
          >
            Create account
          </button>
        </p>
      </div>
    </form>
  )
}
