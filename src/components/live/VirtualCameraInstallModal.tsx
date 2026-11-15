import React, { useEffect, useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Camera, Download, RefreshCw, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react'
import { virtualCameraService, type VirtualCameraStatus } from '@/services/virtualCameraService'

interface VirtualCameraInstallModalProps {
  isOpen: boolean
  status: VirtualCameraStatus | null
  onClose: () => void
  onInstalled: () => void
}

export const VirtualCameraInstallModal: React.FC<VirtualCameraInstallModalProps> = ({
  isOpen,
  status,
  onClose,
  onInstalled,
}) => {
  const [isChecking, setIsChecking] = useState(false)
  const [isInstalling, setIsInstalling] = useState(false)
  const [installNotice, setInstallNotice] = useState<string | null>(null)
  const [installProgress, setInstallProgress] = useState<string>('')
  const [checkResult, setCheckResult] = useState<VirtualCameraStatus | null>(null)

  const current = checkResult ?? status
  const installed = current?.installed ?? false

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

  // Poll in-app installation progress while running (no external console window required).
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
          setCheckResult(s)
          if (s.installed) {
            onInstalled()
          } else {
            setInstallNotice(
              'Installation finished. If “Dallr Cam” is not detected yet, reopen camera apps or grant camera permission, then click Recheck.',
            )
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
  }, [isInstalling, onInstalled])

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

  const handleRecheck = async () => {
    setIsChecking(true)
    try {
      const s = await virtualCameraService.getStatus()
      setCheckResult(s)
      if (s.installed) {
        onInstalled()
      }
    } finally {
      setIsChecking(false)
    }
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Install Dallr Cam Virtual Camera"
      description="To use live video in WhatsApp and other apps, Dallr Cam must publish to an OS-level virtual camera device named “Dallr Cam”."
      maxWidth="md"
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-[#27272a] bg-[#121215] p-3">
          <div className="w-9 h-9 rounded-lg bg-[#1a1a1f] border border-[#27272a] flex items-center justify-center text-[#ef4444] shrink-0">
            <Camera className="w-4 h-4" />
          </div>
          <div className="text-xs text-[#a1a1aa] leading-relaxed">
            <p className="text-[#f4f4f5] font-medium">Virtual camera required (Windows)</p>
            <p className="mt-1">
              Once installed, starting a call will automatically publish your transformed stream to the
              <span className="text-[#f4f4f5] font-medium"> Dallr Cam </span>
              camera so you can select it in WhatsApp, Zoom, Meet, Teams, and more.
            </p>
          </div>
        </div>

        {installed ? (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-900/50 bg-emerald-950/20 p-2.5 text-xs text-emerald-200">
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
            <span>“Dallr Cam” virtual camera detected. You can start a call now.</span>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-start gap-2 rounded-lg border border-amber-900/60 bg-amber-950/20 p-2.5 text-xs text-amber-200/90">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>
                {current?.message ||
                  'The “Dallr Cam” virtual camera device was not found on this system. Install the virtual camera driver, then recheck.'}
              </span>
            </div>
            {(isInstalling || progressLabel || installNotice) && (
              <div className="rounded-lg border border-[#27272a] bg-[#121215] p-2.5 text-xs text-[#d4d4d8] space-y-1.5">
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
                {installNotice && <div className="text-[#a1a1aa]">{installNotice}</div>}
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-2 border-t border-[#1f1f24]">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <div className="flex items-center gap-2">
            {!installed && (
              <Button
                variant="secondary"
                onClick={handleInstall}
                isLoading={isInstalling}
                leftIcon={<Download className="w-4 h-4" />}
              >
                Install “Dallr Cam”
              </Button>
            )}
            <Button
              variant={installed ? 'primary' : 'outline'}
              onClick={handleRecheck}
              isLoading={isChecking}
              leftIcon={<RefreshCw className="w-4 h-4" />}
            >
              {installed ? 'Continue' : 'I’ve installed it / Recheck'}
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
