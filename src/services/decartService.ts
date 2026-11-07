import { supabase } from '@/lib/supabase'
import { walletService } from '@/services/walletService'

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
   * Requests a short-lived Decart client token from the backend Edge Function.
   * Ensures the secret Decart API key is kept securely on the backend
   * and never exposed to the desktop client.
   */
  async requestClientToken(): Promise<DecartTokenResponse> {
    const {
      data: { session },
    } = await supabase.auth.getSession()

    const token = session?.access_token

    if (!token) {
      throw new Error('Authentication required to request live session credentials.')
    }

    // Verify wallet eligibility on client before network call if possible
    if (session.user?.id) {
      const wallet = await walletService.getWallet(session.user.id)
      const balanceCents = wallet?.balance ?? 0
      if (balanceCents < 4) {
        throw new Error(
          `Insufficient wallet balance. At least $0.04 USD is required to start live streaming. Current balance: $${(balanceCents / 100).toFixed(2)} USD.`
        )
      }
    }

    const { data, error } = await supabase.functions.invoke('create-decart-token', {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    })

    if (error) {
      const errorMsg = (data as { error?: string; message?: string })?.error
        || (data as { message?: string })?.message
        || error.message
        || 'Unknown error'
      const statusCode = (data as { status?: number })?.status
        || (error as { status?: number })?.status
        || 'unknown'
      const statusText = (data as { statusText?: string })?.statusText
        || (error as { statusText?: string })?.statusText
        || ''
      throw new Error(`Edge Function error (${statusCode} ${statusText}): ${errorMsg}`)
    }

    if (!data || !data.apiKey) {
      // In case Edge Function returned token under 'token'
      const key = data?.apiKey || data?.token
      if (!key) {
        throw new Error('Invalid response received from Decart token service.')
      }
      return {
        apiKey: key,
        expiresAt: data.expires_at || data.expiresAt || new Date(Date.now() + 300000).toISOString(),
        permissions: data.permissions || null,
        constraints: data.constraints || null,
      }
    }

    return data as DecartTokenResponse
  },
}
