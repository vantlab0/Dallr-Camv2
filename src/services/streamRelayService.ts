/**
 * Stream Relay Service
 * Cross-window stream-sharing mechanism using BroadcastChannel and local WebRTC peer-to-peer loopback.
 *
 * This enables the second borderless window to receive the live MediaStream from the Decart
 * session running in the main window with ZERO duplicate Decart sessions, minimal latency,
 * and zero additional billing.
 */

export const STREAM_RELAY_CHANNEL = 'dallr-cam-stream-relay'

export interface RelaySignalingMessage {
  type:
    | 'relay-ready'
    | 'relay-offer'
    | 'relay-answer'
    | 'relay-ice-candidate'
    | 'relay-ended'
    | 'request-close-session'
    | 'session-meta'
  sdp?: RTCSessionDescriptionInit
  candidate?: RTCIceCandidateInit
  meta?: {
    sessionId?: string
    model?: string
    fps?: number
  }
}

export type StreamRelayRole = 'sender' | 'receiver'

export class StreamRelayService {
  private channel: BroadcastChannel | null = null
  private peerConnection: RTCPeerConnection | null = null
  private pendingIceCandidates: RTCIceCandidateInit[] = []
  private role: StreamRelayRole | null = null
  private activeStream: MediaStream | null = null

  // Receiver callbacks
  private onRemoteStreamReceived?: (stream: MediaStream) => void
  private onSessionEndedCallback?: () => void
  private onRequestEndSessionCallback?: () => void

  constructor() {
    this.initChannel()
  }

