import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BalanceCard } from '../components/dashboard/BalanceCard'

describe('BalanceCard Component', () => {
  it('displays the formatted balance in USD', () => {
    render(
      <BalanceCard
        balanceUSD={150.75}
        isLoading={false}
        onTopUpClick={vi.fn()}
      />
    )

    expect(screen.getByText('$150.75')).toBeInTheDocument()
    expect(screen.getByText('USD')).toBeInTheDocument()
    expect(screen.getByText(/Live video usage: \$0.04 per second/)).toBeInTheDocument()
  })

  it('triggers onTopUpClick when clicking Top Up button', () => {
    const handleTopUp = vi.fn()
    render(
      <BalanceCard
        balanceUSD={50}
        isLoading={false}
        onTopUpClick={handleTopUp}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Top Up Balance/i }))
    expect(handleTopUp).toHaveBeenCalledTimes(1)
  })

  it('shows payment feedback message if provided', () => {
    render(
      <BalanceCard
        balanceUSD={100}
        isLoading={false}
        paymentFeedback={{
          type: 'success',
          message: 'Payment confirmed and credited to wallet.',
        }}
        onTopUpClick={vi.fn()}
      />
    )

    expect(screen.getByText('Payment confirmed and credited to wallet.')).toBeInTheDocument()
  })
})
