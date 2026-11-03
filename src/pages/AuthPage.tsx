import React, { useState } from 'react'
import { AuthLayout } from '@/components/auth/AuthLayout'
import { SignInForm } from '@/components/auth/SignInForm'
import { SignUpForm } from '@/components/auth/SignUpForm'

interface AuthPageProps {
  onAuthenticated: (email: string) => void
}

export const AuthPage: React.FC<AuthPageProps> = ({ onAuthenticated }) => {
  const [view, setView] = useState<'signin' | 'signup'>('signin')

  return (
    <AuthLayout
      title={view === 'signin' ? 'Sign in to Dallr Cam' : 'Create your account'}
      subtitle={
        view === 'signin'
          ? 'Enter your credentials to access the studio dashboard'
          : 'Setup your operator profile to begin broadcasting'
      }
    >
      {view === 'signin' ? (
        <SignInForm
          onSuccess={onAuthenticated}
          onSwitchToSignUp={() => setView('signup')}
        />
      ) : (
        <SignUpForm
          onSuccess={onAuthenticated}
          onSwitchToSignIn={() => setView('signin')}
        />
      )}
    </AuthLayout>
  )
}
