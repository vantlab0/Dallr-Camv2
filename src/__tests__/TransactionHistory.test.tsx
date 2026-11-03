import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TransactionHistory } from '../components/wallet/TransactionHistory'
import type { WalletTransaction } from '../types/database'

describe('TransactionHistory Component', () => {
  it('renders empty state when no transactions exist', () => {
    render(<TransactionHistory transactions={[]} />)

    expect(screen.getByText(/No transactions yet/i)).toBeInTheDocument()
    expect(screen.getByText('0 recorded events')).toBeInTheDocument()
  })

  it('renders transactions with proper status and amounts', () => {
    const mockTxs: WalletTransaction[] = [
      {
        id: 'tx-1',
        wallet_id: 'w-1',
        user_id: 'u-1',
        type: 'top_up',
        amount: 2500, // +$25.00
        currency: 'USD',
        status: 'completed',
        reference: 'dallr_ref_101',
        description: 'Paystack Top Up',
        created_at: new Date('2024-02-01T12:00:00Z').toISOString(),
      },
      {
        id: 'tx-2',
        wallet_id: 'w-1',
        user_id: 'u-1',
        type: 'live_session_charge',
        amount: -240, // -$2.40 (60s @ $0.04/s)
        currency: 'USD',
        status: 'completed',
        reference: null,
        description: 'Broadcast session charge',
        created_at: new Date('2024-02-01T12:30:00Z').toISOString(),
      },
    ]

    render(<TransactionHistory transactions={mockTxs} />)

    expect(screen.getByText('Paystack Top Up')).toBeInTheDocument()
    expect(screen.getByText('+$25.00')).toBeInTheDocument()
    expect(screen.getByText('Ref: dallr_ref_101')).toBeInTheDocument()

    expect(screen.getByText('Broadcast session charge')).toBeInTheDocument()
    expect(screen.getByText('-$2.40')).toBeInTheDocument()
  })
})