  private initChannel() {
    if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
      try {
        this.channel = new BroadcastChannel(STREAM_RELAY_CHANNEL)
        this.channel.onmessage = (event) => {
          void this.handleIncomingMessage(event.data as RelaySignalingMessage)
        }
      } catch (err) {
        console.warn('BroadcastChannel not supported in current environment:', err)
      }
    }
  }

  /**
   * Set callback for receiver when remote stream is received
   */
  public onRemoteStream(callback: (stream: MediaStream) => void) {
    this.onRemoteStreamReceived = callback
  }

  /**
   * Set callback when the main sender ends the session
   */
  public onSessionEnded(callback: () => void) {
    this.onSessionEndedCallback = callback
  }

  /**
   * Set callback for main window when receiver window requests session end
   */
  public onRequestEndSession(callback: () => void) {
    this.onRequestEndSessionCallback = callback
  }

  /**
   * Initialize as sender in the main dashboard window.
   * Feeds the Decart transformed stream to any listening output window.
   */
  public startBroadcasting(stream: MediaStream) {
    this.role = 'sender'
    this.activeStream = stream

    // Notify any already open receiver window that sender is ready
    this.sendSignalingMessage({ type: 'relay-ready' })
  }

  /**
   * Updates or attaches a new stream track to the active sender connection
   */
  public updateStream(stream: MediaStream) {
    this.activeStream = stream
    if (this.peerConnection && this.role === 'sender') {
      const senders = this.peerConnection.getSenders()
      const newVideoTrack = stream.getVideoTracks()[0]
      const newAudioTrack = stream.getAudioTracks()[0]

      const videoSender = senders.find((s) => s.track?.kind === 'video')
      if (videoSender && newVideoTrack) {
        void videoSender.replaceTrack(newVideoTrack)
      } else if (!videoSender && newVideoTrack) {
        this.peerConnection.addTrack(newVideoTrack, stream)
      }

      const audioSender = senders.find((s) => s.track?.kind === 'audio')
      if (audioSender && newAudioTrack) {
        void audioSender.replaceTrack(newAudioTrack)
      } else if (!audioSender && newAudioTrack) {
        this.peerConnection.addTrack(newAudioTrack, stream)
      }
    } else if (this.role === 'sender') {
      void this.negotiateSenderConnection()
    }
  }

  /**
   * Initialize as receiver in the video output window.
   * Sends 'relay-ready' to inform sender to offer connection.
   */
  public startReceiving() {
    this.role = 'receiver'
    this.setupReceiverPeerConnection()
    this.sendSignalingMessage({ type: 'relay-ready' })
  }

  /**
   * Request that the main session be ended (e.g. when video output window closes)
   */
  public requestEndSession() {
    this.sendSignalingMessage({ type: 'request-close-session' })
  }

  /**
   * Inform receiver that the session has ended
   */
  public notifySessionEnded() {
    this.sendSignalingMessage({ type: 'relay-ended' })
    this.cleanupPeer()
  }

  private sendSignalingMessage(message: RelaySignalingMessage) {
    try {
      this.channel?.postMessage(message)
    } catch (err) {
      console.warn('Failed to post message over stream relay channel:', err)
    }
  }

  private setupReceiverPeerConnection() {
    if (typeof RTCPeerConnection === 'undefined') return

    if (this.peerConnection) {
      this.peerConnection.close()
    }

    const pc = new RTCPeerConnection({
      iceServers: [], // Local loopback between webviews on same host doesn't need external STUN/TURN
    })

    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        this.onRemoteStreamReceived?.(event.streams[0])
      } else {
        const stream = new MediaStream([event.track])
        this.onRemoteStreamReceived?.(stream)
      }
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignalingMessage({
          type: 'relay-ice-candidate',
          candidate: event.candidate.toJSON(),
        })
      }
    }

    this.peerConnection = pc
  }

  private async negotiateSenderConnection() {
    if (typeof RTCPeerConnection === 'undefined' || !this.activeStream) return

    if (this.peerConnection) {
      try {
        this.peerConnection.close()
      } catch {
        // ignore
      }
    }

    const pc = new RTCPeerConnection({
      iceServers: [],
    })

    // Attach Decart tracks
    this.activeStream.getTracks().forEach((track) => {
      pc.addTrack(track, this.activeStream!)
    })

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignalingMessage({
          type: 'relay-ice-candidate',
          candidate: event.candidate.toJSON(),
        })
      }
    }

    this.peerConnection = pc

    try {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      this.sendSignalingMessage({
        type: 'relay-offer',
        sdp: offer,
      })
    } catch (err) {
      console.error('Failed to create relay offer:', err)
    }
  }

  private async handleIncomingMessage(msg: RelaySignalingMessage) {
    if (!msg || !msg.type) return

    switch (msg.type) {
      case 'relay-ready':
        // If we are sender and have an active stream, negotiate connection with newly ready receiver
        if (this.role === 'sender' && this.activeStream) {
          await this.negotiateSenderConnection()
        }
        break

      case 'relay-offer':
        // Receiver handles offer from sender
        if (this.role === 'receiver' && msg.sdp) {
          if (!this.peerConnection) {
            this.setupReceiverPeerConnection()
          }
          if (this.peerConnection) {
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp))
            await this.drainPendingIceCandidates()
            const answer = await this.peerConnection.createAnswer()
            await this.peerConnection.setLocalDescription(answer)
            this.sendSignalingMessage({
              type: 'relay-answer',
              sdp: answer,
            })
          }
        }
        break

      case 'relay-answer':
        // Sender handles answer from receiver
        if (this.role === 'sender' && msg.sdp && this.peerConnection) {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(msg.sdp))
          await this.drainPendingIceCandidates()
        }
        break

      case 'relay-ice-candidate':
        if (msg.candidate) {
          if (this.peerConnection && this.peerConnection.remoteDescription && this.peerConnection.remoteDescription.type) {
            try {
              await this.peerConnection.addIceCandidate(new RTCIceCandidate(msg.candidate))
            } catch (err) {
              console.warn('Error adding ICE candidate in relay:', err)
            }
          } else {
            // Buffer candidate until remote description is set
            this.pendingIceCandidates.push(msg.candidate)
          }
        }
        break

      case 'relay-ended':
        if (this.role === 'receiver') {
          this.cleanupPeer()
          this.onSessionEndedCallback?.()
        }
        break

      case 'request-close-session':
        if (this.role === 'sender') {
          this.onRequestEndSessionCallback?.()
        }
        break
    }
  }

  private async drainPendingIceCandidates() {
    if (!this.peerConnection || !this.peerConnection.remoteDescription || this.pendingIceCandidates.length === 0) {
      return
    }

    const candidates = [...this.pendingIceCandidates]
    this.pendingIceCandidates = []

    for (const candidate of candidates) {
      try {
        await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
      } catch (err) {
        console.warn('Error applying buffered ICE candidate:', err)
      }
    }
  }

  public cleanupPeer() {
    this.pendingIceCandidates = []
    if (this.peerConnection) {
      try {
        this.peerConnection.close()
      } catch {
        // ignore
      }
      this.peerConnection = null
    }
  }

  public destroy() {
    this.cleanupPeer()
    if (this.channel) {
      try {
        this.channel.close()
      } catch {
        // ignore
      }
      this.channel = null
    }
    this.activeStream = null
    this.role = null
  }
}

export const streamRelayService = new StreamRelayService()
