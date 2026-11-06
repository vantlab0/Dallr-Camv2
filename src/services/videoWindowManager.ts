/**
 * Video Window Manager
 * Manages the native borderless Tauri 2 window for the Decart live video output.
 *
 * Requirements:
 * - Label: 'video-output'
 * - Title: 'Dallr Cam — Video Output' (shows cleanly in Zoom/Discord/Meet screen share pickers)
 * - Borderless: decorations = false
 * - No title bar, no buttons, no padding
 * - Resizable: resizable = true
 * - Black background during initialization
 * - Clean close behavior: closing the output window invokes onWindowClose callback to end active session
 */

export const VIDEO_OUTPUT_WINDOW_LABEL = 'video-output'
export const VIDEO_OUTPUT_ROUTE = '/?view=video-output'

export interface VideoWindowOptions {
  width?: number
  height?: number
  onClose?: () => void
  // Reference image data URL to display in the borderless window before the Decart stream connects
  referenceImageDataUrl?: string
}

export class VideoWindowManager {
  private isTauriEnv: boolean | null = null
  private popupWindowRef: Window | null = null
  private closeCallback?: () => void
  private unlistenDestroy?: () => void

  constructor() {
    this.detectEnvironment()
  }

  private detectEnvironment(): boolean {
    if (this.isTauriEnv !== null) return this.isTauriEnv
    this.isTauriEnv =
      typeof window !== 'undefined' &&
      (('__TAURI_INTERNALS__' in window) ||
        ('__TAURI__' in window) ||
        Boolean((window as unknown as { isTauri?: boolean }).isTauri))
    return this.isTauriEnv
  }

  /**
   * Set callback for when output window closes
   */
  public setOnCloseCallback(cb: () => void) {
    this.closeCallback = cb
  }

  /**
   * Checks whether the video output window is currently open
   */
  public async isWindowOpen(): Promise<boolean> {
    if (this.detectEnvironment()) {
      try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
        const win = await WebviewWindow.getByLabel(VIDEO_OUTPUT_WINDOW_LABEL)
        return win !== null
      } catch (err) {
        console.warn('Error checking Tauri window existence:', err)
        return false
      }
    } else {
      return Boolean(this.popupWindowRef && !this.popupWindowRef.closed)
    }
  }

  /**
   * Opens the dedicated borderless video output window.
   * If already open, brings it to focus.
   */
  public async openVideoWindow(options: VideoWindowOptions = {}): Promise<void> {
    const { width = 1280, height = 720, onClose, referenceImageDataUrl } = options
    if (onClose) {
      this.closeCallback = onClose
    }

    // Build the video output URL with optional reference image param
    const urlParams = new URLSearchParams({ view: 'video-output' })
    if (referenceImageDataUrl) {
      urlParams.set('image', referenceImageDataUrl)
    }
    const videoOutputUrl = `/?${urlParams.toString()}`

    if (this.detectEnvironment()) {
      try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')

        // Check if existing window is already created
        const existingWin = await WebviewWindow.getByLabel(VIDEO_OUTPUT_WINDOW_LABEL)
        if (existingWin) {
          await existingWin.show()
          await existingWin.setFocus()
          return
        }

        // Create new borderless native desktop window
        const videoWin = new WebviewWindow(VIDEO_OUTPUT_WINDOW_LABEL, {
          url: videoOutputUrl,
          title: 'Dallr Cam — Video Output',
          width,
          height,
          minWidth: 480,
          minHeight: 270,
          decorations: false,
          resizable: true,
          fullscreen: false,
          transparent: false,
          backgroundColor: '#000000',
          center: true,
          focus: true,
        })

        videoWin.once('tauri://error', (e) => {
          console.error('Failed to create Tauri video output window:', e)
        })

        // Listen for window destruction / closure
        const unlisten = await videoWin.listen('tauri://destroyed', () => {
          this.handleWindowClosed()
        })
        this.unlistenDestroy = unlisten

        await videoWin.show()
        await videoWin.setFocus()
      } catch (err) {
        console.error('Error opening Tauri video output window:', err)
        // Fallback to web popup if Tauri API fails
        this.openWebFallback(videoOutputUrl, width, height)
      }
    } else {
      this.openWebFallback(videoOutputUrl, width, height)
    }
  }

  private openWebFallback(url: string, width: number, height: number) {
    if (this.popupWindowRef && !this.popupWindowRef.closed) {
      this.popupWindowRef.focus()
      return
    }

    const left = Math.max(0, Math.round((window.screen.width - width) / 2))
    const top = Math.max(0, Math.round((window.screen.height - height) / 2))

    const popup = window.open(
      url,
      VIDEO_OUTPUT_WINDOW_LABEL,
      `width=${width},height=${height},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no,resizable=yes`
    )

    if (popup) {
      this.popupWindowRef = popup
      const checkInterval = setInterval(() => {
        if (popup.closed) {
          clearInterval(checkInterval)
          this.popupWindowRef = null
          this.handleWindowClosed()
        }
      }, 500)
    }
  }

  /**
   * Closes the video output window if open
   */
  public async closeVideoWindow(): Promise<void> {
    if (this.detectEnvironment()) {
      try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
        const existingWin = await WebviewWindow.getByLabel(VIDEO_OUTPUT_WINDOW_LABEL)
        if (existingWin) {
          await existingWin.destroy()
        }
      } catch (err) {
        console.warn('Error closing Tauri video output window:', err)
      }
    }

    if (this.popupWindowRef && !this.popupWindowRef.closed) {
      this.popupWindowRef.close()
      this.popupWindowRef = null
    }

    if (this.unlistenDestroy) {
      this.unlistenDestroy()
      this.unlistenDestroy = undefined
    }
  }

  /**
   * Brings output window to front
   */
  public async focusVideoWindow(): Promise<void> {
    if (this.detectEnvironment()) {
      try {
        const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow')
        const win = await WebviewWindow.getByLabel(VIDEO_OUTPUT_WINDOW_LABEL)
        if (win) {
          await win.show()
          await win.setFocus()
        }
      } catch (err) {
        console.warn('Error focusing video window:', err)
      }
    } else if (this.popupWindowRef && !this.popupWindowRef.closed) {
      this.popupWindowRef.focus()
    }
  }

  private handleWindowClosed() {
    this.popupWindowRef = null
    if (this.unlistenDestroy) {
      this.unlistenDestroy()
      this.unlistenDestroy = undefined
    }
    this.closeCallback?.()
  }
}

export const videoWindowManager = new VideoWindowManager()
