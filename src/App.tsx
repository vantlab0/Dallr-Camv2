import { useState } from 'react'
import { AuthPage } from './pages/AuthPage'
import { DashboardPage } from './pages/DashboardPage'
import { MOCK_USER } from './lib/mockData'

export function App() {
  const [userEmail, setUserEmail] = useState<string | null>(MOCK_USER.email)

  const handleAuthenticated = (email: string) => {
    setUserEmail(email)
  }

  const handleSignOut = () => {
    setUserEmail(null)
  }

  return (
    <div className="min-h-screen bg-[#09090b] text-[#f4f4f5]">
      {userEmail ? (
        <DashboardPage userEmail={userEmail} onSignOut={handleSignOut} />
      ) : (
        <AuthPage onAuthenticated={handleAuthenticated} />
      )}
    </div>
  )
}

export default App
