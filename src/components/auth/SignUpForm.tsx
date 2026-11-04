import React, { useState } from 'react'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { Mail, Lock, User, AlertCircle, CheckCircle } from 'lucide-react'
import { useAuth } from '@/hooks/useAuth'

interface SignUpFormProps {
  onSuccess?: (email: string) => void
  onSwitchToSignIn: () => void
}

export const SignUpForm: React.FC<SignUpFormProps> = ({
  onSuccess,
  onSwitchToSignIn,
}) => {
  const { signUp } = useAuth()
  const [fullName, setFullName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [verificationPending, setVerificationPending] = useState(false)
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
    const trimmedEmail = email.trim()

    if (!fullName.trim()) {
      errs.fullName = 'Full name is required'
    }

    if (!trimmedEmail) {
      errs.email = 'Email address is required'
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      errs.email = 'Please enter a valid email address'
    }

    if (!password) {
      errs.password = 'Password is required'
    } else if (password.length < 8) {
      errs.password = 'Password must be at least 8 characters'
    }

    if (!confirmPassword) {
      errs.confirmPassword = 'Confirm your password'
    } else if (password !== confirmPassword) {
      errs.confirmPassword = 'Passwords do not match'
    }

    setErrors(errs)
    return Object.keys(errs).length === 0
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!validate()) return

    setIsLoading(true)
    setErrors({})

    try {
      const res = await signUp(email.trim(), password, fullName.trim())
      if (res.needsEmailVerification) {
        setVerificationPending(true)
      } else if (onSuccess) {
        onSuccess(email.trim())
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : 'Unable to create account. Please try again.'

      let friendlyMessage = message
      if (
        message.toLowerCase().includes('user already registered') ||
        message.toLowerCase().includes('already registered') ||
        message.toLowerCase().includes('duplicate')
      ) {
        friendlyMessage = 'An account with this email already exists. Please sign in.'
      } else if (message.toLowerCase().includes('password should be')) {
        friendlyMessage = message
      }

      setErrors({ general: friendlyMessage })
    } finally {
      setIsLoading(false)
    }
  }

  if (verificationPending) {
    return (
      <div className="space-y-4 text-center py-4">
        <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 mx-auto flex items-center justify-center">
          <CheckCircle className="w-6 h-6" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-[#f4f4f5]">
            Check your email
          </h3>
          <p className="text-xs text-[#a1a1aa] mt-2 leading-relaxed">
            We have sent a verification confirmation link to{' '}
            <span className="text-[#f4f4f5] font-medium">{email}</span>. Click the link to complete registration and log in.
          </p>
        </div>
        <div className="pt-4 border-t border-[#1f1f24]">
          <Button
            type="button"
            variant="secondary"
            className="w-full"
            onClick={onSwitchToSignIn}
          >
            Return to Sign In
          </Button>
        </div>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {errors.general && (
        <div
          role="alert"
          className="flex items-center gap-2.5 p-3 rounded-lg bg-red-950/30 border border-red-900/50 text-xs text-red-300"
        >
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
