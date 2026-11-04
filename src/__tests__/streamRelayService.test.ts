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
})
