import React from 'react'
import { Header } from './Header'

interface DashboardLayoutProps {
  userEmail: string
  onSignOut: () => void
  children: React.ReactNode
}

export const DashboardLayout: React.FC<DashboardLayoutProps> = ({
  userEmail,
  onSignOut,
  children,
}) => {
  return (
    <div className="min-h-screen bg-[#09090b] text-[#f4f4f5] flex flex-col">
      <Header userEmail={userEmail} onSignOut={onSignOut} />
      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-8">
        {children}
      </main>
      <footer className="py-4 border-t border-[#1a1a1f] px-6 text-center">
        <p className="text-[11px] text-[#52525b]">
          Dallr Cam Desktop Application • Phase 1 Core UI • Secure Studio Edition
        </p>
      </footer>
    </div>
  )
}
