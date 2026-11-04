import React, { useEffect, useRef, useState } from 'react'
import { streamRelayService } from '@/services/streamRelayService'

/**
 * Pure Borderless Video Output Page
 *
 * Strict Requirements:
 * - No title bar.
 * - No window borders.
 * - No application navigation.
 * - No buttons.
 * - No visible application controls.
 * - No unnecessary padding.
 * - No dashboard elements.
 * - Black background while video initializes and renders.
 * - Correct aspect ratio, responsive resizing, smooth rendering, object-contain.
 * - When closed or unmounted, requests session termination.
 */
export const VideoOutputPage: React.FC = () => {
  const videoRef = useRef<HTMLVideoElement>(null)
  const [stream, setStream] = useState<MediaStream | null>(null)

  useEffect(() => {
    // Connect to cross-window relay as receiver
    streamRelayService.onRemoteStream((remoteStream) => {
      setStream(remoteStream)
    })

    streamRelayService.onSessionEnded(() => {
      setStream(null)
      // Close window if session ended
      if (typeof window !== 'undefined') {
        window.close()
      }
    })

    streamRelayService.startReceiving()

    // Handle user closing or navigating away from this window
    const handleBeforeUnload = () => {
      streamRelayService.requestEndSession()
    }

    window.addEventListener('beforeunload', handleBeforeUnload)

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
      streamRelayService.requestEndSession()
    }
  }, [])

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream
      const playPromise = videoRef.current.play()
      if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch((err) => {
          console.warn('Auto-play error in video output window:', err)
        })
      }
    }
  }, [stream])

  return (
    <div
      data-testid="video-output-container"
      className="fixed inset-0 w-screen h-screen bg-black overflow-hidden flex items-center justify-center m-0 p-0 select-none border-none outline-none"
      style={{ margin: 0, padding: 0, backgroundColor: '#000000' }}
    >
      <video
        ref={videoRef}
        data-testid="video-output-player"
        autoPlay
        playsInline
        muted
        className={`w-full h-full object-contain pointer-events-none transition-opacity duration-300 ${
          stream ? 'opacity-100' : 'opacity-0'
        }`}
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'contain',
          backgroundColor: '#000000',
        }}
      />
    </div>
  )
}

export default VideoOutputPage
