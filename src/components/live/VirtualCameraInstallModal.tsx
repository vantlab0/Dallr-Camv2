import React, { useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { Camera, RefreshCw, AlertCircle, CheckCircle2, Terminal } from 'lucide-react'
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
  const [checkResult, setCheckResult] = useState<VirtualCameraStatus | null>(null)

  const current = checkResult ?? status
  const installed = current?.installed ?? false

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
      title="Set Up Dallr Cam Virtual Camera"
      description="To use live video in WhatsApp and other apps, you need an OS-level virtual camera device named “Dallr Cam”."
      maxWidth="md"
    >
      <div className="space-y-4">
        <div className="flex items-start gap-3 rounded-lg border border-[#27272a] bg-[#121215] p-3">
          <div className="w-9 h-9 rounded-lg bg-[#1a1a1f] border border-[#27272a] flex items-center justify-center text-[#ef4444] shrink-0">
            <Camera className="w-4 h-4" />
          </div>
          <div className="text-xs text-[#a1a1aa] leading-relaxed">
            <p className="text-[#f4f4f5] font-medium">Manual virtual camera setup required (Windows)</p>
            <p className="mt-1">
              Download and install a compatible virtual camera driver yourself, then register it as
              <span className="text-[#f4f4f5] font-medium"> “Dallr Cam”</span>. Once detected, Dallr
              will publish your transformed stream to it for use in WhatsApp, Zoom, Meet, Teams, and more.
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
                  'The “Dallr Cam” virtual camera device was not found on this system. Set it up manually, then recheck.'}
              </span>
            </div>

            <div className="rounded-lg border border-[#27272a] bg-[#121215] p-3 text-xs text-[#d4d4d8] space-y-2">
              <div className="flex items-center gap-2 text-[#f4f4f5] font-medium">
                <Terminal className="w-4 h-4 text-[#ef4444]" />
                Manual setup steps
              </div>
              <ol className="list-decimal pl-5 space-y-1.5 text-[#a1a1aa] leading-relaxed">
                <li>Download/install a compatible UnityCapture (DirectShow) virtual camera driver (32/64-bit).</li>
                <li>
                  Register it with the device name <span className="text-[#f4f4f5]">Dallr Cam</span> from an
                  Administrator Command Prompt:
                </li>
              </ol>
              <pre className="whitespace-pre-wrap rounded-md border border-[#27272a] bg-[#09090b] p-2.5 text-[11px] text-[#e4e4e7] overflow-x-auto">
{`regsvr32 /s "UnityCaptureFilter32.dll" "/i:UnityCaptureName=Dallr Cam"
regsvr32 /s "UnityCaptureFilter64.dll" "/i:UnityCaptureName=Dallr Cam"`}
              </pre>
              <p className="text-[#a1a1aa] leading-relaxed">
                Restart camera apps if needed, then click Recheck. Keep Dallr Cam running while streaming.
              </p>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-2 border-t border-[#1f1f24]">
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant={installed ? 'primary' : 'outline'}
            onClick={handleRecheck}
            isLoading={isChecking}
            leftIcon={<RefreshCw className="w-4 h-4" />}
          >
            {installed ? 'Continue' : 'I’ve set it up / Recheck'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
