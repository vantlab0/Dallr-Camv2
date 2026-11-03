import React, { useState, useRef } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import {
  UploadCloud,
  Image as ImageIcon,
  Trash2,
  RefreshCw,
  Radio,
  CheckCircle2,
  AlertCircle,
  Sparkles,
  ChevronDown,
  ChevronUp,
  XCircle,
  RotateCcw,
  Wallet,
  Loader2,
} from 'lucide-react'
import { validateAndProcessReferenceImage, ImageValidationError } from '@/services/imageService'
import { useLiveSession } from '@/hooks/useLiveSession'
import { promptManager, DEFAULT_TRANSFORMATION_PROMPT } from '@/config/prompts'
import type { PreparedImageReference } from '@/types/live'

interface LiveSetupModalProps {
  isOpen: boolean
  userId?: string | null
  currentBalanceUSD?: number
  onClose: () => void
  onTopUpClick?: () => void
}

export const LiveSetupModal: React.FC<LiveSetupModalProps> = ({
  isOpen,
  userId,
  currentBalanceUSD,
  onClose,
  onTopUpClick,
}) => {
  const [preparedImage, setPreparedImage] = useState<PreparedImageReference | null>(null)
  const [isProcessingImage, setIsProcessingImage] = useState<boolean>(false)
  const [isDragging, setIsDragging] = useState<boolean>(false)
  const [prompt, setPrompt] = useState<string>(() => promptManager.getActivePrompt())
  const [isPromptExpanded, setIsPromptExpanded] = useState<boolean>(false)
  const [imageError, setImageError] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const {
    status,
    isLoading: isSessionLoading,
    error: sessionError,
    preparedSession,
    prepareLiveSession,
    cancelSession,
    resetSession,
    clearError: clearSessionError,
  } = useLiveSession({ userId })

  const handleProcessFile = async (file: File) => {
    setImageError(null)
    clearSessionError()
    setIsProcessingImage(true)

    try {
      const processed = await validateAndProcessReferenceImage(file)
      setPreparedImage(processed)
    } catch (err: unknown) {
      if (err instanceof ImageValidationError) {
        setImageError(err.message)
      } else if (err instanceof Error) {
        setImageError(err.message)
      } else {
        setImageError('Failed to process image reference.')
      }
      setPreparedImage(null)
    } finally {
      setIsProcessingImage(false)
    }
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      void handleProcessFile(e.dataTransfer.files[0])
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      void handleProcessFile(e.target.files[0])
    }
  }

  const handleRemoveImage = () => {
    setPreparedImage(null)
    setImageError(null)
    clearSessionError()
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleGoLive = async () => {
    if (!preparedImage) {
      setImageError('Please select a reference image before starting the live video call.')
      return
    }

    promptManager.setActivePrompt(prompt)
    await prepareLiveSession(preparedImage, prompt)
  }

  const handleResetAll = () => {
    cancelSession()
    resetSession()
    handleRemoveImage()
    setPrompt(promptManager.getDefaultPrompt())
    onClose()
  }

  const activeError = imageError || sessionError
  const isInsufficientBalance =
    sessionError && sessionError.toLowerCase().includes('insufficient')

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleResetAll}
      title="Live Video Call Setup"
      description="Select reference portrait and prepare pipeline prior to initializing Decart live streaming."
      maxWidth="lg"
    >
      {/* SUCCESS / READY FOR ENGINE STATE */}
      {status === 'ready_for_engine' && preparedSession ? (
        <div className="py-6 space-y-5 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-red-950/40 border border-red-500/50 flex items-center justify-center text-[#ef4444] animate-pulse">
            <Radio className="w-8 h-8" />
          </div>

          <div>
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-xs font-semibold uppercase tracking-wider">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              Session Prepared & Verified
            </span>
            <h4 className="text-lg font-bold text-[#f4f4f5] mt-2">
              Ready for Decart Real-Time Video Engine
            </h4>
            <p className="text-xs text-[#a1a1aa] mt-1.5 max-w-md mx-auto leading-relaxed">
              Reference portrait validated and decoded ({preparedSession.referenceImage.width}×
              {preparedSession.referenceImage.height}px). User authenticated and USD wallet verified with sufficient balance.
            </p>
          </div>

          <div className="bg-[#121215] border border-[#27272a] rounded-xl p-4 max-w-md mx-auto text-left space-y-2.5 text-xs">
            <div className="flex items-center justify-between pb-2 border-b border-[#27272a]">
              <span className="text-[#a1a1aa]">Session ID</span>
              <span className="font-mono text-[#f4f4f5] text-[11px]">{preparedSession.sessionId}</span>
            </div>
            <div className="flex items-center justify-between pb-2 border-b border-[#27272a]">
              <span className="text-[#a1a1aa]">Billing Rate</span>
              <span className="text-[#f4f4f5] font-medium">${preparedSession.ratePerSecondUSD.toFixed(2)}/sec</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[#a1a1aa]">Current Balance</span>
              <span className="text-emerald-400 font-semibold">${preparedSession.initialBalanceUSD.toFixed(2)} USD</span>
            </div>
          </div>

          {preparedImage && (
            <div className="w-24 h-24 mx-auto rounded-xl overflow-hidden border-2 border-[#ef4444] shadow-lg relative">
              <img
                src={preparedImage.dataUrl}
                alt="Broadcast avatar"
                className="w-full h-full object-cover"
              />
            </div>
          )}

          <div className="pt-2 flex items-center justify-center gap-3">
            <Button variant="secondary" onClick={handleResetAll} className="w-full sm:w-auto">
              Return to Studio Dashboard
            </Button>
          </div>
        </div>
      ) : (
        /* SETUP WORKFLOW FORM */
        <div className="space-y-5">
          {/* Active Error Notice */}
          {activeError && (
            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-red-950/40 border border-red-900/60 text-xs text-red-300">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
              <div className="flex-1 space-y-1">
                <span className="leading-relaxed block">{activeError}</span>
                {isInsufficientBalance && onTopUpClick && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      onClose()
                      onTopUpClick()
                    }}
                    className="mt-2 text-xs py-1 px-3 border-red-800 text-red-200 hover:bg-red-900/30"
                  >
                    <Wallet className="w-3.5 h-3.5 mr-1" />
                    Top Up Wallet Balance
                  </Button>
                )}
              </div>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={handleInputChange}
          />

          {/* Reference Image Upload Area */}
          {!preparedImage ? (
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-200 ${
                isDragging
                  ? 'border-[#ef4444] bg-[#ef4444]/5 scale-[0.99]'
                  : 'border-[#27272a] hover:border-[#3f3f46] hover:bg-[#151518] bg-[#0d0d10]'
              }`}
            >
              <div className="w-12 h-12 rounded-full bg-[#1a1a1f] border border-[#27272a] flex items-center justify-center text-[#a1a1aa] mb-3">
                {isProcessingImage ? (
                  <Loader2 className="w-6 h-6 text-[#ef4444] animate-spin" />
                ) : (
                  <UploadCloud className="w-6 h-6 text-[#ef4444]" />
                )}
              </div>
              <h4 className="text-sm font-semibold text-[#f4f4f5]">
                {isProcessingImage ? 'Validating and Decoding Image...' : 'Upload Reference Portrait Image'}
              </h4>
              <p className="text-xs text-[#a1a1aa] mt-1 max-w-xs">
                Drag and drop your reference image here, or click to browse files
              </p>
              <div className="flex items-center gap-2 mt-4 text-[11px] text-[#71717a]">
                <span>Supported: PNG, JPG, JPEG, WebP (up to 10MB)</span>
              </div>
            </div>
          ) : (
            /* Image Preview & Management */
            <div className="rounded-xl border border-[#27272a] bg-[#0e0e11] p-4 space-y-4">
              <div className="relative aspect-video max-h-60 w-full rounded-lg overflow-hidden bg-black/60 border border-[#27272a] flex items-center justify-center">
                <img
                  src={preparedImage.dataUrl}
                  alt="Reference portrait preview"
                  className="max-h-full max-w-full object-contain"
                />
                <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/70 backdrop-blur-md text-[10px] text-white/90 border border-white/10 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                  <span>
                    Valid {preparedImage.mimeType.replace('image/', '').toUpperCase()} ({preparedImage.width}×
                    {preparedImage.height}px)
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs text-[#a1a1aa]">
                <div className="flex items-center gap-2 truncate max-w-[220px]">
                  <ImageIcon className="w-4 h-4 text-[#ef4444] shrink-0" />
                  <span className="truncate">{preparedImage.name}</span>
                </div>
                <span className="text-[#71717a]">
                  {(preparedImage.size / (1024 * 1024)).toFixed(2)} MB
                </span>
              </div>

              <div className="flex items-center gap-2 pt-1 border-t border-[#1a1a1f]">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => fileInputRef.current?.click()}
                  leftIcon={<RefreshCw className="w-3.5 h-3.5" />}
                  className="flex-1"
                  disabled={isSessionLoading}
                >
                  Replace Image
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleRemoveImage}
                  leftIcon={<Trash2 className="w-3.5 h-3.5 text-red-400" />}
                  className="text-red-400 hover:text-red-300 hover:border-red-900/60"
                  disabled={isSessionLoading}
                >
                  Remove
                </Button>
              </div>
            </div>
          )}

          {/* Transformation Prompt Configuration (Configurable Internally & Collapsible) */}
          <div className="rounded-xl border border-[#27272a] bg-[#121215] p-3.5 space-y-2">
            <div
              className="flex items-center justify-between cursor-pointer select-none"
              onClick={() => setIsPromptExpanded(!isPromptExpanded)}
            >
              <div className="flex items-center gap-2">
                <Sparkles className="w-4 h-4 text-[#ef4444]" />
                <span className="text-xs font-semibold text-[#f4f4f5]">
                  Transformation Prompt Instructions
                </span>
              </div>
              <div className="flex items-center gap-1 text-[#a1a1aa] hover:text-[#f4f4f5] text-xs">
                <span>{isPromptExpanded ? 'Hide' : 'Configure'}</span>
                {isPromptExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
              </div>
            </div>

            {isPromptExpanded ? (
              <div className="pt-2 space-y-2 border-t border-[#27272a]/60">
                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  rows={4}
                  className="w-full text-xs bg-[#09090b] border border-[#27272a] rounded-lg p-2.5 text-[#f4f4f5] focus:outline-none focus:border-[#ef4444] resize-none leading-relaxed"
                  placeholder="Enter transformation prompt instructions..."
                  disabled={isSessionLoading}
                />
                <div className="flex items-center justify-between text-[11px] text-[#71717a]">
                  <span>Visual guidance instructions passed to the live stream pipeline.</span>
                  <button
                    type="button"
                    onClick={() => setPrompt(DEFAULT_TRANSFORMATION_PROMPT)}
                    className="text-[#ef4444] hover:underline flex items-center gap-1"
                    disabled={isSessionLoading}
                  >
                    <RotateCcw className="w-3 h-3" />
                    Reset Default
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-[#71717a] line-clamp-1">
                {prompt}
              </p>
            )}
          </div>

          {/* Wallet Balance Pre-check Notice */}
          <div className="flex items-center justify-between px-3.5 py-2.5 rounded-lg bg-[#141418] border border-[#27272a] text-xs">
            <div className="flex items-center gap-2 text-[#a1a1aa]">
              <Wallet className="w-3.5 h-3.5 text-[#ef4444]" />
              <span>Wallet Pre-check:</span>
              <span className="font-medium text-[#f4f4f5]">
                {currentBalanceUSD !== undefined ? `$${currentBalanceUSD.toFixed(2)} USD` : 'Checking...'}
              </span>
            </div>
            <span className="text-[11px] text-[#71717a]">Rate: $0.04 USD / sec</span>
          </div>

          {/* Modal Actions */}
          <div className="flex items-center justify-between pt-3 border-t border-[#1f1f24]">
            {isSessionLoading ? (
              <Button
                variant="outline"
                size="sm"
                onClick={cancelSession}
                leftIcon={<XCircle className="w-4 h-4 text-amber-400" />}
                className="text-amber-400 border-amber-900/60 hover:bg-amber-950/20"
              >
                Cancel Initialization
              </Button>
            ) : (
              <Button variant="ghost" onClick={handleResetAll}>
                Cancel
              </Button>
            )}

            <Button
              variant="primary"
              onClick={handleGoLive}
              isLoading={isSessionLoading}
              disabled={!preparedImage || isSessionLoading || isProcessingImage}
              leftIcon={<Radio className="w-4 h-4" />}
            >
              {isSessionLoading ? 'Verifying & Preparing...' : 'Go Live'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
