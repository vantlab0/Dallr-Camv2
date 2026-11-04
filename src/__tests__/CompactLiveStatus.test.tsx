import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CompactLiveStatus } from '@/components/live/CompactLiveStatus'

describe('CompactLiveStatus', () => {
  it('displays active live indicator, session duration, and wallet balance', () => {
    render(
      <CompactLiveStatus
        isConnected={true}
        elapsedSeconds={125}
        balanceUSD={24.5}
        onEndSession={vi.fn()}
      />
    )

    expect(screen.getByText(/LIVE SESSION ACTIVE/i)).toBeInTheDocument()
    expect(screen.getByText(/Decart Lucy 2.5/i)).toBeInTheDocument()
    expect(screen.getByTestId('live-duration')).toHaveTextContent('02:05')
    expect(screen.getByTestId('live-balance')).toHaveTextContent('$24.50 USD')
  })

  it('triggers onEndSession when End Session button is clicked', () => {
    const onEndSpy = vi.fn()
    render(
      <CompactLiveStatus
        isConnected={true}
        elapsedSeconds={30}
        balanceUSD={15.0}
        onEndSession={onEndSpy}
      />
    )

    const endButton = screen.getByRole('button', { name: /End Session/i })
    fireEvent.click(endButton)

    expect(onEndSpy).toHaveBeenCalledTimes(1)
  })

  it('allows reopening or focusing the video output window', () => {
    const onFocusSpy = vi.fn()
    const onReopenSpy = vi.fn()

    const { rerender } = render(
      <CompactLiveStatus
        isConnected={true}
        elapsedSeconds={10}
        balanceUSD={15.0}
        isOutputWindowOpen={true}
        onFocusOutputWindow={onFocusSpy}
        onReopenOutputWindow={onReopenSpy}
        onEndSession={vi.fn()}
      />
    )

    const focusBtn = screen.getByRole('button', { name: /Focus Video Window/i })
    fireEvent.click(focusBtn)
    expect(onFocusSpy).toHaveBeenCalledTimes(1)

    rerender(
      <CompactLiveStatus
        isConnected={true}
        elapsedSeconds={10}
        balanceUSD={15.0}
        isOutputWindowOpen={false}
        onFocusOutputWindow={onFocusSpy}
        onReopenOutputWindow={onReopenSpy}
        onEndSession={vi.fn()}
      />
    )

    const reopenBtn = screen.getByRole('button', { name: /Reopen Video Window/i })
    fireEvent.click(reopenBtn)
    expect(onReopenSpy).toHaveBeenCalledTimes(1)
  })
})
