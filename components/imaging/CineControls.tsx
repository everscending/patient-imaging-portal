'use client'

import type { JSX } from 'react'

type CineControlsProps = {
  currentFrame: number
  frameCount: number
  fps: number
  isPlaying: boolean
  unavailableFrames: number[]
  onFrameChange: (frame: number) => void
  onFpsChange: (fps: number) => void
  onNext: () => void
  onPrevious: () => void
  onTogglePlayback: () => void
}

export function CineControls({
  currentFrame,
  frameCount,
  fps,
  isPlaying,
  unavailableFrames,
  onFrameChange,
  onFpsChange,
  onNext,
  onPrevious,
  onTogglePlayback,
}: CineControlsProps): JSX.Element {
  const maximumFrame = Math.max(0, frameCount - 1)
  const unavailableNotice = `${unavailableFrames.length} of ${frameCount} frames unavailable — playback continues`

  return (
    <section className="cine-controls" aria-label="Cine controls">
      <div className="cine-controls__buttons">
        <button data-testid="cine-prev" type="button" onClick={onPrevious} aria-label="Previous frame">
          Previous
        </button>
        <button
          data-testid="cine-play"
          type="button"
          onClick={onTogglePlayback}
          aria-label={isPlaying ? 'Pause playback' : 'Play playback'}
        >
          {isPlaying ? 'Pause' : 'Play'}
        </button>
        <button data-testid="cine-next" type="button" onClick={onNext} aria-label="Next frame">
          Next
        </button>
      </div>

      <label className="cine-controls__scrub" htmlFor="cine-scrub">
        <span>Frame</span>
        <span className="cine-controls__track-wrap">
          <input
            id="cine-scrub"
            type="range"
            min="0"
            max={maximumFrame}
            value={Math.min(currentFrame, maximumFrame)}
            onChange={(event) => onFrameChange(Number(event.target.value))}
            aria-label="Frame scrubber"
          />
          <span className="cine-controls__gap-markers" aria-hidden="true">
            {unavailableFrames.map((frame) => (
              <i key={frame} style={{ left: `${frameCount > 1 ? (frame / maximumFrame) * 100 : 0}%` }} />
            ))}
          </span>
        </span>
      </label>

      <label className="cine-controls__rate" htmlFor="cine-fps">
        <span>Playback rate</span>
        <select
          data-testid="cine-fps"
          id="cine-fps"
          value={fps}
          onChange={(event) => onFpsChange(Number(event.target.value))}
        >
          {[6, 12, 18, 24, 30].includes(fps) ? null : <option value={fps}>{fps} fps</option>}
          {[6, 12, 18, 24, 30].map((option) => (
            <option key={option} value={option}>
              {option} fps
            </option>
          ))}
        </select>
      </label>

      <p className="cine-controls__counter" aria-live="polite">
        Frame {currentFrame + 1} of {frameCount}
      </p>
      {unavailableFrames.length > 0 ? <p className="cine-controls__notice">{unavailableNotice}</p> : null}

      <style jsx>{`
        .cine-controls {
          display: grid;
          gap: 0.75rem;
          padding: 0.875rem;
          border: 1px solid var(--pip-color-base-300);
          border-radius: 0 0 0.75rem 0.75rem;
          background: var(--pip-color-base-100);
        }
        .cine-controls__buttons { display: flex; gap: 0.5rem; flex-wrap: wrap; }
        button, select, input { font: inherit; }
        button, select { min-height: var(--pip-tap-target); min-width: var(--pip-tap-target); }
        button { padding: 0.5rem 0.75rem; border: 1px solid var(--pip-color-primary); border-radius: 0.5rem; color: var(--pip-color-primary); background: var(--pip-color-base-100); font-weight: 600; }
        button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--pip-color-accent); outline-offset: 2px; }
        .cine-controls__scrub, .cine-controls__rate { display: grid; gap: 0.25rem; font-weight: 600; }
        .cine-controls__track-wrap { position: relative; display: block; min-height: var(--pip-tap-target); }
        input[type='range'] { width: 100%; min-height: var(--pip-tap-target); margin: 0; }
        .cine-controls__gap-markers { position: absolute; inset: 0.5rem 0.5rem; pointer-events: none; }
        .cine-controls__gap-markers i { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--pip-color-error); transform: translateX(-1px); }
        select { max-width: 10rem; padding: 0.25rem 0.5rem; border: 1px solid var(--pip-color-base-300); border-radius: 0.5rem; color: var(--pip-color-base-content); background: var(--pip-color-base-100); }
        .cine-controls__counter, .cine-controls__notice { margin: 0; }
        .cine-controls__notice { color: var(--pip-color-secondary); }
      `}</style>
    </section>
  )
}
