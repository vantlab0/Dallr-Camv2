import { AuthProvider } from './contexts/AuthContext'
import { useAuth } from './hooks/useAuth'
import { AuthPage } from './pages/AuthPage'
import { DashboardPage } from './pages/DashboardPage'
import { VideoOutputPage } from './pages/VideoOutputPage'
import { Video } from 'lucide-react'

function isVideoOutputWindow(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  return params.get('view') === 'video-output' || window.location.hash === '#video-output'
}

function AppContent() {
  const { user, profile, isAuthenticated, isLoading, signOut } = useAuth()

  if (isVideoOutputWindow()) {
    return <VideoOutputPage />
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#09090b] flex flex-col items-center justify-center text-[#f4f4f5]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-12 h-12 rounded-xl bg-[#121215] border border-[#27272a] flex items-center justify-center animate-pulse">
            <Video className="w-6 h-6 text-[#ef4444]" />
          </div>
          <span className="text-xs text-[#a1a1aa] font-medium tracking-wide">
            INITIALIZING DALLR STUDIO...
          </span>
        </div>
      </div>
    )
  }

  if (!isAuthenticated || !user) {
    return <AuthPage />
  }

  return (
    <DashboardPage
      userId={user.id}
      userEmail={user.email}
      displayName={profile?.display_name || user.displayName}
      onSignOut={signOut}
    />
  )
}

export function App() {
  if (isVideoOutputWindow()) {
    return (
      <div className="fixed inset-0 bg-black text-[#f4f4f5] m-0 p-0 overflow-hidden">
        <VideoOutputPage />
      </div>
    )
  }

  return (
    <AuthProvider>
      <div className="min-h-screen bg-[#09090b] text-[#f4f4f5]">
        <AppContent />
      </div>
    </AuthProvider>
  )
}

export default App
