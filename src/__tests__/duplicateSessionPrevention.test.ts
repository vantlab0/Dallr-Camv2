import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sessionBillingService } from '@/services/sessionBillingService'
import { decartStreamService } from '@/services/decartStreamService'
import { supabase } from '@/lib/supabase'
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

describe('Duplicate Live Session Prevention & Idempotency', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    sessionBillingService.removeListeners()
    await decartStreamService.endLiveStream()
    await sessionBillingService.endSession()
  })

  afterEach(async () => {
    await decartStreamService.endLiveStream()
    await sessionBillingService.endSession()
  })

  it('Requirement 1 & 2: Prevents multiple simultaneous startSession() executions and returns the same in-flight promise', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: {
        session: { access_token: 'valid_jwt_token' } as any,
      },
      error: null,
    })

    let resolveInvoke: (val: any) => void = () => {}
    const invokePromise = new Promise((resolve) => {
      resolveInvoke = resolve
    })

    vi.mocked(supabase.functions.invoke).mockImplementationOnce(() => invokePromise as any)

    // Trigger startSession() twice simultaneously
    const promise1 = sessionBillingService.startSession('decart-simul-1')
    const promise2 = sessionBillingService.startSession('decart-simul-2')

    // Both calls must return the exact same promise instance while in-flight
    expect(promise1).toBe(promise2)

    // Complete backend call
    resolveInvoke({
      data: {
        success: true,
        session_id: 'session-simul-123',
        status: 'active',
        started_at: '2025-01-01T00:00:00Z',
        current_balance_cents: 2000,
      },
      error: null,
    })

    const [res1, res2] = await Promise.all([promise1, promise2])

    expect(res1.sessionId).toBe('session-simul-123')
    expect(res2.sessionId).toBe('session-simul-123')
    // Ensure the backend was called only ONCE
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(1)
    expect(sessionBillingService.getState().isActive).toBe(true)
  })

  it('Requirement 3 & 4: Session startup is idempotent and multiple Decart connected events create only one session', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: {
        session: { access_token: 'valid_jwt_token' } as any,
      },
      error: null,
    })

    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-idempotent-456',
        status: 'active',
        started_at: '2025-01-01T00:00:00Z',
        current_balance_cents: 2500,
      },
      error: null,
    })

    // First start
    const firstStart = await sessionBillingService.startSession('decart-idemp-1')
    expect(firstStart.sessionId).toBe('session-idempotent-456')
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(1)

    // Subsequent start calls while session is already active
    const secondStart = await sessionBillingService.startSession('decart-idemp-2')
    const thirdStart = await sessionBillingService.startSession('decart-idemp-3')

    expect(secondStart.sessionId).toBe('session-idempotent-456')
    expect(thirdStart.sessionId).toBe('session-idempotent-456')
    // No additional backend calls made
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(1)
  })

  it('Requirement 6: Failed startup releases its in-flight state correctly and allows retry', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: {
        session: { access_token: 'valid_jwt_token' } as any,
      },
      error: null,
    })

    // First call fails with network/server error
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: null,
      error: new Error('Network timeout'),
    })

    await expect(sessionBillingService.startSession('decart-fail-1')).rejects.toThrow('Network timeout')

    // Confirm state is not active and not starting
    expect(sessionBillingService.getState().isActive).toBe(false)
    expect(sessionBillingService.getState().isStarting).toBe(false)

    // Retry should work cleanly
    vi.mocked(supabase.functions.invoke).mockResolvedValueOnce({
      data: {
        success: true,
        session_id: 'session-retry-789',
        status: 'active',
        started_at: '2025-01-01T00:00:00Z',
        current_balance_cents: 3000,
      },
      error: null,
    })

    const retryResult = await sessionBillingService.startSession('decart-retry-1')
    expect(retryResult.sessionId).toBe('session-retry-789')
    expect(sessionBillingService.getState().isActive).toBe(true)
  })

  it('Requirement 7: Disconnect/endSession during in-flight startup cancels startup and cleans up orphaned session', async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: {
        session: { access_token: 'valid_jwt_token' } as any,
      },
      error: null,
    })

    let resolveInvoke: (val: any) => void = () => {}
    const invokePromise = new Promise((resolve) => {
      resolveInvoke = resolve
    })

    vi.mocked(supabase.functions.invoke).mockImplementationOnce(() => invokePromise as any)

    // Start session in-flight
    const startPromise = sessionBillingService.startSession('decart-in-flight')

    // User disconnects or ends session while request is still pending
    void sessionBillingService.endSession()

    // Now resolve the backend start response
    resolveInvoke({
      data: {
        success: true,
        session_id: 'session-orphaned-999',
        status: 'active',
        started_at: '2025-01-01T00:00:00Z',
        current_balance_cents: 1800,
      },
      error: null,
    })

    await expect(startPromise).rejects.toThrow('Live session startup was cancelled.')

    // Must not be active locally
    expect(sessionBillingService.getState().isActive).toBe(false)
    expect(sessionBillingService.getState().sessionId).toBeNull()

    // Must have invoked session-end to tear down the orphaned session on the backend
    expect(supabase.functions.invoke).toHaveBeenCalledWith('session-end', {
      headers: { Authorization: 'Bearer valid_jwt_token' },
      body: { session_id: 'session-orphaned-999', final_seconds: 0 },
    })
  })

  it('Requirement 8: Decart reconnecting state does not create duplicate sessions', async () => {
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

    vi.mocked(supabase.auth.getSession).mockResolvedValue({
      data: {
        session: { access_token: 'valid_jwt_token' } as any,
      },
      error: null,
    })

    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: {
        success: true,
        session_id: 'session-reconnect-123',
        status: 'active',
        current_balance_cents: 2000,
      },
      error: null,
    })

    const registeredCallbacks: Record<string, (arg?: unknown) => void> = {}

    const mockRealtimeClient = {
      isConnected: vi.fn().mockReturnValue(true),
      getConnectionState: vi.fn().mockReturnValue('connected'),
      sessionId: 'ses_decart_rec_123',
      subscribeToken: 'sub_tok_rec',
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

    await decartStreamService.startLiveStream({
      referenceImage: mockSampleImage,
      prompt: 'Test prompt',
      ratePerSecondUSD: 0.04,
    })

    // Simulate Decart connected event -> triggers startSession()
    registeredCallbacks['connectionChange']?.('connected')
    // Wait for startSession to resolve
    await Promise.resolve()
    await Promise.resolve()

    expect(sessionBillingService.getState().isActive).toBe(true)
    const initialSessionId = sessionBillingService.getState().sessionId

    // Simulate Decart generating event immediately after
    registeredCallbacks['connectionChange']?.('generating')
    await Promise.resolve()

    // Simulate Decart reconnecting event
    registeredCallbacks['connectionChange']?.('reconnecting')
    expect(decartStreamService.getState()).toBe('reconnecting')

    // Simulate Decart re-connected event
    registeredCallbacks['connectionChange']?.('connected')
    await Promise.resolve()

    // Ensure session ID did not change and no second billing session was created
    expect(sessionBillingService.getState().sessionId).toBe(initialSessionId)
    // Only 1 start call was made to session-heartbeat
    const startCalls = vi.mocked(supabase.functions.invoke).mock.calls.filter(
      (c) => c[0] === 'session-heartbeat' && (c[1]?.body as Record<string, unknown> | undefined)?.action === 'start'
    )
    expect(startCalls.length).toBe(1)

    Object.defineProperty(navigator, 'mediaDevices', {
      value: originalMediaDevices,
      writable: true,
      configurable: true,
    })
  })

  it('Prevents simultaneous startLiveStream() calls on decartStreamService', async () => {
    const mockTrack = {
      stop: vi.fn(),
      kind: 'video',
      enabled: true,
    } as unknown as MediaStreamTrack

    const fakeLocalStream = {
      getTracks: vi.fn().mockReturnValue([mockTrack]),
    } as unknown as MediaStream

    const originalMediaDevices = navigator.mediaDevices
    Object.defineProperty(navigator, 'mediaDevices', {
      value: {
        ...originalMediaDevices,
        getUserMedia: vi.fn().mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve(fakeLocalStream), 50))
        ),
      },
      writable: true,
      configurable: true,
    })

    const streamPromise1 = decartStreamService.startLiveStream({
      referenceImage: mockSampleImage,
      prompt: 'Prompt 1',
    })

    // Immediate second call while first is in-flight
    await expect(
      decartStreamService.startLiveStream({
        referenceImage: mockSampleImage,
        prompt: 'Prompt 2',
      })
    ).rejects.toThrow('Live stream session is already active or connecting.')

    // Cleanup after first finishes or fails
    try {
      await streamPromise1
    } catch {
      // ignore
    }

    Object.defineProperty(navigator, 'mediaDevices', {
      value: originalMediaDevices,
      writable: true,
      configurable: true,
    })
  })
})
