import React from 'react'
import type { WalletTransaction } from '@/types/database'
import { formatUSD } from '@/lib/utils'
import { ArrowDownLeft, ArrowUpRight, Clock, History } from 'lucide-react'

interface TransactionHistoryProps {
  transactions: WalletTransaction[]
  isLoading?: boolean
}

export const TransactionHistory: React.FC<TransactionHistoryProps> = ({
  transactions,
  isLoading,
}) => {
  return (
    <div className="rounded-xl border border-[#27272a] bg-[#121215] p-5">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-[#a1a1aa] uppercase tracking-wider">
          <History className="w-4 h-4 text-[#ef4444]" />
          <span>Wallet Transactions</span>
        </div>
        <span className="text-xs text-[#71717a]">
          {transactions.length} recorded {transactions.length === 1 ? 'event' : 'events'}
        </span>
      </div>

      {isLoading ? (
        <div className="py-8 text-center text-xs text-[#71717a]">Loading transaction ledger...</div>
      ) : transactions.length === 0 ? (
        <div className="py-8 text-center text-xs text-[#71717a] border border-dashed border-[#27272a] rounded-lg">
          No transactions yet. Complete your first top up above to fund your live video sessions.
        </div>
      ) : (
        <div className="divide-y divide-[#1f1f24] overflow-hidden">
          {transactions.map((tx) => {
            const isCredit = tx.amount > 0
            const displayAmount = Math.abs(tx.amount) / 100
            const formattedDate = new Date(tx.created_at).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })

            return (
              <div
                key={tx.id}
                className="py-3 flex items-center justify-between hover:bg-[#16161b]/60 px-2 rounded-lg transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div
                    className={`w-7 h-7 rounded-lg flex items-center justify-center border ${
                      isCredit
                        ? 'bg-emerald-950/40 border-emerald-800 text-emerald-400'
                        : 'bg-red-950/40 border-red-800 text-red-400'
                    }`}
                  >
                    {isCredit ? (
                      <ArrowDownLeft className="w-3.5 h-3.5" />
                    ) : (
                      <ArrowUpRight className="w-3.5 h-3.5" />
                    )}
                  </div>
                  <div>
                    <div className="text-xs font-medium text-[#f4f4f5] flex items-center gap-2">
                      <span>{tx.description || tx.type.replace(/_/g, ' ')}</span>
                      <span
                        className={`text-[10px] px-1.5 py-0.2 rounded uppercase font-semibold ${
                          tx.status === 'completed'
                            ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                            : 'bg-amber-950 text-amber-400 border border-amber-800'
                        }`}
                      >
                        {tx.status}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-[#71717a] mt-0.5">
                      <Clock className="w-3 h-3" />
                      <span>{formattedDate}</span>
                      {tx.reference && (
                        <span className="font-mono text-[#52525b]">Ref: {tx.reference}</span>
                      )}
                    </div>
                  </div>
                </div>

                <div
                  className={`text-xs font-mono font-bold ${
                    isCredit ? 'text-emerald-400' : 'text-[#f4f4f5]'
                  }`}
                >
                  {isCredit ? '+' : '-'}
                  {formatUSD(displayAmount)}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
