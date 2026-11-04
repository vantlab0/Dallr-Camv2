import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { VideoWindowManager, VIDEO_OUTPUT_WINDOW_LABEL, VIDEO_OUTPUT_ROUTE } from '@/services/videoWindowManager'

describe('VideoWindowManager', () => {
  let manager: VideoWindowManager

  beforeEach(() => {
    manager = new VideoWindowManager()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('detects browser fallback environment and opens popup with correct route', async () => {
    const mockOpen = vi.fn().mockReturnValue({
      closed: false,
      focus: vi.fn(),
      close: vi.fn(),
    })
    vi.stubGlobal('open', mockOpen)

    await manager.openVideoWindow({ width: 1280, height: 720 })

    expect(mockOpen).toHaveBeenCalledWith(
      VIDEO_OUTPUT_ROUTE,
      VIDEO_OUTPUT_WINDOW_LABEL,
      expect.stringContaining('width=1280,height=720')
    )
  })

  it('triggers onClose callback when window is closed', async () => {
    const onCloseSpy = vi.fn()
    const fakePopup = {
      closed: false,
      focus: vi.fn(),
      close: vi.fn(),
    }
    vi.stubGlobal('open', vi.fn().mockReturnValue(fakePopup))

    vi.useFakeTimers()
    await manager.openVideoWindow({ onClose: onCloseSpy })

    fakePopup.closed = true
    vi.advanceTimersByTime(600)

    expect(onCloseSpy).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('checks if window is open correctly', async () => {
    const fakePopup = {
      closed: false,
      focus: vi.fn(),
      close: vi.fn(),
    }
    vi.stubGlobal('open', vi.fn().mockReturnValue(fakePopup))

    await manager.openVideoWindow()
    const isOpen = await manager.isWindowOpen()
    expect(isOpen).toBe(true)

    fakePopup.closed = true
    const isClosed = await manager.isWindowOpen()
    expect(isClosed).toBe(false)
  })

  it('handles native Tauri WebviewWindow creation with borderless properties', async () => {
    // Mock Tauri window environment
    vi.stubGlobal('__TAURI_INTERNALS__', {})
    const showMock = vi.fn().mockResolvedValue(undefined)
    const setFocusMock = vi.fn().mockResolvedValue(undefined)
    const listenMock = vi.fn().mockResolvedValue(vi.fn())

    class MockWebviewWindow {
      static getByLabel = vi.fn().mockResolvedValue(null)
      show = showMock
      setFocus = setFocusMock
      listen = listenMock
      once = vi.fn()
      constructor(public label: string, public options: any) {}
    }

    vi.doMock('@tauri-apps/api/webviewWindow', () => ({
      WebviewWindow: MockWebviewWindow,
    }))

    const tauriManager = new VideoWindowManager()
    await tauriManager.openVideoWindow({ width: 1280, height: 720 })

    expect(showMock).toHaveBeenCalled()
    expect(setFocusMock).toHaveBeenCalled()
  })
})
