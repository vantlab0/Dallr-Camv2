import { useState, useCallback, useRef } from 'react'
import { liveSessionService } from '@/services/liveSessionService'
import type {
  PreparedImageReference,
  PreparedLiveSession,
  LiveSessionStatus,
} from '@/types/live'

export interface UseLiveSessionOptions {
  userId?: string | null
}

export function useLiveSession({ userId }: UseLiveSessionOptions = {}) {
  const [status, setStatus] = useState<LiveSessionStatus>('idle')
  const [isLoading, setIsLoading] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)
  const [preparedSession, setPreparedSession] = useState<PreparedLiveSession | null>(null)

  const abortControllerRef = useRef<AbortController | null>(null)

  const cancelSession = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setIsLoading(false)
    setStatus('cancelled')
    setError('Session preparation was cancelled.')
  }, [])

  const resetSession = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }
    setIsLoading(false)
    setStatus('idle')
    setError(null)
    setPreparedSession(null)
  }, [])

  const prepareLiveSession = useCallback(
    async (
      referenceImage: PreparedImageReference,
      customPrompt?: string
    ): Promise<PreparedLiveSession | null> => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }
      abortControllerRef.current = new AbortController()
      const signal = abortControllerRef.current.signal

      setIsLoading(true)
      setError(null)
      setStatus('validating')

      try {
        if (!userId) {
          throw new Error('You must be signed in to configure and start a live video call.')
        }

        setStatus('preparing')

        const session = await liveSessionService.prepareSession({
          userId,
          referenceImage,
          prompt: customPrompt,
          signal,
        })

        if (signal.aborted) {
          return null
        }

        setPreparedSession(session)
        setStatus('ready_for_engine')
        setIsLoading(false)
        return session
      } catch (err: unknown) {
        if (signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
          setStatus('cancelled')
          setError('Session initialization was cancelled.')
        } else {
          const msg = err instanceof Error ? err.message : 'Failed to prepare live session.'
          setStatus('failed')
          setError(msg)
        }
        setIsLoading(false)
        return null
      }
    },
    [userId]
  )

  return {
    status,
    isLoading,
    error,
    preparedSession,
    prepareLiveSession,
    cancelSession,
    resetSession,
    clearError: () => setError(null),
  }
}
