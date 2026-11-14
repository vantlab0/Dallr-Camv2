/**
 * Decart Service
 *
 * Provides the Decart API key to the Decart SDK.
 *
 * Resolution order:
 *  1. `DECART_API_KEY` compiled into the bundle at build time (Vite `DECART_` envPrefix).
 *  2. A key saved locally from the Live Setup screen, persisted in WebView localStorage.
 *
 * The runtime fallback exists because the desktop installer must stay usable without a
 * rebuild when the build environment has no key configured: the user pastes their own
 * `dct_...` key once, and it never leaves the device.
 *
 * SECURITY NOTE: a desktop build that embeds the key ships it inside the app bundle.
 * That is appropriate for a single-owner personal application. For a multi-user
 * production app the key must remain server-side and only short-lived client tokens
 * should be issued.
 */

export interface DecartTokenResponse {
  apiKey: string
  expiresAt: string
  permissions?: {
    models?: string[]
  } | null
  constraints?: {
    realtime?: {
      maxSessionDuration?: number
    }
  } | null
}

/** WebView-localStorage slot for a key pasted by the user. */
export const DECART_API_KEY_STORAGE_KEY = 'dallr.decartApiKey'

/** Decart client tokens / API keys all start with `dct_`. */
const DECART_API_KEY_PATTERN = /^dct_[A-Za-z0-9_-]{8,}$/

function readBuildTimeApiKey(): string {
  const value = import.meta.env.DECART_API_KEY
  return typeof value === 'string' ? value.trim() : ''
}

function readStoredApiKey(): string {
  try {
    return (globalThis.localStorage?.getItem(DECART_API_KEY_STORAGE_KEY) || '').trim()
  } catch {
    return ''
  }
}

export const decartService = {
  /** The key that will actually be used, or an empty string when none is configured. */
  getConfiguredApiKey(): string {
    return readBuildTimeApiKey() || readStoredApiKey()
  },

  hasConfiguredApiKey(): boolean {
    return this.getConfiguredApiKey().length > 0
  },

  /** True when a user-saved key is stored on this device (localStorage). */
  hasRuntimeApiKey(): boolean {
    return readStoredApiKey().length > 0
  },

  /** True when the key comes from the build environment rather than user storage. */
  hasBuildTimeApiKey(): boolean {
    return readBuildTimeApiKey().length > 0
  },

  /**
   * Persists a user-supplied key for this device. Only `dct_...` values are accepted,
   * which catches pasted partial keys before they reach the SDK.
   */
  setRuntimeApiKey(apiKey: string): void {
    const trimmed = apiKey.trim()
    if (!trimmed) {
      throw new Error('Decart API key cannot be empty.')
    }
    if (!DECART_API_KEY_PATTERN.test(trimmed)) {
      throw new Error(
        'That does not look like a Decart API key. Keys start with "dct_" — copy the full key from platform.decart.ai.',
      )
    }
    try {
      globalThis.localStorage?.setItem(DECART_API_KEY_STORAGE_KEY, trimmed)
    } catch {
      throw new Error('The API key could not be saved on this device.')
    }
  },

  clearRuntimeApiKey(): void {
    try {
      globalThis.localStorage?.removeItem(DECART_API_KEY_STORAGE_KEY)
    } catch {
      // ignore
    }
  },

  /**
   * Returns the Decart API key for the SDK's `apiKeyProvider`.
   * No Edge Function is called. The key is used directly by the Decart SDK
   * to establish the WebRTC session to Decart Lucy 2.5.
   */
  async requestClientToken(): Promise<DecartTokenResponse> {
    const apiKey = this.getConfiguredApiKey()

    if (!apiKey) {
      throw new Error(
        'Decart API key is not configured. Paste your dct_... key in the Live Setup screen, ' +
          'or set DECART_API_KEY in your .env file and rebuild the app.',
      )
    }

    return {
      apiKey,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(), // 24 hours
      permissions: { models: ['lucy-2.5'] },
      constraints: null,
    }
  },
}
