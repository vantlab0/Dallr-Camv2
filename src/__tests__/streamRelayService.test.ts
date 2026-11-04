import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StreamRelayService } from '@/services/streamRelayService'

describe('StreamRelayService', () => {
  let senderService: StreamRelayService
  let receiverService: StreamRelayService

  // Simulated BroadcastChannel
  class MockBroadcastChannel {
    public name: string
    public onmessage: ((ev: MessageEvent) => void) | null = null
    private static channels = new Map<string, Set<MockBroadcastChannel>>()

    constructor(name: string) {
      this.name = name
      if (!MockBroadcastChannel.channels.has(name)) {
        MockBroadcastChannel.channels.set(name, new Set())
      }
      MockBroadcastChannel.channels.get(name)!.add(this)
    }

    postMessage(data: unknown) {
      const set = MockBroadcastChannel.channels.get(this.name)
      if (set) {
        set.forEach((ch) => {
          if (ch !== this && ch.onmessage) {
            ch.onmessage(new MessageEvent('message', { data }))
          }
        })
      }
    }

    close() {
      MockBroadcastChannel.channels.get(this.name)?.delete(this)
    }

    static clear() {
      MockBroadcastChannel.channels.clear()
    }
  }

  beforeEach(() => {
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel)
    senderService = new StreamRelayService()
    receiverService = new StreamRelayService()
  })

  afterEach(() => {
    senderService.destroy()
    receiverService.destroy()
    MockBroadcastChannel.clear()
    vi.restoreAllMocks()
  })

  it('notifies receiver when session is ended by sender', () => {
    const onEndedSpy = vi.fn()
    receiverService.startReceiving()
    receiverService.onSessionEnded(onEndedSpy)

    senderService.notifySessionEnded()

    expect(onEndedSpy).toHaveBeenCalledTimes(1)
  })

  it('handles requestEndSession message from receiver window', () => {
    const onRequestEndSpy = vi.fn()
    senderService.startBroadcasting({
      getTracks: () => [],
      getVideoTracks: () => [],
      getAudioTracks: () => [],
    } as unknown as MediaStream)
    senderService.onRequestEndSession(onRequestEndSpy)

    receiverService.startReceiving()
    receiverService.requestEndSession()

    expect(onRequestEndSpy).toHaveBeenCalledTimes(1)
  })

  it('coordinates signaling without throwing in browser environments', () => {
    expect(() => {
      const fakeStream = {
        getTracks: () => [],
        getVideoTracks: () => [],
        getAudioTracks: () => [],
      } as unknown as MediaStream

      senderService.startBroadcasting(fakeStream)
      receiverService.startReceiving()
    }).not.toThrow()
  })

  it('buffers ICE candidates received before remoteDescription is set and drains them after', async () => {
    const addIceCandidateSpy = vi.fn().mockResolvedValue(undefined)
    let remoteDescription: RTCSessionDescription | null = null

    class FakeRTCPeerConnection {
      public ontrack: any = null
      public onicecandidate: any = null
      public addIceCandidate = addIceCandidateSpy
      public close = vi.fn()

      get remoteDescription() {
        return remoteDescription
      }

      async setRemoteDescription(desc: any) {
        remoteDescription = desc
      }

      async createAnswer() {
        return { type: 'answer', sdp: 'fake-answer-sdp' }
      }

      async setLocalDescription() {}
    }

    vi.stubGlobal('RTCPeerConnection', FakeRTCPeerConnection)
    vi.stubGlobal('RTCSessionDescription', class {
      constructor(public init: any) {}
    })
    vi.stubGlobal('RTCIceCandidate', class {
      constructor(public init: any) {}
    })

    const testReceiver = new StreamRelayService()
    testReceiver.startReceiving()

    // Simulate early ICE candidate message arriving before offer/remoteDescription
    const fakeCandidate = { candidate: 'candidate:1 1 UDP 12345 127.0.0.1 5000 typ host', sdpMid: '0' }
    await (testReceiver as any).handleIncomingMessage({
      type: 'relay-ice-candidate',
      candidate: fakeCandidate,
    })

    // Candidate should NOT be added yet because remoteDescription is null
    expect(addIceCandidateSpy).not.toHaveBeenCalled()
    expect((testReceiver as any).pendingIceCandidates).toHaveLength(1)

    // Now offer arrives and setRemoteDescription is invoked
    await (testReceiver as any).handleIncomingMessage({
      type: 'relay-offer',
      sdp: { type: 'offer', sdp: 'fake-offer-sdp' },
    })

    // Now buffered candidate should be drained and added
    expect(addIceCandidateSpy).toHaveBeenCalledTimes(1)
    expect((testReceiver as any).pendingIceCandidates).toHaveLength(0)

    testReceiver.destroy()
  })
})
