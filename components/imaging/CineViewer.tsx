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

// The frame cache holds at most one entry per frame of the clip on screen,
// and a clip is at most 100 frames (DEL-4, ADR-0009) — so it is bounded by
// the dataset rather than by a limit of its own. At the pool's 640x480 that
// is on the order of a hundred megabytes decoded, the same as the DOM held
// before EL-1, and every one of those frames is pinned deliberately: the
// no-dropped-frames criterion (PF-2/PF-3, e2e/playback-frames.spec.ts) needs
// each frame decoded and ready before the playhead reaches it.
//
// ponytail: evicting the frames farthest from the playhead was measured and
// rejected — a ceiling of 24 dropped 39 of 100 frames in that check, because
// each frame renders through an element keyed to its own index and an
// evicted frame cannot re-decode inside one tick at 12 fps. Bounding memory
// means first making the viewer draw from the cached element instead of a
// fresh one per frame; that is a larger change than a cache limit.

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
  // Fetches outlive the viewer that started them. Their handlers check this
  // before touching state, so a clip closed mid-window settles quietly.
  // Set on mount, not only cleared on unmount: development remounts the
  // component to check its cleanup, and a flag that were only ever cleared
  // would leave the viewer permanently convinced it was gone.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
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
  const settledAvailableCount = availableFrames.filter((candidate) => settledFrames.has(candidate.index)).length
  const bufferingNotice = playbackReady
    ? null
    : `Preparing playback — ${settledAvailableCount} of ${availableFrames.length} frames`

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
      const finish = (decoded: boolean): void => {
        if (!mounted.current) return
        if (decoded) frameCache.current.set(index, image)
        framesInFlight.current -= 1
        if (decoded) setLoadedFrames((loaded) => withFrame(loaded, index))
        setSettledFrames((settled) => withFrame(settled, index))
      }
      image.src = url
      // decode(), not onload: onload fires when bytes have arrived, but the
      // bitmap is rasterized lazily at first paint — which made the first
      // playback lap flicker as every frame paid its decode on screen.
      // Settling only after decode() means playbackReady = every frame's
      // bitmap is already in the browser's image cache.
      if (typeof image.decode === 'function') {
        image.decode().then(() => finish(true), () => finish(false))
      } else {
        image.onload = () => finish(true)
        image.onerror = () => finish(false)
      }
    }

    // The frame on screen goes first and alone: until it has settled nothing
    // else competes with it for bandwidth, which is what makes the first
    // frame of a clip arrive as early as it can. A scrub deep into the clip
    // starts its fetch immediately rather than waiting for the open window to
    // drain — though a frame the old window had already asked for keeps the
    // low priority it was given, and every in-flight fetch still holds its
    // connection until it finishes.
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
              // sync: this element remounts every tick (key above); async
              // decoding lets the browser paint a blank frame first, sync
              // paints the already-decoded cached bitmap in the same frame.
              decoding="sync"
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
        bufferingNotice={bufferingNotice}
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
