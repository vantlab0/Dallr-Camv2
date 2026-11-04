import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LiveSetupModal } from '@/components/live/LiveSetupModal'
import { walletService } from '@/services/walletService'

describe('LiveSetupModal Component', () => {
  const originalImage = window.Image

  beforeEach(() => {
    vi.restoreAllMocks()

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    window.Image = class {
      width = 1280
      height = 720
      naturalWidth = 1280
      naturalHeight = 720
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      private _src = ''

      set src(val: string) {
        this._src = val
        setTimeout(() => this.onload?.(), 10)
      }

      get src() {
        return this._src
      }
    } as unknown as typeof Image
  })

  afterEach(() => {
    window.Image = originalImage
  })

  it('renders modal when open with upload dropzone and prompt instructions', () => {
    render(
      <LiveSetupModal
        isOpen={true}
        userId="user-test-1"
        currentBalanceUSD={25.0}
        onClose={vi.fn()}
      />
    )

    expect(screen.getByText('Live Video Call Setup')).toBeInTheDocument()
    expect(screen.getByText('Upload Reference Portrait Image')).toBeInTheDocument()
    expect(screen.getByText('Transformation Prompt Instructions')).toBeInTheDocument()
    expect(screen.getByText('$25.00 USD')).toBeInTheDocument()
  })

  it('handles image selection, decoding, preview display, and removal', async () => {
    const user = userEvent.setup()
    const { container } = render(
      <LiveSetupModal
        isOpen={true}
        userId="user-test-1"
        currentBalanceUSD={25.0}
        onClose={vi.fn()}
      />
    )

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    expect(fileInput).not.toBeNull()

    const validFile = new File(['valid png data'], 'avatar.png', { type: 'image/png' })
    await user.upload(fileInput, validFile)

    await waitFor(() => {
      expect(screen.getByText(/avatar\.png/i)).toBeInTheDocument()
      expect(screen.getByText(/Valid PNG/i)).toBeInTheDocument()
    })

    const removeBtn = screen.getByRole('button', { name: /remove/i })
    await user.click(removeBtn)

    await waitFor(() => {
      expect(screen.queryByText(/avatar\.png/i)).not.toBeInTheDocument()
      expect(screen.getByText('Upload Reference Portrait Image')).toBeInTheDocument()
    })
  })

  it('displays error if balance is insufficient when user clicks Go Live', async () => {
    const user = userEvent.setup()

    vi.spyOn(walletService, 'getWallet').mockResolvedValue({
      id: 'w1',
      user_id: 'user-poor',
      currency: 'USD',
      balance: 0,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    vi.spyOn(walletService, 'getExchangeRateConfig').mockResolvedValue({
      usd_to_ngn_rate: 1550,
      wallet_currency: 'USD',
      payment_currency: 'NGN',
      minimum_top_up_usd: 15,
      live_usage_rate_per_second_usd: 0.04,
      updated_at: new Date().toISOString(),
    })

    const onTopUpClick = vi.fn()
    const { container } = render(
      <LiveSetupModal
        isOpen={true}
        userId="user-poor"
        currentBalanceUSD={0.0}
        onClose={vi.fn()}
        onTopUpClick={onTopUpClick}
      />
    )

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    const validFile = new File(['valid png data'], 'avatar.png', { type: 'image/png' })
    await user.upload(fileInput, validFile)

    await waitFor(() => {
      expect(screen.getByText(/avatar\.png/i)).toBeInTheDocument()
    })

    const goLiveBtn = screen.getByRole('button', { name: /go live/i })
    await user.click(goLiveBtn)

    await waitFor(() => {
      expect(screen.getByText(/Insufficient wallet balance/i)).toBeInTheDocument()
    })

    const topUpButton = screen.getByRole('button', { name: /top up wallet balance/i })
    expect(topUpButton).toBeInTheDocument()
    await user.click(topUpButton)
    expect(onTopUpClick).toHaveBeenCalledTimes(1)
  })

  it('successfully prepares session when user is authenticated with sufficient balance', async () => {
    const user = userEvent.setup()

    vi.spyOn(walletService, 'getWallet').mockResolvedValue({
      id: 'w1',
      user_id: 'user-rich',
      currency: 'USD',
      balance: 5000,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    vi.spyOn(walletService, 'getExchangeRateConfig').mockResolvedValue({
      usd_to_ngn_rate: 1550,
      wallet_currency: 'USD',
      payment_currency: 'NGN',
      minimum_top_up_usd: 15,
      live_usage_rate_per_second_usd: 0.04,
      updated_at: new Date().toISOString(),
    })

    const { container } = render(
      <LiveSetupModal
        isOpen={true}
        userId="user-rich"
        currentBalanceUSD={50.0}
        onClose={vi.fn()}
      />
    )

    const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement
    const validFile = new File(['valid webp data'], 'portrait.webp', { type: 'image/webp' })
    await user.upload(fileInput, validFile)

    await waitFor(() => {
      expect(screen.getByText(/portrait\.webp/i)).toBeInTheDocument()
    })

    const goLiveBtn = screen.getByRole('button', { name: /go live/i })
    await user.click(goLiveBtn)

    // Streamlined flow: Go Live directly connects to Decart Lucy 2.5
    await waitFor(() => {
      expect(screen.getByText('Decart Lucy 2.5 Live Stream')).toBeInTheDocument()
      expect(screen.getByText('Decart Lucy 2.5 (720p)')).toBeInTheDocument()
    })
  })

  it('allows customizing and resetting transformation prompt', async () => {
    const user = userEvent.setup()
    render(
      <LiveSetupModal
        isOpen={true}
        userId="user-rich"
        currentBalanceUSD={50.0}
        onClose={vi.fn()}
      />
    )

    const configButton = screen.getByText('Configure')
    await user.click(configButton)

    const textarea = screen.getByPlaceholderText(/enter transformation prompt/i)
    expect(textarea).toBeInTheDocument()

    fireEvent.change(textarea, { target: { value: 'Custom cinematic lighting avatar transformation.' } })
    expect(textarea).toHaveValue('Custom cinematic lighting avatar transformation.')

    const resetButton = screen.getByRole('button', { name: /reset default/i })
    await user.click(resetButton)

    expect(textarea).toHaveValue(
      "Use the uploaded image as the primary visual reference for transforming the incoming live video stream. Reproduce the subject's appearance, facial characteristics, clothing, environment, background, lighting and overall composition as closely as possible. Maintain natural movement and visual consistency throughout the real-time transformation."
    )
  })
})
