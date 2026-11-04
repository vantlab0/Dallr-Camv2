import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { VideoOutputPage } from '@/pages/VideoOutputPage'
import { streamRelayService } from '@/services/streamRelayService'

describe('VideoOutputPage', () => {
  beforeEach(() => {
    vi.spyOn(streamRelayService, 'startReceiving').mockImplementation(() => {})
    vi.spyOn(streamRelayService, 'requestEndSession').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders a completely borderless container with black background and no dashboard controls', () => {
    render(<VideoOutputPage />)

    const container = screen.getByTestId('video-output-container')
    expect(container).toBeInTheDocument()
    expect(container).toHaveClass('bg-black')
    expect(container).toHaveClass('fixed')
    expect(container).toHaveClass('inset-0')

    // Verify no buttons, navigation, or dashboard elements
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })

  it('renders the video element with correct aspect ratio and responsive object-contain styles', () => {
    render(<VideoOutputPage />)

    const video = screen.getByTestId('video-output-player') as HTMLVideoElement
    expect(video).toBeInTheDocument()
    expect(video).toHaveClass('object-contain')
    expect(video.autoplay).toBe(true)
    expect(video.muted).toBe(true)
  })

  it('registers receiving relay on mount and cleans up on unmount', () => {
    const { unmount } = render(<VideoOutputPage />)
    expect(streamRelayService.startReceiving).toHaveBeenCalledTimes(1)

    unmount()
    expect(streamRelayService.requestEndSession).toHaveBeenCalledTimes(1)
  })
})
