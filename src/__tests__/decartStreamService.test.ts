import { describe, it, expect, vi, beforeEach } from 'vitest'
import { decartStreamService } from '@/services/decartStreamService'
import { decartService } from '@/services/decartService'
import { sessionBillingService } from '@/services/sessionBillingService'
import { supabase } from '@/lib/supabase'
import { walletService } from '@/services/walletService'
import type { PreparedImageReference } from '@/types/live'

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: vi.fn(),
    },
    functions: {
      invoke: vi.fn(),
    },
  },
  isSupabaseConfigured: true,
}))

const mockSampleImage: PreparedImageReference = {
  file: new File(['fake'], 'sample.png', { type: 'image/png' }),
  name: 'sample.png',
  size: 1024,
  mimeType: 'image/png',
  dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  base64Data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  width: 512,
  height: 512,
  aspectRatio: 1,
}

describe('decartService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('requests client token using backend Edge Function endpoint', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        session: {
          access_token: 'fake-jwt',
          user: { id: 'user-123' },
        } as any,
      },
      error: null,
    })

    vi.spyOn(walletService, 'getWallet').mockResolvedValue({
      id: 'w1',
      user_id: 'user-123',
      balance: 1000,
      currency: 'USD',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })

    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: {
        apiKey: 'tok_client_decart_test_123',
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        permissions: { models: ['lucy-2.5'] },
      },
      error: null,
    })

    const token = await decartService.requestClientToken()
    expect(supabase.functions.invoke).toHaveBeenCalledWith('create-decart-token', {
      headers: {
        Authorization: 'Bearer fake-jwt',
      },
    })
    expect(token).toBeDefined()
    expect(token.apiKey).toBe('tok_client_decart_test_123')
    expect(typeof token.apiKey).toBe('string')
    expect(token.permissions?.models).toContain('lucy-2.5')
  })
})

describe('decartStreamService', () => {
  beforeEach(async () => {
    vi.restoreAllMocks()
    await decartStreamService.endLiveStream()
  })

  it('initializes in idle state', () => {
    expect(decartStreamService.getState()).toBe('idle')
    expect(decartStreamService.getLocalStream()).toBeNull()
    expect(decartStreamService.getRemoteStream()).toBeNull()
  })

  it('terminates stream when billing service emits an error', async () => {
    const endSpy = vi.spyOn(decartStreamService, 'endLiveStream')
    const errorSpy = vi.fn()
    decartStreamService.setListeners({ onError: errorSpy })

    // Trigger billing onError listener
    sessionBillingService['listeners'].onError?.('Heartbeat failure')

    expect(errorSpy).toHaveBeenCalledWith({
      code: 'BILLING_ERROR',
      message: 'Heartbeat failure',
    })
    expect(endSpy).toHaveBeenCalled()
  })

  it('handles permission denied when camera access is rejected', async () => {
    const originalMediaDevices = navigator.mediaDevices
    const mockGetUserMedia = vi.fn().mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'))

    Object.defineProperty(navigator, 'mediaDevices', {
      value: { ...originalMediaDevices, getUserMedia: mockGetUserMedia },
      writable: true,
      configurable: true,
    })

    await expect(
      decartStreamService.startLiveStream({
        referenceImage: mockSampleImage,
        prompt: 'Substitute the character in the video with an anime hero.',
      })
    ).rejects.toThrow('Camera or microphone permission denied. Please allow device access.')

    expect(decartStreamService.getState()).toBe('failed')

    Object.defineProperty(navigator, 'mediaDevices', {
      value: originalMediaDevices,
      writable: true,
      configurable: true,
    })
  })

  it('connects to Lucy 2.5 stream, handles state transitions, and updates prompt', async () => {
    const mockTrack = {
      stop: vi.fn(),
      kind: 'video',
      enabled: true,
    } as unknown as MediaStreamTrack

    const fakeLocalStream = {
      getTracks: vi.fn().mockReturnValue([mockTrack]),
    } as unknown as MediaStream

    const fakeRemoteStream = {
      getTracks: vi.fn().mockReturnValue([mockTrack]),
    } as unknown as MediaStream

    const originalMediaDevices = navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        ...originalMediaDevices,
        getUserMedia: vi.fn().mockResolvedValue(fakeLocalStream),
      },
      writable: true,
      configurable: true,
    })

    const registeredCallbacks: Record<string, (arg?: unknown) => void> = {}

    const mockRealtimeClient = {
      isConnected: vi.fn().mockReturnValue(true),
      getConnectionState: vi.fn().mockReturnValue('connected'),
      sessionId: 'ses_test_12345',
      subscribeToken: 'sub_token_67890',
      on: vi.fn((event: string, cb: (arg?: unknown) => void) => {
        registeredCallbacks[event] = cb
      }),
      set: vi.fn().mockResolvedValue(undefined),
      setPrompt: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    }

    const privateService = decartStreamService as unknown as {
      client: {
        realtime: {
          connect: typeof vi.fn
        }
      }
    }

    privateService.client = {
      realtime: {
        connect: vi.fn().mockImplementation((_stream, opts) => {
          opts.onRemoteStream(fakeRemoteStream)
          return Promise.resolve(mockRealtimeClient)
        }),
      },
    }

    const stateChanges: string[] = []
    let receivedRemote: MediaStream | null = null
    let receivedTick: { seconds: number; usageUSD: number } | null = null

    decartStreamService.setListeners({
      onStateChange: (st) => stateChanges.push(st),
      onRemoteStream: (s) => {
        receivedRemote = s
      },
      onGenerationTick: (t) => {
        receivedTick = t
      },
    })

    const session = await decartStreamService.startLiveStream({
      referenceImage: mockSampleImage,
      prompt: 'Substitute the character with an anime hero.',
      ratePerSecondUSD: 0.04,
    })

    expect(session.sessionId).toBe('ses_test_12345')
    expect(session.modelName).toBe('lucy-2.5')
    expect(decartStreamService.getSubscribeToken()).toBe('sub_token_67890')
    expect(receivedRemote).toBe(fakeRemoteStream)
    expect(decartStreamService.getState()).toBe('connected')

    // Simulate generation tick event
    registeredCallbacks['generationTick']?.({ seconds: 15 })
    expect(receivedTick).toEqual({ seconds: 15, usageUSD: 0.6 })

    // Dynamic prompt update
    await decartStreamService.updatePrompt('Transform into a superhero with glowing eyes.')
    expect(mockRealtimeClient.set).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Transform into a superhero with glowing eyes.',
        enhance: true,
      })
    )

    // Disconnect & cleanup
    await decartStreamService.endLiveStream()
    expect(mockRealtimeClient.disconnect).toHaveBeenCalled()
    expect(mockTrack.stop).toHaveBeenCalled()
    expect(decartStreamService.getLocalStream()).toBeNull()
    expect(decartStreamService.getRemoteStream()).toBeNull()

    Object.defineProperty(navigator, 'mediaDevices', {
      value: originalMediaDevices,
      writable: true,
      configurable: true,
    })
  })
})
