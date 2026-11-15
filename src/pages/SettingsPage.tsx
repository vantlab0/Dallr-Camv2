import React, { useEffect, useState, useCallback } from 'react'
import { DashboardLayout } from '@/components/dashboard/DashboardLayout'
import { Button } from '@/components/ui/Button'
import {
  Camera,
  Download,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  Loader2,
  ArrowLeft,
  Monitor,
} from 'lucide-react'
import { virtualCameraService, type VirtualCameraStatus } from '@/services/virtualCameraService'

interface SettingsPageProps {
  userEmail: string
  displayName?: string
  onSignOut: () => void
  onBack: () => void
}

export const SettingsPage: React.FC<SettingsPageProps> = ({
  userEmail,
  displayName,
  onSignOut,
  onBack,
}) => {
  const [status, setStatus] = useState<VirtualCameraStatus | null>(null)
  const [isChecking, setIsChecking] = useState(false)
  const [isInstalling, setIsInstalling] = useState(false)
  const [installNotice, setInstallNotice] = useState<string | null>(null)
  const [installProgress, setInstallProgress] = useState<string>('')

  const installed = status?.installed ?? false

  const progressLabel = (() => {
    switch (installProgress) {
      case 'starting':
      case 'awaiting_uac':
        return 'Waiting for administrator approval (UAC)…'
      case 'uac_accepted':
        return 'Administrator approval granted. Starting installation…'
      case 'registering_32':
        return 'Registering 32-bit virtual camera driver…'
      case 'registering_64':
        return 'Registering 64-bit virtual camera driver…'
      case 'completed':
        return 'Installation completed. Verifying device…'
      default:
        if (installProgress.startsWith('error:')) {
          return `Installation failed: ${installProgress.slice('error:'.length)}`
        }
        return null
    }
  })()

  const refreshStatus = useCallback(async () => {
    setIsChecking(true)
    try {
      const s = await virtualCameraService.getStatus()
      setStatus(s)
    } finally {
      setIsChecking(false)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  // Poll in-app installation progress while running.
  useEffect(() => {
    if (!isInstalling) return
    let cancelled = false

    const poll = async () => {
      try {
        const p = await virtualCameraService.getInstallProgress()
        if (cancelled) return
        setInstallProgress(p)

        if (p === 'completed') {
          setIsInstalling(false)
          const s = await virtualCameraService.getStatus()
          if (cancelled) return
          setStatus(s)
          if (!s.installed) {
            setInstallNotice(
              'Installation finished. If “Dallr Cam” is not detected yet, restart camera apps (or grant camera permission) and click Recheck status.',
            )
          } else {
            setInstallNotice('“Dallr Cam” virtual camera is installed and ready to use.')
          }
          return
        }

        if (p.startsWith('error:')) {
          setIsInstalling(false)
          setInstallNotice(`Installation failed: ${p.slice('error:'.length)}`)
          return
        }

        setTimeout(poll, 1000)
      } catch {
        if (!cancelled) setTimeout(poll, 1500)
      }
    }

    void poll()
    return () => {
      cancelled = true
    }
  }, [isInstalling])

  const handleInstall = async () => {
    setIsInstalling(true)
    setInstallNotice(null)
    setInstallProgress('awaiting_uac')
    try {
      const res = await virtualCameraService.install()
      if (!res.launched) {
        setIsInstalling(false)
        setInstallProgress('')
        if (res.error) setInstallNotice(res.error)
      } else {
        setInstallNotice(
          'Approve the administrator (UAC) prompt to continue. The status will update as soon as permission is granted.',
        )
      }
    } catch (err) {
      setIsInstalling(false)
      setInstallProgress('')
      setInstallNotice(err instanceof Error ? err.message : 'Failed to start installation.')
    }
  }

  return (
    <DashboardLayout userEmail={userEmail} displayName={displayName} onSignOut={onSignOut}>
      <div className="space-y-6 max-w-3xl">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onBack}
            className="p-1.5 rounded-lg text-[#71717a] hover:text-[#f4f4f5] hover:bg-[#1a1a1f] transition-colors"
            aria-label="Back to dashboard"
            title="Back to dashboard"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-[#f4f4f5]">Settings</h1>
            <p className="text-xs text-[#a1a1aa] mt-1">
              Configure studio integrations and system devices.
            </p>
          </div>
        </div>

        <section className="rounded-xl border border-[#27272a] bg-[#121215]/60 p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-[#1a1a1f] border border-[#27272a] flex items-center justify-center text-[#ef4444] shrink-0">
              <Camera className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <h2 className="text-sm font-semibold text-[#f4f4f5]">Virtual Camera (“Dallr Cam”)</h2>
              <p className="text-xs text-[#a1a1aa] mt-1 leading-relaxed">
                Installs and registers the <span className="text-[#f4f4f5] font-medium">Dallr Cam</span>{' '}
                DirectShow virtual camera device on this Windows system so apps like WhatsApp, Zoom, Meet,
                and Teams can select it as a camera source.
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-[#27272a] bg-[#0e0e11] p-3 space-y-2 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[#71717a]">Status</span>
              <span
                className={`flex items-center gap-1.5 font-medium ${
                  installed ? 'text-emerald-400' : 'text-amber-300'
                }`}
              >
                {installed ? (
                  <>
                    <CheckCircle2 className="w-3.5 h-3.5" /> Installed / detected
                  </>
                ) : (
                  <>
                    <AlertCircle className="w-3.5 h-3.5" /> Not detected
                  </>
                )}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[#71717a]">Device name</span>
              <span className="text-[#e4e4e7]">{status?.deviceName || 'Dallr Cam'}</span>
            </div>
            <div className="flex items-center justify-between gap-3">
              <span className="text-[#71717a]">Platform support</span>
              <span className="text-[#e4e4e7] flex items-center gap-1.5">
                <Monitor className="w-3.5 h-3.5 text-[#a1a1aa]" />
                {status?.supported ? 'Supported in desktop app' : status ? 'Requires desktop app (Windows)' : 'Checking…'}
              </span>
            </div>
            {status?.backend && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-[#71717a]">Backend</span>
                <span className="text-[#e4e4e7]">{status.backend}</span>
              </div>
            )}
          </div>

          {!installed && status?.message && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-900/60 bg-amber-950/20 p-2.5 text-xs text-amber-200/90">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>{status.message}</span>
            </div>
          )}

          {(isInstalling || progressLabel || installNotice) && (
            <div className="rounded-lg border border-[#27272a] bg-[#121215] p-3 text-xs text-[#d4d4d8] space-y-1.5">
              {(isInstalling || progressLabel) && (
                <div className="flex items-center gap-2">
                  {installProgress === 'completed' ? (
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                  ) : installProgress.startsWith('error:') ? (
                    <AlertCircle className="w-3.5 h-3.5 text-red-400" />
                  ) : (
                    <Loader2 className="w-3.5 h-3.5 text-[#ef4444] animate-spin" />
                  )}
                  <span>{progressLabel || 'Waiting for administrator approval (UAC)…'}</span>
                </div>
              )}
              {installNotice && <div className="text-[#a1a1aa] leading-relaxed">{installNotice}</div>}
            </div>
          )}

          {installed && !installNotice && (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-900/50 bg-emerald-950/20 p-2.5 text-xs text-emerald-200">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>
                “Dallr Cam” is available. Select it in your calling app’s camera settings. If it doesn’t
                appear, restart the calling app and ensure Dallr is running when streaming.
              </span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              variant="primary"
              onClick={handleInstall}
              isLoading={isInstalling}
              leftIcon={<Download className="w-4 h-4" />}
            >
              {installed ? 'Reinstall “Dallr Cam” driver' : 'Install “Dallr Cam” driver'}
            </Button>
            <Button
              variant="outline"
              onClick={() => void refreshStatus()}
              isLoading={isChecking}
              leftIcon={<RefreshCw className="w-4 h-4" />}
            >
              Recheck status
            </Button>
          </div>

          <p className="text-[11px] text-[#71717a] leading-relaxed">
            Installation requires administrator approval (UAC) on Windows and registers the bundled virtual
            camera driver system-wide. After installing, you may need to restart apps like WhatsApp Desktop
            before “Dallr Cam” appears in their camera list.
          </p>
        </section>
      </div>
    </DashboardLayout>
  )
}
