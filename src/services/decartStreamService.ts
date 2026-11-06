import { createDecartClient, models, type RealTimeClient, type DecartSDKError } from '@decartai/sdk'
import { decartService } from '@/services/decartService'
import { sessionBillingService } from '@/services/sessionBillingService'
import type {
  PreparedImageReference,
  LiveStreamConnectionState,
  LiveStreamMetrics,
  LiveStreamSessionInfo,
} from '@/types/live'

export interface DecartStreamServiceListeners {
  onStateChange?: (state: LiveStreamConnectionState) => void
  onRemoteStream?: (stream: MediaStream) => void
  onLocalStream?: (stream: MediaStream) => void
  onGenerationTick?: (data: { seconds: number; usageUSD: number }) => void
  onError?: (error: { code: string; message: string }) => void
  onStats?: (stats: LiveStreamMetrics) => void
  onInsufficientFunds?: (data: { seconds: number; billedUSD: number }) => void
}

export interface ConnectStreamOptions {
  referenceImage: PreparedImageReference
  prompt: string
  ratePerSecondUSD?: number
  mirror?: 'auto' | boolean
  speed?: 'fast'
}

export class DecartStreamService {
  private client: ReturnType<typeof createDecartClient> | null = null
  private realtimeClient: RealTimeClient | null = null
  private localStream: MediaStream | null = null
  private remoteStream: MediaStream | null = null

  private currentState: LiveStreamConnectionState = 'idle'
  private currentSession: LiveStreamSessionInfo | null = null
  private listeners: DecartStreamServiceListeners = {}
  private isStartingStream: boolean = false

  private ratePerSecondUSD: number = 0.04
  private lastPrompt: string = ''
  private lastImageRef: PreparedImageReference | null = null

  constructor() {
    this.initDecartClient()
    this.initBillingListeners()
  }

  private initBillingListeners() {
    sessionBillingService.setListeners({
      onInsufficientFundsTerminated: (seconds, billedUSD) => {
        this.listeners.onInsufficientFunds?.({ seconds, billedUSD })
        void this.endLiveStream()
      },
      onError: (errMsg) => {
        console.warn('Billing service error terminating stream:', errMsg)
        this.listeners.onError?.({ code: 'BILLING_ERROR', message: errMsg })
        void this.endLiveStream()
      },
    })
  }

  private initDecartClient() {
    this.client = createDecartClient({
      apiKeyProvider: async () => {
        const token = await decartService.requestClientToken()
        return token.apiKey
      },
    })
  }

  public setListeners(listeners: DecartStreamServiceListeners) {
    this.listeners = { ...this.listeners, ...listeners }
  }

  public removeListeners() {
    this.listeners = {}
  }

  public getState(): LiveStreamConnectionState {
    return this.currentState
  }

  public getSessionInfo(): LiveStreamSessionInfo | null {
    return this.currentSession
  }

  public getLocalStream(): MediaStream | null {
    return this.localStream
  }

  public getRemoteStream(): MediaStream | null {
    return this.remoteStream
  }

  public getSubscribeToken(): string | null {
    return this.realtimeClient?.subscribeToken ?? null
  }

  public getSessionId(): string | null {
    return this.realtimeClient?.sessionId ?? null
  }

  private updateState(newState: LiveStreamConnectionState) {
    this.currentState = newState
    this.listeners.onStateChange?.(newState)
  }

