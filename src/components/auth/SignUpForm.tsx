import React, { useState } from 'react'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Mail, Lock, User, AlertCircle } from 'lucide-react'

interface SignUpFormProps {
  onSuccess: (email: string) => void
  onSwitchToSignIn: () => void
}

export const SignUpForm: React.FC<SignUpFormProps> = ({
  onSuccess,
  onSwitchToSignIn,
}) => {
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [errors, setErrors] = useState<{
    fullName?: string
    email?: string
    password?: string
    confirmPassword?: string
    general?: string
  }>({})
  const [isLoading, setIsLoading] = useState(false)

  const validate = () => {
    const errs: typeof errors = {}
    if (!fullName.trim()) {
      errs.fullName = 'Full name is required'
    }
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
    if (password !== confirmPassword) {
      errs.confirmPassword = 'Passwords do not match'
    }
    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return

    setIsLoading(true)
    setTimeout(() => {
      setIsLoading(false)
      onSuccess(email)
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
        label="Full Name"
        type="text"
        placeholder="Alex Morgan"
        value={fullName}
        onChange={(e) => setFullName(e.target.value)}
        error={errors.fullName}
        leftIcon={<User className="w-4 h-4" />}
        autoComplete="name"
      />

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
        placeholder="Minimum 8 characters"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        error={errors.password}
        leftIcon={<Lock className="w-4 h-4" />}
        autoComplete="new-password"
      />

      <Input
        label="Confirm Password"
        isPassword
        placeholder="Repeat your password"
        value={confirmPassword}
        onChange={(e) => setConfirmPassword(e.target.value)}
        error={errors.confirmPassword}
        leftIcon={<Lock className="w-4 h-4" />}
        autoComplete="new-password"
      />

      <div className="pt-2">
        <Button
          type="submit"
          variant="primary"
          className="w-full"
          isLoading={isLoading}
        >
          Create Dallr Account
        </Button>
      </div>

      <div className="text-center pt-3 border-t border-[#1f1f24]">
        <p className="text-xs text-[#a1a1aa]">
          Already have an account?{' '}
          <button
            type="button"
            onClick={onSwitchToSignIn}
            className="text-[#ef4444] hover:text-[#f87171] font-medium transition-colors cursor-pointer hover:underline"
          >
            Sign in
          </button>
        </p>
      </div>
    </form>
  )
}
