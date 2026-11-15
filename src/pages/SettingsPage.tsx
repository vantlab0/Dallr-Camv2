import React, { useEffect, useState, useCallback } from 'react'
import { DashboardLayout } from '@/components/dashboard/DashboardLayout'
import { Button } from '@/components/ui/Button'
import {
  Camera,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  ArrowLeft,
  Monitor,
  Terminal,
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

  const installed = status?.installed ?? false

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
                Dallr Cam publishes its transformed output to a system virtual camera device named{' '}
                <span className="text-[#f4f4f5] font-medium">“Dallr Cam”</span>. Install and set up a
                compatible virtual camera driver manually, then select “Dallr Cam” in apps like WhatsApp,
                Zoom, Meet, and Teams.
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

          {installed ? (
            <div className="flex items-center gap-2 rounded-lg border border-emerald-900/50 bg-emerald-950/20 p-2.5 text-xs text-emerald-200">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              <span>
                “Dallr Cam” is detected. Select it in your calling app’s camera settings. If it doesn’t
                appear, restart the calling app and keep Dallr Cam running while streaming.
              </span>
            </div>
          ) : (
            <div className="flex items-start gap-2 rounded-lg border border-amber-900/60 bg-amber-950/20 p-2.5 text-xs text-amber-200/90">
              <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <span>
                {status?.message ||
                  '“Dallr Cam” was not detected. Install and set up the virtual camera manually, then click Recheck status.'}
              </span>
            </div>
          )}

          <div className="rounded-lg border border-[#27272a] bg-[#0e0e11] p-3 space-y-2 text-xs text-[#d4d4d8]">
            <div className="flex items-center gap-2 text-[#f4f4f5] font-medium">
              <Terminal className="w-4 h-4 text-[#ef4444]" />
              Manual setup (Windows)
            </div>
            <ol className="list-decimal pl-5 space-y-1.5 text-[#a1a1aa] leading-relaxed">
              <li>
                Download and install a compatible UnityCapture/DirectShow virtual camera driver (32-bit and
                64-bit filters) on this PC.
              </li>
              <li>
                Register the device name as <span className="text-[#f4f4f5] font-medium">Dallr Cam</span>.
                If you have the driver DLL files, run an <span className="text-[#f4f4f5]">Administrator</span>{' '}
                Command Prompt in their folder and execute:
              </li>
            </ol>
            <pre className="mt-1 whitespace-pre-wrap rounded-md border border-[#27272a] bg-[#09090b] p-2.5 text-[11px] text-[#e4e4e7] overflow-x-auto">
{`regsvr32 /s "UnityCaptureFilter32.dll" "/i:UnityCaptureName=Dallr Cam"
regsvr32 /s "UnityCaptureFilter64.dll" "/i:UnityCaptureName=Dallr Cam"`}
            </pre>
            <p className="text-[#a1a1aa] leading-relaxed">
              After setup, restart camera apps (e.g. WhatsApp Desktop) and click <span className="text-[#f4f4f5]">Recheck status</span>.
              Dallr Cam must be running when you want to stream to the virtual camera.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              variant="outline"
              onClick={() => void refreshStatus()}
              isLoading={isChecking}
              leftIcon={<RefreshCw className="w-4 h-4" />}
            >
              Recheck status
            </Button>
          </div>
        </section>
      </div>
    </DashboardLayout>
  )
}
