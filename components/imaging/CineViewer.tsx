'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { CineControls } from './CineControls'

export type CineViewerProps = {
  clip: {
    id: string
    frameCount: number
    defaultFps: number
    frames: Array<{ index: number; url: string | null; available: boolean }>
    expiresAt: string
    /** EL-1: a small still of the first frame, drawn while frame bytes arrive. */
    posterUrl?: string | null
  }
}

// EL-1 (ADR-0005). At most this many frame fetches are in flight at once,
// plus the frame on screen. A 100-frame clip therefore issues its 100
// requests in windows of eight, never a hundred at once: the frames nearest
// the playhead are the ones in flight, and the rest of the page keeps
// connections to work with.
export const CINE_FRAME_WINDOW = 8

function withFrame(current: Set<number>, index: number): Set<number> {
  if (current.has(index)) return current
  const next = new Set(current)
  next.add(index)
  return next
}

export function CineViewer({ clip }: CineViewerProps): JSX.Element {
  const [currentFrame, setCurrentFrame] = useState(0)
  const [fps, setFps] = useState(clip.defaultFps)
  const [isPlaying, setIsPlaying] = useState(false)
  const [loadedFrames, setLoadedFrames] = useState<Set<number>>(() => new Set())
  const [settledFrames, setSettledFrames] = useState<Set<number>>(() => new Set())
  // The in-viewer frame cache: a decoded image per frame index, held so the
  // browser cannot evict what playback is about to need again.
  const frameCache = useRef(new Map<number, HTMLImageElement>())
  const requestedFrames = useRef(new Set<number>())
  const framesInFlight = useRef(0)
  const [posterFailed, setPosterFailed] = useState(false)
  const framesByIndex = useMemo(() => new Map(clip.frames.map((frame) => [frame.index, frame])), [clip.frames])
  const availableFrames = useMemo(() => clip.frames.filter((frame) => frame.available && frame.url), [clip.frames])
  const unavailableFrames = useMemo(
    () => Array.from({ length: clip.frameCount }, (_, index) => index).filter((index) => framesByIndex.get(index)?.available === false),
    [clip.frameCount, framesByIndex],
  )
  const frame = framesByIndex.get(currentFrame)
  const unavailable = frame?.available === false
  const posterVisible = Boolean(clip.posterUrl) && !posterFailed
  const imageLoading = !unavailable && !loadedFrames.has(currentFrame)
  const playbackReady = availableFrames.every((candidate) => settledFrames.has(candidate.index))

  function markLoaded(index: number): void {
    setLoadedFrames((current) => withFrame(current, index))
    setSettledFrames((current) => withFrame(current, index))
  }

  function markSettled(index: number): void {
    setSettledFrames((current) => withFrame(current, index))
  }

  function advance(direction: 1 | -1): void {
    setCurrentFrame((index) => (index + direction + clip.frameCount) % clip.frameCount)
  }

  useEffect(() => {
    if (!isPlaying || clip.frameCount < 1) return
    const timer = window.setInterval(() => {
      setCurrentFrame((index) => (index + 1) % clip.frameCount)
    }, 1000 / fps)
    return () => window.clearInterval(timer)
  }, [clip.frameCount, fps, isPlaying])

  // EL-1's fetch schedule. Frames are pulled ahead of the playhead in a
  // bounded window, and every decoded frame is kept in `frameCache` for the
  // life of the viewer, so stepping back over ground already covered — or a
  // second lap of playback — costs nothing.
  //
  // Which frames exist is the manifest's business, never this schedule's: a
  // frame the manifest marks unavailable is never fetched, and a fetch that
  // fails marks only that its attempt is over. Neither one creates a gap.
  useEffect(() => {
    const startFetch = (index: number, url: string, priority: 'high' | 'low'): void => {
      requestedFrames.current.add(index)
      framesInFlight.current += 1
      const image = new Image()
      image.fetchPriority = priority
      image.onload = () => {
        frameCache.current.set(index, image)
        framesInFlight.current -= 1
        setLoadedFrames((loaded) => withFrame(loaded, index))
        setSettledFrames((settled) => withFrame(settled, index))
      }
      image.onerror = () => {
        framesInFlight.current -= 1
        setSettledFrames((settled) => withFrame(settled, index))
      }
      image.src = url
    }

    // The frame on screen goes first and alone: until it has settled nothing
    // else competes with it for bandwidth, which is what makes the first
    // frame of a clip arrive as early as it can. It also starts regardless of
    // how many fetches are already in flight, so a scrub deep into the clip
    // is never queued behind the window that was filled for the old position.
    const current = framesByIndex.get(currentFrame)
    const currentIsFetchable = Boolean(current?.available && current.url)
    if (currentIsFetchable && !requestedFrames.current.has(currentFrame)) {
      startFetch(currentFrame, current!.url!, 'high')
    }
    if (currentIsFetchable && !settledFrames.has(currentFrame)) return

    for (let offset = 1; offset < clip.frameCount && framesInFlight.current < CINE_FRAME_WINDOW; offset++) {
      const index = (currentFrame + offset) % clip.frameCount
      if (requestedFrames.current.has(index)) continue
      const candidate = framesByIndex.get(index)
      if (!candidate?.available || !candidate.url) continue
      startFetch(index, candidate.url, 'low')
    }
  }, [clip.frameCount, currentFrame, framesByIndex, settledFrames])

  return (
    <div
      className="cine-viewer"
      data-testid="cine-viewer"
      data-playback-ready={playbackReady}
      data-frame-cache-size={frameCache.current.size}
    >
      <div className="cine-viewer__frame" aria-busy={!unavailable && imageLoading}>
        {unavailable ? (
          <p data-testid="cine-frame-gap" role="status">
            Frame {currentFrame} unavailable
          </p>
        ) : frame?.url ? (
          <>
            <img
              key={currentFrame}
              src={frame.url}
              alt={`Cine frame ${currentFrame + 1}`}
              data-frame-index={currentFrame}
              decoding="async"
              fetchPriority="high"
              onLoad={() => markLoaded(currentFrame)}
              onError={() => markSettled(currentFrame)}
              style={{ opacity: imageLoading ? 0 : 1 }}
            />
            {imageLoading && posterVisible ? (
              <img
                className="cine-viewer__poster"
                src={clip.posterUrl!}
                alt=""
                data-testid="cine-poster"
                onError={() => setPosterFailed(true)}
              />
            ) : null}
            {imageLoading ? (
              <p className="cine-viewer__loading" role="status" aria-label="Loading frame…">
                Loading frame…
              </p>
            ) : null}
          </>
        ) : (
          <p role="status" aria-label="Loading frame…">Loading frame…</p>
        )}
      </div>
      <CineControls
        currentFrame={currentFrame}
        frameCount={clip.frameCount}
        fps={fps}
        isPlaying={isPlaying}
        playbackReady={playbackReady}
        unavailableFrames={unavailableFrames}
        onFrameChange={setCurrentFrame}
        onFpsChange={setFps}
        onNext={() => advance(1)}
        onPrevious={() => advance(-1)}
        onTogglePlayback={() => setIsPlaying((playing) => !playing)}
      />
      <style jsx>{`
        .cine-viewer { width: min(100%, 58rem); margin: 0 auto; }
        .cine-viewer__frame { position: relative; display: grid; place-items: center; min-height: min(56vw, 32rem); overflow: hidden; border: 1px solid var(--pip-color-base-300); border-radius: 0.75rem 0.75rem 0 0; background: var(--pip-color-base-200); }
        img { grid-area: 1 / 1; display: block; width: 100%; max-height: 32rem; object-fit: contain; }
        .cine-viewer__poster { filter: blur(1px); }
        .cine-viewer__loading { position: absolute; inset: auto 0 0; margin: 0; padding: 0.5rem 0.75rem; color: var(--pip-color-base-100); background: var(--pip-color-secondary); }
      `}</style>
    </div>
  )
}
