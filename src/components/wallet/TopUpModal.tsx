import React, { useState } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Input } from '@/components/ui/Input'
import { Button } from '@/components/ui/Button'
import { formatNGN, formatUSD } from '@/lib/utils'
import { DollarSign, ArrowRight, ShieldCheck, Check } from 'lucide-react'

interface TopUpModalProps {
  isOpen: boolean
  onClose: () => void
  onSuccess: (amountUSD: number) => void
  exchangeRateUSDToNGN: number
}

const PRESET_AMOUNTS = [15, 25, 50, 100]

export const TopUpModal: React.FC<TopUpModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  exchangeRateUSDToNGN,
}) => {
  const [amount, setAmount] = useState<string>('25')
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [isSuccess, setIsSuccess] = useState<boolean>(false)

  const numAmount = parseFloat(amount) || 0
  const ngnEquivalent = numAmount * exchangeRateUSDToNGN

  const handleAmountChange = (val: string) => {
    setAmount(val)
    const num = parseFloat(val)
    if (isNaN(num) || num < 15) {
      setError('Minimum top up amount is $15.00')
    } else {
      setError(null)
    }
  }

  const handleSelectPreset = (preset: number) => {
    setAmount(preset.toString())
    setError(null)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (isNaN(numAmount) || numAmount < 15) {
      setError('Minimum top up amount is $15.00')
      return
    }

    setIsLoading(true)
    setTimeout(() => {
      setIsLoading(false)
      setIsSuccess(true)
      setTimeout(() => {
        onSuccess(numAmount)
        setIsSuccess(false)
        onClose()
      }, 900)
    }, 700)
  }

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Top Up Studio Wallet"
      description="Add funds to your Dallr balance for low-latency live streaming sessions."
      maxWidth="md"
    >
      {isSuccess ? (
        <div className="py-8 flex flex-col items-center text-center space-y-3">
          <div className="w-12 h-12 rounded-full bg-emerald-950/50 border border-emerald-800 text-emerald-400 flex items-center justify-center">
            <Check className="w-6 h-6" />
          </div>
          <h4 className="text-base font-semibold text-[#f4f4f5]">Balance Updated</h4>
          <p className="text-xs text-[#a1a1aa]">
            Successfully added {formatUSD(numAmount)} to your studio wallet.
          </p>
        </div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Amount input */}
          <div className="space-y-1.5">
            <Input
              label="Amount in USD (Min. $15)"
              type="number"
              min="15"
              step="1"
              value={amount}
              onChange={(e) => handleAmountChange(e.target.value)}
              error={error || undefined}
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
              <span className="text-[#a1a1aa]">Mock Conversion Rate</span>
              <span className="text-[#f4f4f5] font-mono">
                1 USD = {formatNGN(exchangeRateUSDToNGN).replace('.00', '')}
              </span>
            </div>
            <div className="border-t border-[#1f1f24] pt-2 flex justify-between items-center">
              <span className="text-xs font-medium text-[#d4d4d8]">Estimated NGN Total</span>
              <span className="text-sm font-bold text-emerald-400 font-mono">
                {formatNGN(ngnEquivalent)}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 text-[11px] text-[#71717a]">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
            <span>Encrypted payment gateway. Phase 1 sandbox testing.</span>
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-3 pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              className="flex-1"
              isLoading={isLoading}
              disabled={Boolean(error) || numAmount < 15}
              rightIcon={<ArrowRight className="w-4 h-4" />}
            >
              Continue to Payment
            </Button>
          </div>
        </form>
      )}
    </Modal>
  )
}
