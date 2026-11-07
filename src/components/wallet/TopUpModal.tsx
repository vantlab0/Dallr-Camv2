import React, { useState, useEffect, useRef } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { formatNGN, formatUSD } from '@/lib/utils'
import { DollarSign, ArrowRight, ShieldCheck, Check, AlertCircle, RefreshCw } from 'lucide-react'
import type { TopUpInitResponse } from '@/types/wallet'

interface TopUpModalProps {
  isOpen: boolean
  onClose: () => void
  onInitiatePayment: (amountUSD: number) => Promise<TopUpInitResponse>
  onVerifyPayment: (reference: string) => Promise<unknown>
  exchangeRateUSDToNGN: number
  minimumTopUpUSD?: number
}

const PRESET_AMOUNTS = [15, 25, 50, 100]

export const TopUpModal: React.FC<TopUpModalProps> = ({
  isOpen,
  onClose,
  onInitiatePayment,
  onVerifyPayment,
  exchangeRateUSDToNGN,
  minimumTopUpUSD = 15,
}) => {
  const [amount, setAmount] = useState<string>('25')
  const [validationError, setValidationError] = useState<string | null>(null)
  const [isInitializing, setIsInitializing] = useState<boolean>(false)
  const [isVerifying, setIsVerifying] = useState<boolean>(false)
  const [activePayment, setActivePayment] = useState<TopUpInitResponse | null>(null)
  const [isSuccess, setIsSuccess] = useState<boolean>(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [paystackPopLoaded, setPaystackPopLoaded] = useState<boolean>(false)
  const paystackScriptRef = useRef<HTMLScriptElement | null>(null)

  const numAmount = parseFloat(amount) || 0
  const ngnEquivalent = numAmount * exchangeRateUSDToNGN

  // Load Paystack Pop inline JS SDK once
  useEffect(() => {
    if (paystackScriptRef.current || paystackPopLoaded) return

    const script = document.createElement('script')
    script.src = 'https://js.paystack.co/v1/inline.js'
    script.async = true
    script.onload = () => {
      setPaystackPopLoaded(true)
    }
    script.onerror = () => {
      console.error('Failed to load Paystack Pop inline.js')
    }
    document.head.appendChild(script)
    paystackScriptRef.current = script

    return () => {
      // Keep script loaded for the session; do not remove
    }
  }, [paystackPopLoaded])

  const handleAmountChange = (val: string) => {
    setAmount(val)
    const num = parseFloat(val)
    if (isNaN(num) || num < minimumTopUpUSD) {
      setValidationError(`Minimum top-up amount is $${minimumTopUpUSD}.00 USD`)
    } else {
      setValidationError(null)
    }
  }

  const handleSelectPreset = (preset: number) => {
    setAmount(preset.toString())
    setValidationError(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (isNaN(numAmount) || numAmount < minimumTopUpUSD) {
      setValidationError(`Minimum top-up amount is $${minimumTopUpUSD}.00 USD`)
      return
    }

    setIsInitializing(true)
    setStatusMessage(null)

    try {
      const payment = await onInitiatePayment(numAmount)
      setActivePayment(payment)

      // Open Paystack Inline Popup within the app (no external tab)
      if (typeof window !== 'undefined' && (window as any).PaystackPop) {
        ;(window as any).PaystackPop.setup({
          key: payment.public_key,
          email: undefined, // Paystack will prompt for email if not set
          amount: payment.ngn_amount_kobo, // amount in kobo
          ref: payment.reference,
          metadata: {
            user_email: undefined,
            amount_usd: numAmount,
            app: 'Dallr Cam',
          },
          callback: (_response: any) => {
            // Paystack Pop callback - transaction successful on gateway
            // Still verify server-side for security
            void onVerifyPayment(payment.reference).then((res: any) => {
              if (res?.status === 'success') {
                setIsSuccess(true)
                setTimeout(() => {
                  handleClose()
                }, 1500)
              } else {
                setStatusMessage(res?.message || 'Payment is awaiting confirmation or incomplete.')
              }
            }).catch((err: any) => {
              setStatusMessage(err instanceof Error ? err.message : 'Failed to verify payment')
            })
          },
          onClose: () => {
            // User closed the popup without completing
            setStatusMessage('Payment popup was closed. You can retry or verify below.')
          },
        })
        ;(window as any).PaystackPop.openIframe()
      } else if (payment.authorization_url) {
        // Fallback: open in new tab if Paystack Pop not available
        window.open(payment.authorization_url, '_blank', 'noopener,noreferrer')
      }
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Could not initialize payment')
    } finally {
      setIsInitializing(false)
    }
  }

  const handleCheckStatus = async () => {
    if (!activePayment) return
    setIsVerifying(true)
    setStatusMessage(null)

    try {
      const res = (await onVerifyPayment(activePayment.reference)) as {
        status: string
        message?: string
      }
      if (res?.status === 'success') {
        setIsSuccess(true)
        setTimeout(() => {
          handleClose()
        }, 1500)
      } else {
        setStatusMessage(res?.message || 'Payment is awaiting confirmation or incomplete.')
      }
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : 'Failed to verify payment')
    } finally {
      setIsVerifying(false)
    }
  }

  const handleClose = () => {
    setActivePayment(null)
    setIsSuccess(false)
    setStatusMessage(null)
    setValidationError(null)
    onClose()
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      title="Top Up Studio Wallet"
      description="Add funds to your Dallr balance for low-latency live streaming sessions."
      maxWidth="md"
    >
      {isSuccess ? (
        <div className="py-8 flex flex-col items-center text-center space-y-3">
          <div className="w-12 h-12 rounded-full bg-emerald-950/50 border border-emerald-800 text-emerald-400 flex items-center justify-center">
            <Check className="w-6 h-6" />
          </div>
          <h4 className="text-base font-semibold text-[#f4f4f5]">Payment Confirmed</h4>
          <p className="text-xs text-[#a1a1aa]">
            Successfully credited {formatUSD(numAmount)} to your USD wallet.
          </p>
        </div>
      ) : activePayment ? (
        <div className="space-y-5 py-2">
          <div className="p-4 rounded-xl bg-[#141419] border border-[#27272a] space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-[#a1a1aa]">Transaction Reference</span>
              <span className="text-xs font-mono text-[#f4f4f5]">{activePayment.reference}</span>
            </div>
            <div className="flex items-center justify-between border-t border-[#1f1f24] pt-2">
              <span className="text-xs text-[#a1a1aa]">NGN Charge Amount</span>
              <span className="text-xs font-mono font-bold text-emerald-400">
                {formatNGN(activePayment.ngn_amount_kobo / 100)}
              </span>
            </div>
            <div className="flex items-center justify-between border-t border-[#1f1f24] pt-2">
              <span className="text-xs text-[#a1a1aa]">USD Credit Amount</span>
              <span className="text-xs font-mono font-bold text-[#f4f4f5]">
                {formatUSD(activePayment.usd_credit_amount_cents / 100)}
              </span>
            </div>
          </div>

          <div className="text-center space-y-2">
            <p className="text-xs text-[#a1a1aa]">
              Paystack popup opened above. Complete the payment, then verify your balance.
            </p>
            <button
              onClick={handleSubmit}
              disabled={isInitializing}
              className="inline-flex items-center gap-1.5 text-xs text-[#ef4444] hover:underline underline-offset-4"
            >
              <span>Reopen payment popup</span>
            </button>
          </div>

          {statusMessage && (
            <div className="p-3 rounded-lg bg-amber-950/30 border border-amber-800 text-amber-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{statusMessage}</span>
            </div>
          )}

          <div className="flex items-center gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={handleClose} className="flex-1">
              Close
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={handleCheckStatus}
              isLoading={isVerifying}
              className="flex-1"
              leftIcon={<RefreshCw className={`w-4 h-4 ${isVerifying ? 'animate-spin' : ''}`} />}
            >
              Verify Payment
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5">
          {statusMessage && (
            <div className="p-3 rounded-lg bg-red-950/30 border border-red-800 text-red-300 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{statusMessage}</span>
            </div>
          )}

          {/* Amount input */}
          <div className="space-y-1.5">
            <Input
              label={`Amount in USD (Min. $${minimumTopUpUSD}.00)`}
              type="number"
              min={minimumTopUpUSD}
              step="1"
              value={amount}
              onChange={(e) => handleAmountChange(e.target.value)}
              error={validationError || undefined}
              leftIcon={<DollarSign className="w-4 h-4 text-[#ef4444]" />}
              placeholder="15"
              autoFocus
            />
          </div>

          {/* Preset Buttons */}
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-[#a1a1aa] tracking-wide">
              Quick Select
            </label>
            <div className="grid grid-cols-4 gap-2">
              {PRESET_AMOUNTS.map((preset) => (
                <button
                  type="button"
                  key={preset}
                  onClick={() => handleSelectPreset(preset)}
                  className={`py-2 px-3 text-xs font-semibold rounded-lg border transition-all cursor-pointer ${
                    numAmount === preset
                      ? 'bg-[#ef4444]/15 border-[#ef4444] text-[#ef4444]'
                      : 'bg-[#1a1a1f] border-[#27272a] text-[#a1a1aa] hover:border-[#3f3f46] hover:text-[#f4f4f5]'
                  }`}
                >
                  ${preset}
                </button>
              ))}
            </div>
          </div>

          {/* Currency Preview / Exchange rate card */}
          <div className="rounded-lg bg-[#0e0e11] border border-[#27272a] p-3.5 space-y-2">
            <div className="flex justify-between items-center text-xs">
              <span className="text-[#a1a1aa]">Exchange Rate (Backend Trusted)</span>
              <span className="text-[#f4f4f5] font-mono">
                1 USD = {formatNGN(exchangeRateUSDToNGN).replace('.00', '')}
              </span>
            </div>
            <div className="border-t border-[#1f1f24] pt-2 flex justify-between items-center">
              <span className="text-xs font-medium text-[#d4d4d8]">Paystack NGN Total</span>
              <span className="text-sm font-bold text-emerald-400 font-mono">
                {formatNGN(ngnEquivalent)}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 text-[11px] text-[#71717a]">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>Secured via Paystack payment gateway. Instant USD credit on confirmation.</span>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-3 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={handleClose}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              className="flex-1"
              isLoading={isInitializing}
              disabled={Boolean(validationError) || numAmount < minimumTopUpUSD}
              rightIcon={<ArrowRight className="w-4 h-4" />}
            >
              Continue to Paystack
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}
