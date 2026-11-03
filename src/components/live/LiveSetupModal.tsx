import React, { useState, useRef } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { UploadCloud, Image as ImageIcon, Trash2, RefreshCw, Radio, CheckCircle2, AlertCircle } from 'lucide-react'

interface LiveSetupModalProps {
  isOpen: boolean
  onClose: () => void
}

export const LiveSetupModal: React.FC<LiveSetupModalProps> = ({ isOpen, onClose }) => {
  const [selectedFile, setSelectedFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState<boolean>(false)
  const [isLaunching, setIsLaunching] = useState<boolean>(false)
  const [streamActive, setStreamActive] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFileProcess = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file (PNG, JPG, WebP)')
      return
    }
    setError(null)
    setSelectedFile(file)
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
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
      handleFileProcess(e.dataTransfer.files[0])
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      handleFileProcess(e.target.files[0])
    }
  }

  const handleRemoveImage = () => {
    setSelectedFile(null)
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl)
    }
    setPreviewUrl(null)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleGoLive = () => {
    if (!selectedFile) {
      setError('Please provide a portrait reference before going live')
      return
    }
    setIsLaunching(true)
    setTimeout(() => {
      setIsLaunching(false)
      setStreamActive(true)
    }, 1200)
  }

  const handleResetModal = () => {
    setStreamActive(false)
    handleRemoveImage()
    onClose()
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleResetModal}
      title="Live Video Call Setup"
      description="Select and verify your portrait identity model prior to broadcasting."
      maxWidth="lg"
    >
      {streamActive ? (
        <div className="py-6 space-y-5 text-center">
          <div className="w-16 h-16 mx-auto rounded-full bg-red-950/40 border border-red-500/50 flex items-center justify-center text-[#ef4444] animate-pulse">
            <Radio className="w-8 h-8" />
          </div>

          <div>
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 text-red-400 border border-red-500/30 text-xs font-semibold uppercase tracking-wider">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-ping inline-block" />
              Broadcasting Initialized
            </span>
            <h4 className="text-lg font-bold text-[#f4f4f5] mt-2">
              Ready for Phase 2 Live Stream Engine
            </h4>
            <p className="text-xs text-[#a1a1aa] mt-1 max-w-sm mx-auto">
              Selected avatar reference locked. Real-time Decart video calling engine integration scheduled for Phase 2.
            </p>
          </div>

          {previewUrl && (
            <div className="w-24 h-24 mx-auto rounded-xl overflow-hidden border-2 border-[#ef4444] shadow-lg relative">
              <img
                src={previewUrl}
                alt="Broadcast avatar"
                className="w-full h-full object-cover"
              />
            </div>
          )}

          <div className="pt-2">
            <Button variant="secondary" onClick={handleResetModal} className="w-full sm:w-auto">
              Return to Studio Dashboard
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {error && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-red-950/30 border border-red-900/50 text-xs text-red-300">
              <AlertCircle className="w-4 h-4 text-red-400 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleInputChange}
          />

          {!previewUrl ? (
            /* Upload Dropzone */
            <div
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center text-center cursor-pointer transition-all duration-200 ${
                isDragging
                  ? 'border-[#ef4444] bg-[#ef4444]/5'
                  : 'border-[#27272a] hover:border-[#3f3f46] hover:bg-[#151518] bg-[#0d0d10]'
              }`}
            >
              <div className="w-12 h-12 rounded-full bg-[#1a1a1f] border border-[#27272a] flex items-center justify-center text-[#a1a1aa] mb-3 group-hover:text-[#f4f4f5]">
                <UploadCloud className="w-6 h-6 text-[#ef4444]" />
              </div>
              <h4 className="text-sm font-semibold text-[#f4f4f5]">
                Upload Portrait Image
              </h4>
              <p className="text-xs text-[#a1a1aa] mt-1 max-w-xs">
                Drag and drop your identity portrait here, or click to browse files
              </p>
              <div className="flex items-center gap-2 mt-4 text-[11px] text-[#71717a]">
                <span>PNG, JPG, WebP up to 10MB</span>
              </div>
            </div>
          ) : (
            /* Image Preview & Actions */
            <div className="rounded-xl border border-[#27272a] bg-[#0e0e11] p-4 space-y-4">
              <div className="relative aspect-video max-h-64 w-full rounded-lg overflow-hidden bg-black/40 border border-[#27272a] flex items-center justify-center">
                <img
                  src={previewUrl}
                  alt="Identity portrait preview"
                  className="max-h-full max-w-full object-contain"
                />
                <div className="absolute top-2 left-2 px-2 py-0.5 rounded bg-black/70 backdrop-blur-md text-[10px] text-white/90 border border-white/10 flex items-center gap-1.5">
                  <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                  <span>Reference Loaded</span>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs text-[#a1a1aa]">
                <div className="flex items-center gap-2 truncate max-w-[200px]">
                  <ImageIcon className="w-4 h-4 text-[#ef4444] shrink-0" />
                  <span className="truncate">{selectedFile?.name}</span>
                </div>
                <span className="text-[#71717a]">
                  {selectedFile ? (selectedFile.size / (1024 * 1024)).toFixed(2) : '0'} MB
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
                >
                  Remove
                </Button>
              </div>
            </div>
          )}

          {/* Modal Footer */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#1f1f24]">
            <Button variant="ghost" onClick={handleResetModal}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleGoLive}
              isLoading={isLaunching}
              disabled={!selectedFile}
              leftIcon={<Radio className="w-4 h-4" />}
            >
              Go Live
            </Button>
          </div>
        </div>
      )}
    </Modal>
  )
}