  public async acquireLocalMedia(model = models.realtime('lucy-2.5')): Promise<MediaStream> {
    if (this.localStream) {
      return this.localStream
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: model.width },
          height: { ideal: model.height },
          frameRate: { ideal: 30, max: 30 },
          facingMode: 'user',
        },
        audio: true,
      })

      this.localStream = stream
      this.listeners.onLocalStream?.(stream)
      return stream
    } catch (err: unknown) {
      console.error('Camera/mic access error:', err)
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        throw new Error('Camera or microphone permission denied. Please allow device access.')
      } else if (err instanceof DOMException && err.name === 'NotFoundError') {
        throw new Error('No camera or microphone input device found.')
      }
      throw new Error(err instanceof Error ? err.message : 'Failed to access camera.')
    }
  }

  public async startLiveStream(options: ConnectStreamOptions): Promise<LiveStreamSessionInfo> {
    const { referenceImage, prompt, ratePerSecondUSD = 0.04, mirror = 'auto', speed } = options

    if (
      this.isStartingStream ||
      this.currentState === 'connected' ||
      this.currentState === 'connecting' ||
      this.currentState === 'preparing'
    ) {
      throw new Error('Live stream session is already active or connecting.')
    }

    this.isStartingStream = true
    this.ratePerSecondUSD = ratePerSecondUSD
    this.lastPrompt = prompt
    this.lastImageRef = referenceImage

    this.updateState('preparing')

    try {
      const model = models.realtime('lucy-2.5')
      const localStream = await this.acquireLocalMedia(model)

      this.updateState('connecting')

      if (!this.client) {
        this.initDecartClient()
      }

      const imagePayload = referenceImage.dataUrl || referenceImage.file

      const realtimeClient = await this.client!.realtime.connect(localStream, {
        model,
        mirror,
        ...(speed ? { speed } : {}),
        onRemoteStream: (transformedStream: MediaStream) => {
          this.remoteStream = transformedStream
          this.listeners.onRemoteStream?.(transformedStream)
          this.updateState('connected')
        },
        initialState: {
          prompt: {
            text: prompt,
            enhance: true,
          },
          image: imagePayload,
        },
      })

      this.realtimeClient = realtimeClient

      realtimeClient.on('connectionChange', (state) => {
        if (state === 'connected' || state === 'generating') {
          this.updateState('connected')

          const billingState = sessionBillingService.getState()

          if (!billingState.isActive && !billingState.isStarting) {
            // Authoritatively start billing only once, then immediately mark the
            // server session as billable because the stream is actually generating.
            sessionBillingService
              .startSession(realtimeClient.sessionId || undefined)
              .then(() => sessionBillingService.resumeBilling())
              .catch((err: unknown) => {
                const message = err instanceof Error ? err.message : 'Failed to start billing session'
                console.error('Billing startup failed, terminating live stream:', message)
                this.listeners.onError?.({ code: 'BILLING_START_FAILED', message })
                void this.endLiveStream()
              })
          } else if (billingState.isActive && !billingState.isStarting) {
            // Reconnected after a transient drop: resume the existing session
            // instead of creating a duplicate one.
            void sessionBillingService.resumeBilling()
          }
        } else if (state === 'reconnecting') {
          // Stop charging immediately while the stream is being re-established.
          this.updateState('reconnecting')
          void sessionBillingService.pauseBilling()
        } else if (state === 'connecting') {
          this.updateState('connecting')
          void sessionBillingService.pauseBilling()
        } else if (state === 'disconnected') {
          if (this.currentState !== 'ending' && this.currentState !== 'ended') {
            void this.handleDisconnectedStream()
          }
        }
      })

      realtimeClient.on('generationTick', ({ seconds }) => {
        sessionBillingService.onGenerationTick(seconds)
        const usageUSD = Number((seconds * this.ratePerSecondUSD).toFixed(4))
        this.listeners.onGenerationTick?.({ seconds, usageUSD })
      })

      realtimeClient.on('error', (err: DecartSDKError) => {
        console.error('Decart WebRTC SDK Error:', err)
        let friendlyMessage = err.message
        if (err.code === 'TOKEN_EXPIRED') {
          friendlyMessage = 'Session token expired. Reconnecting...'
        } else if (err.code === 'INVALID_API_KEY') {
          friendlyMessage = 'Decart API key is invalid.'
        } else if (err.code === 'WEB_RTC_ERROR') {
          friendlyMessage = 'WebRTC media connection error. Retrying...'
        }
        this.listeners.onError?.({ code: err.code, message: friendlyMessage })
      })

      realtimeClient.on('stats', (stats) => {
        this.listeners.onStats?.({
          fps: stats.video?.framesPerSecond,
          bitrate: stats.video?.bitrate,
          packetLoss: stats.video?.packetsLost,
          rttMs: stats.connection?.currentRoundTripTime
            ? Math.round(stats.connection.currentRoundTripTime * 1000)
            : undefined,
        })
      })

      const sessionInfo: LiveStreamSessionInfo = {
        sessionId: realtimeClient.sessionId || `decart_${Date.now()}`,
        subscribeToken: realtimeClient.subscribeToken || undefined,
        modelName: 'lucy-2.5',
        prompt,
        referenceImage,
        startedAt: new Date().toISOString(),
      }

      this.currentSession = sessionInfo
      return sessionInfo
    } catch (err: unknown) {
      this.updateState('failed')
      void sessionBillingService.endSession()
      const msg = err instanceof Error ? err.message : 'Failed to connect to Decart Lucy 2.5'
      this.listeners.onError?.({ code: 'CONNECT_FAILED', message: msg })
      this.cleanupMedia()
      throw err
    } finally {
      this.isStartingStream = false
    }
  }

  public async updatePrompt(newPrompt: string, enhance = true): Promise<void> {
    if (!this.realtimeClient || !this.realtimeClient.isConnected()) {
      throw new Error('No active Decart Lucy 2.5 stream to update prompt.')
    }

    this.lastPrompt = newPrompt
    if (this.lastImageRef) {
      await this.realtimeClient.set({
        prompt: newPrompt,
        image: this.lastImageRef.dataUrl || this.lastImageRef.file,
        enhance,
      })
    } else {
      await this.realtimeClient.setPrompt(newPrompt, { enhance })
    }

    if (this.currentSession) {
      this.currentSession.prompt = newPrompt
    }
  }

  public async updateReferenceImage(image: PreparedImageReference, enhance = true): Promise<void> {
    if (!this.realtimeClient || !this.realtimeClient.isConnected()) {
      throw new Error('No active Decart Lucy 2.5 stream to update image.')
    }

    this.lastImageRef = image
    await this.realtimeClient.set({
      prompt: this.lastPrompt,
      image: image.dataUrl || image.file,
      enhance,
    })

    if (this.currentSession) {
      this.currentSession.referenceImage = image
    }
  }

  private cleanupMedia() {
    if (this.localStream) {
      try {
        this.localStream.getTracks().forEach((track) => track.stop())
      } catch (err) {
        console.warn('Error stopping local tracks:', err)
      }
      this.localStream = null
    }
    this.remoteStream = null
  }

  /**
   * Handles an unexpected transport disconnection.
   * Billing is paused BEFORE finalizing so the disconnected period cannot be charged.
   */
  private async handleDisconnectedStream(): Promise<void> {
    try {
      await sessionBillingService.pauseBilling()
    } catch (err) {
      console.warn('Failed to pause billing on disconnect:', err)
    }

    this.updateState('failed')

    try {
      if (this.realtimeClient) {
        this.realtimeClient.disconnect()
        this.realtimeClient = null
      }
    } catch (err) {
      console.warn('Error disconnecting RealTimeClient after drop:', err)
    }

    this.cleanupMedia()
    this.currentSession = null

    await sessionBillingService.endSession()
  }

  public async endLiveStream(): Promise<void> {
    if (this.currentState === 'idle' || this.currentState === 'ended') {
      return
    }

    this.updateState('ending')

    try {
      if (this.realtimeClient) {
        this.realtimeClient.disconnect()
        this.realtimeClient = null
      }
    } catch (err) {
      console.warn('Error disconnecting RealTimeClient:', err)
    } finally {
      this.cleanupMedia()
      this.currentSession = null
      this.updateState('ended')
      await sessionBillingService.endSession()
      setTimeout(() => {
        if (this.currentState === 'ended') {
          this.updateState('idle')
        }
      }, 500)
    }
  }
}

export const decartStreamService = new DecartStreamService()
