export type SupportedImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp'

export interface PreparedImageReference {
  file: File
  name: string
  size: number
  mimeType: SupportedImageMimeType
  dataUrl: string
  base64Data: string
  width: number
  height: number
  aspectRatio: number
}

export type LiveSessionStatus =
  | 'idle'
  | 'validating'
  | 'preparing'
  | 'ready_for_engine'
  | 'connecting'
  | 'failed'
  | 'cancelled'

export interface LiveSessionValidationResult {
  isValid: boolean
  errorCode?:
    | 'NO_IMAGE'
    | 'UNAUTHENTICATED'
    | 'INSUFFICIENT_BALANCE'
    | 'WALLET_NOT_FOUND'
    | 'FETCH_ERROR'
  errorMessage?: string
  currentBalanceUSD?: number
  currentBalanceCents?: number
  requiredBalanceUSD?: number
}

export interface PreparedLiveSession {
  sessionId: string
  userId: string
  referenceImage: PreparedImageReference
  prompt: string
  ratePerSecondUSD: number
  initialBalanceUSD: number
  initialBalanceCents: number
  preparedAt: string
}

export interface LiveSessionState {
  status: LiveSessionStatus
  isLoading: boolean
  error: string | null
  preparedSession: PreparedLiveSession | null
}
