import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { LiveStreamView } from '@/components/live/LiveStreamView'
import type { LiveStreamSessionInfo } from '@/types/live'

const mockSession: LiveStreamSessionInfo = {
  sessionId: 'ses_abc123',
  subscribeToken: 'sub_tok_456',
  modelName: 'lucy-2.5',
  prompt: 'Substitute character with cyborg',
  referenceImage: {
    file: new File([''], 'img.png', { type: 'image/png' }),
    name: 'img.png',
    size: 500,
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,fake',
    base64Data: 'fake',
    width: 512,
    height: 512,
    aspectRatio: 1,
  },
  startedAt: new Date().toISOString(),
}

describe('LiveStreamView Component', () => {
  it('renders connecting state overlay when stream is establishing', () => {
    render(
      <LiveStreamView
        status="connecting"
        error={null}
        sessionInfo={mockSession}
        remoteStream={null}
        localStream={null}
        elapsedSeconds={0}
        usageUSD={0}
        metrics={null}
        onUpdatePrompt={vi.fn()}
        onEndStream={vi.fn()}
      />
    )

    expect(screen.getByText(/Establishing WebRTC/i)).toBeInTheDocument()
    expect(screen.getByText(/Initializing Decart Lucy 2.5 WebRTC Stream/i)).toBeInTheDocument()
    expect(screen.getByText(/Decart Lucy 2.5 \(720p\)/i)).toBeInTheDocument()
  })

  it('renders connected state with duration, billing cost, and video elements', () => {
    const fakeRemoteStream = {} as MediaStream
    const fakeLocalStream = {} as MediaStream

    render(
      <LiveStreamView
        status="connected"
        error={null}
        sessionInfo={mockSession}
        remoteStream={fakeRemoteStream}
        localStream={fakeLocalStream}
        elapsedSeconds={75}
        usageUSD={3.0}
        metrics={{ fps: 30 }}
        onUpdatePrompt={vi.fn()}
        onEndStream={vi.fn()}
      />
    )

    expect(screen.getByText('Connected')).toBeInTheDocument()
    expect(screen.getByText('01:15')).toBeInTheDocument()
    expect(screen.getByText('$3.00 USD')).toBeInTheDocument()
    expect(screen.getByText('30 FPS')).toBeInTheDocument()
    expect(screen.getByText('LIVE')).toBeInTheDocument()
  })

  it('allows user to submit updated prompt', async () => {
    const fakeRemoteStream = {} as MediaStream
    const onUpdatePrompt = vi.fn().mockResolvedValue(undefined)

    render(
      <LiveStreamView
        status="connected"
        error={null}
        sessionInfo={mockSession}
        remoteStream={fakeRemoteStream}
        localStream={null}
        elapsedSeconds={10}
        usageUSD={0.4}
        metrics={null}
        onUpdatePrompt={onUpdatePrompt}
        onEndStream={vi.fn()}
      />
    )

    const input = screen.getByPlaceholderText(/Update Lucy 2.5 transformation style/i)
    fireEvent.change(input, { target: { value: 'New watercolor transformation' } })

    const updateBtn = screen.getByRole('button', { name: /Update/i })
    fireEvent.click(updateBtn)

    await waitFor(() => {
      expect(onUpdatePrompt).toHaveBeenCalledWith('New watercolor transformation')
    })
  })

  it('renders error banner when error occurs and allows dismiss', () => {
    const onDismissError = vi.fn()
    render(
      <LiveStreamView
        status="connected"
        error="WebRTC connection lost unexpectedly"
        sessionInfo={mockSession}
        remoteStream={null}
        localStream={null}
        elapsedSeconds={10}
        usageUSD={0.4}
        metrics={null}
        onUpdatePrompt={vi.fn()}
        onEndStream={vi.fn()}
        onDismissError={onDismissError}
      />
    )

    expect(screen.getByText('Live Stream Error')).toBeInTheDocument()
    expect(screen.getByText('WebRTC connection lost unexpectedly')).toBeInTheDocument()

    const dismissBtn = screen.getByText('Dismiss')
    fireEvent.click(dismissBtn)
    expect(onDismissError).toHaveBeenCalled()
  })
})
