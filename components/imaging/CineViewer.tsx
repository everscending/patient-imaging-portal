'use client'

import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { CineControls } from './CineControls'

export type CineViewerProps = {
  clip: {
    id: string
    frameCount: number
    defaultFps: number
    frames: Array<{ index: number; url: string | null; available: boolean }>
    expiresAt: string
  }
}

export function CineViewer({ clip }: CineViewerProps): JSX.Element {
  const [currentFrame, setCurrentFrame] = useState(0)
  const [fps, setFps] = useState(clip.defaultFps)
  const [isPlaying, setIsPlaying] = useState(false)
  const [imageLoading, setImageLoading] = useState(true)
  const framesByIndex = useMemo(() => new Map(clip.frames.map((frame) => [frame.index, frame])), [clip.frames])
  const unavailableFrames = useMemo(
    () => Array.from({ length: clip.frameCount }, (_, index) => index).filter((index) => framesByIndex.get(index)?.available === false),
    [clip.frameCount, framesByIndex],
  )
  const frame = framesByIndex.get(currentFrame)
  const unavailable = frame?.available === false

  function advance(direction: 1 | -1): void {
    setCurrentFrame((index) => (index + direction + clip.frameCount) % clip.frameCount)
  }

  useEffect(() => {
    if (!isPlaying || clip.frameCount < 1) return
    const timer = window.setInterval(() => advance(1), 1000 / fps)
    return () => window.clearInterval(timer)
  }, [clip.frameCount, fps, isPlaying])

  useEffect(() => {
    setImageLoading(true)
  }, [currentFrame])

  return (
    <div className="cine-viewer" data-testid="cine-viewer">
      <div className="cine-viewer__frame" aria-busy={!unavailable && imageLoading}>
        {unavailable ? (
          <p data-testid="cine-frame-gap" role="status">
            Frame {currentFrame} unavailable
          </p>
        ) : frame?.url ? (
          <>
            <img src={frame.url} alt={`Cine frame ${currentFrame + 1}`} onLoad={() => setImageLoading(false)} />
            {imageLoading ? <p className="cine-viewer__loading" role="status">Loading frame…</p> : null}
          </>
        ) : (
          <p role="status">Loading frame…</p>
        )}
      </div>
      <CineControls
        currentFrame={currentFrame}
        frameCount={clip.frameCount}
        fps={fps}
        isPlaying={isPlaying}
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
        img { display: block; width: 100%; max-height: 32rem; object-fit: contain; }
        .cine-viewer__loading { position: absolute; inset: auto 0 0; margin: 0; padding: 0.5rem 0.75rem; color: var(--pip-color-base-100); background: var(--pip-color-secondary); }
      `}</style>
    </div>
  )
}
