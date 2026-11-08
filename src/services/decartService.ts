/**
 * Decart Service
 *
 * Provides the Decart API key directly from the desktop application's own
 * configuration. The key is embedded locally (DECART_API_KEY) and used
 * to authenticate the Decart SDK WebRTC connection. No backend Edge Function
 * is involved in token issuance.
 *
 * SECURITY NOTE: The Decart API key is now shipped inside the desktop app.
 * This is appropriate for a single-owner personal application. For a
 * multi-user production app, the key must remain server-side and only
 * short-lived client tokens should be issued.
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

export const decartService = {
  /**
   * Returns the Decart API key from local application configuration.
   * No Edge Function is called. The key is used directly by the Decart SDK
   * to establish the WebRTC session to Decart Lucy 2.5.
   */
  async requestClientToken(): Promise<DecartTokenResponse> {
    const apiKey = import.meta.env.DECART_API_KEY || ''

    if (!apiKey) {
      throw new Error(
        'DECART_API_KEY is not configured. Set DECART_API_KEY in your .env file ' +
          'and restart the application.',
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
