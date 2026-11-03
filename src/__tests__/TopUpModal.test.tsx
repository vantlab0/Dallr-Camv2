import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { TopUpModal } from '../components/wallet/TopUpModal'

describe('TopUpModal Component', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onInitiatePayment: vi.fn(),
    onVerifyPayment: vi.fn(),
    exchangeRateUSDToNGN: 1550,
    minimumTopUpUSD: 15,
  }

  it('renders with default preset amounts and displays accurate exchange calculations', () => {
    render(<TopUpModal {...defaultProps} />)

    expect(screen.getByText('Top Up Studio Wallet')).toBeInTheDocument()
    expect(screen.getByDisplayValue('25')).toBeInTheDocument()

    // 25 * 1550 = 38,750
    expect(screen.getByText(/38,750/)).toBeInTheDocument()
  })

  it('prevents entering amounts below minimum $15.00', async () => {
    render(<TopUpModal {...defaultProps} />)

    const input = screen.getByRole('spinbutton')
    fireEvent.change(input, { target: { value: '10' } })

    expect(screen.getByText('Minimum top-up amount is $15.00 USD')).toBeInTheDocument()

    const submitBtn = screen.getByRole('button', { name: /Continue to Paystack/i })
    expect(submitBtn).toBeDisabled()
  })

  it('allows clicking quick preset buttons', async () => {
    render(<TopUpModal {...defaultProps} />)

    const preset50Btn = screen.getByRole('button', { name: '$50' })
    fireEvent.click(preset50Btn)

    expect(screen.getByDisplayValue('50')).toBeInTheDocument()
    // 50 * 1550 = 77,500
    expect(screen.getByText(/77,500/)).toBeInTheDocument()
  })

  it('calls onInitiatePayment and transitions to verification view on submit', async () => {
    const mockInitiate = vi.fn().mockResolvedValue({
      reference: 'dallr_test_ref_999',
      authorization_url: 'https://checkout.paystack.com/999',
      access_code: 'code999',
      ngn_amount_kobo: 3875000,
      usd_credit_amount_cents: 2500,
      exchange_rate_used: 1550,
    })

    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null)

    render(<TopUpModal {...defaultProps} onInitiatePayment={mockInitiate} />)

    const submitBtn = screen.getByRole('button', { name: /Continue to Paystack/i })
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(mockInitiate).toHaveBeenCalledWith(25)
      expect(openSpy).toHaveBeenCalledWith(
        'https://checkout.paystack.com/999',
        '_blank',
        'noopener,noreferrer'
      )
    })

    expect(screen.getByText('dallr_test_ref_999')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Verify Payment/i })).toBeInTheDocument()

    openSpy.mockRestore()
  })
})
