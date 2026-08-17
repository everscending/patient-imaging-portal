'use client'

import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { useRouter } from 'next/navigation'
import { Filmstrip } from './Filmstrip'
import { ShareDialog } from '../share/ShareDialog'

export type ImageViewerProps = {
  images: Array<{
    id: string; width: number; height: number; ordinal: number
    url: string; thumbUrl: string | null; expiresAt: string
  }>
  initialImageId?: string
  shareLinkTtlHours?: number
  /** 'shared' hides the filmstrip and every action except zoom and pan. */
  variant: 'portal' | 'shared'
}

type Point = { x: number; y: number }
type FullImageState = 'loading' | 'loaded' | 'error'
type FullImageLoad = { key: string | undefined; state: FullImageState }
const MIN_ZOOM = 1
const MAX_ZOOM = 4
const ZOOM_STEP = 0.25
const PAN_STEP = 24

function boundedZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100))
}

export function ImageViewer({ images, initialImageId, shareLinkTtlHours, variant }: ImageViewerProps): JSX.Element {
  const router = useRouter()
  const [hydrated, setHydrated] = useState(false)
  const firstImageId = useMemo(
    () => images.find((image) => image.id === initialImageId)?.id ?? images[0]?.id,
    [images, initialImageId],
  )
  const [selectedImageId, setSelectedImageId] = useState(firstImageId)
  const [zoom, setZoom] = useState(MIN_ZOOM)
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 })
  const [fullImageLoad, setFullImageLoad] = useState<FullImageLoad>({ key: undefined, state: 'loading' })
  const [failedThumbnailKey, setFailedThumbnailKey] = useState<string>()
  const pointers = useRef(new Map<number, Point>())
  const dragOrigin = useRef<Point | null>(null)
  const pinchOrigin = useRef<{ distance: number; zoom: number } | null>(null)
  const selected = images.find((image) => image.id === selectedImageId)
  const selectedAssetKey = selected ? `${selected.id}:${selected.url}` : undefined
  const selectedThumbnailKey = selected?.thumbUrl ? `${selected.id}:${selected.thumbUrl}` : undefined
  const fullImageState = fullImageLoad.key === selectedAssetKey ? fullImageLoad.state : 'loading'

  useEffect(() => setHydrated(true), [])

  useEffect(() => {
    if (!images.some((image) => image.id === selectedImageId)) setSelectedImageId(firstImageId)
  }, [firstImageId, images, selectedImageId])

  // URLs are issued by the study API. Refresh the server-rendered manifest
  // shortly before the current selection expires; this component never signs
  // or constructs an imaging URL itself.
  useEffect(() => {
    if (!selected?.expiresAt) return
    const millisecondsUntilRefresh = Date.parse(selected.expiresAt) - Date.now() - 60_000
    if (!Number.isFinite(millisecondsUntilRefresh)) return
    const refreshTimer = window.setTimeout(router.refresh, Math.max(0, millisecondsUntilRefresh))
    return () => window.clearTimeout(refreshTimer)
  }, [router, selected?.expiresAt])

  const changeSelection = (imageId: string) => {
    setSelectedImageId(imageId)
    setZoom(MIN_ZOOM)
    setPan({ x: 0, y: 0 })
  }
  const changeZoom = (amount: number) => setZoom((current) => boundedZoom(current + amount))
  const reset = () => {
    setZoom(MIN_ZOOM)
    setPan({ x: 0, y: 0 })
  }
  const panBy = (x: number, y: number) => setPan((current) => ({ x: current.x + x, y: current.y + y }))
  const pinchDistance = () => {
    const [first, second] = [...pointers.current.values()]
    return first && second ? Math.hypot(first.x - second.x, first.y - second.y) : 0
  }
  const finishPointer = (pointerId: number) => {
    pointers.current.delete(pointerId)
    pinchOrigin.current = null
    const remaining = [...pointers.current.values()][0]
    dragOrigin.current = remaining ?? null
  }

  return (
    <section
      aria-label="Image viewer"
      className={`pip-image-viewer pip-image-viewer--${variant}`}
      data-hydrated={hydrated ? 'true' : 'false'}
      data-testid="image-viewer"
    >
      <div
        aria-label="Image canvas. Use arrow keys to pan, plus and minus to zoom."
        className="pip-image-canvas"
        data-testid="image-canvas"
        aria-busy={Boolean(selected?.url) && fullImageState === 'loading'}
        aria-keyshortcuts="+ - 0 ArrowLeft ArrowRight ArrowUp ArrowDown"
        onDoubleClick={() => changeZoom(ZOOM_STEP)}
        onKeyDown={(event) => {
          if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(ZOOM_STEP) }
          else if (event.key === '-') { event.preventDefault(); changeZoom(-ZOOM_STEP) }
          else if (event.key === '0') { event.preventDefault(); reset() }
          else if (event.key === 'ArrowLeft') { event.preventDefault(); panBy(-PAN_STEP, 0) }
          else if (event.key === 'ArrowRight') { event.preventDefault(); panBy(PAN_STEP, 0) }
          else if (event.key === 'ArrowUp') { event.preventDefault(); panBy(0, -PAN_STEP) }
          else if (event.key === 'ArrowDown') { event.preventDefault(); panBy(0, PAN_STEP) }
        }}
        onPointerDown={(event) => {
          try { event.currentTarget.setPointerCapture(event.pointerId) } catch { /* Synthetic touch tests have no native pointer capture. */ }
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
          if (pointers.current.size === 1) dragOrigin.current = { x: event.clientX, y: event.clientY }
          if (pointers.current.size === 2) {
            const distance = pinchDistance()
            pinchOrigin.current = distance > 0 ? { distance, zoom } : null
          }
        }}
        onPointerMove={(event) => {
          if (!pointers.current.has(event.pointerId)) return
          const previous = pointers.current.get(event.pointerId)!
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
          if (pointers.current.size === 2 && pinchOrigin.current) {
            setZoom(boundedZoom(pinchOrigin.current.zoom * (pinchDistance() / pinchOrigin.current.distance)))
          } else if (pointers.current.size === 1 && dragOrigin.current) {
            panBy(event.clientX - previous.x, event.clientY - previous.y)
          }
        }}
        onPointerUp={(event) => finishPointer(event.pointerId)}
        onPointerCancel={(event) => finishPointer(event.pointerId)}
        onWheel={(event) => { event.preventDefault(); changeZoom(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP) }}
        role="application"
        tabIndex={0}
      >
        {selected?.thumbUrl && fullImageState !== 'loaded' && selectedThumbnailKey !== failedThumbnailKey && (
          <img
            alt=""
            className="pip-viewer-image pip-viewer-thumb"
            data-testid="image-thumbnail"
            height={selected.height}
            onError={() => setFailedThumbnailKey(selectedThumbnailKey)}
            src={selected.thumbUrl}
            style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            width={selected.width}
          />
        )}
        {selected?.url && (
          <img
            alt={`Study image ${selected.ordinal}`}
            className="pip-viewer-image pip-viewer-full"
            data-testid="image-full"
            height={selected.height}
            onError={() => setFullImageLoad({ key: selectedAssetKey, state: 'error' })}
            onLoad={() => setFullImageLoad({ key: selectedAssetKey, state: 'loaded' })}
            src={selected.url}
            style={{ opacity: fullImageState === 'loaded' ? 1 : 0, transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            width={selected.width}
          />
        )}
        {selected && fullImageState === 'loading' && <p className="pip-viewer-loading" data-testid="image-loading" role="status">Loading full image…</p>}
        {selected && fullImageState === 'error' && <p className="pip-viewer-loading" data-testid="image-loading" role="status">Full image unavailable.</p>}
        {!selected && <p className="pip-viewer-loading" role="status">No images are available for this study.</p>}
      </div>
      <div aria-label="Image zoom controls" className="pip-viewer-controls" data-testid="image-zoom">
        <button aria-label="Zoom out" data-testid="zoom-out" onClick={() => changeZoom(-ZOOM_STEP)} type="button">−</button>
        <button aria-label="Reset zoom to 100%" data-testid="zoom-reset" onClick={reset} type="button">100%</button>
        <button aria-label="Zoom in" data-testid="zoom-in" onClick={() => changeZoom(ZOOM_STEP)} type="button">+</button>
        <output aria-atomic="true" aria-live="polite" data-testid="zoom-level">Zoom {Math.round(zoom * 100)}%</output>
      </div>
      {variant === 'portal' && selected && shareLinkTtlHours !== undefined ? (
        <div className="pip-viewer-share" aria-label="Image actions">
          <ShareDialog resourceId={selected.id} resourceKind="image" shareLinkTtlHours={shareLinkTtlHours} />
        </div>
      ) : null}
      {variant === 'portal' && <Filmstrip images={images} onSelect={changeSelection} selectedImageId={selectedImageId} />}
      <time className="pip-visually-hidden" dateTime={selected?.expiresAt}>Image URL expires at {selected?.expiresAt}</time>
      <style jsx>{`
        .pip-image-viewer { display: grid; gap: 0.5rem; width: 100%; min-width: 0; max-width: 100%; box-sizing: border-box; }
        .pip-image-canvas {
          position: relative; display: grid; place-items: center; min-width: 0; min-height: min(65vh, 34rem);
          overflow: hidden; touch-action: none; background: var(--pip-color-base-content); cursor: grab;
        }
        .pip-image-canvas:focus-visible { outline: 3px solid var(--pip-color-accent); outline-offset: 2px; }
        .pip-viewer-image { position: absolute; max-width: 100%; max-height: 100%; object-fit: contain; transition: opacity 120ms linear; }
        .pip-viewer-thumb { filter: blur(1px); transform: scale(1.01); }
        .pip-viewer-full { will-change: transform; transform-origin: center; }
        .pip-viewer-loading { z-index: 1; padding: 0.5rem 0.75rem; border-radius: 0.375rem; color: var(--pip-color-base-content); background: var(--pip-color-base-100); }
        .pip-viewer-controls { display: flex; flex-wrap: wrap; align-items: center; min-width: 0; gap: 0.5rem; }
        .pip-viewer-controls button { min-width: var(--pip-tap-target); min-height: var(--pip-tap-target); padding: 0.5rem; border: 1px solid var(--pip-color-base-300); border-radius: 0.375rem; color: var(--pip-color-base-content); background: var(--pip-color-base-100); cursor: pointer; }
        .pip-viewer-controls button:focus-visible { outline: 2px solid var(--pip-color-accent); outline-offset: 2px; }
        .pip-viewer-controls output { min-height: var(--pip-tap-target); display: flex; align-items: center; }
        .pip-viewer-share { display: flex; }
        @media (max-width: 390px) { .pip-image-canvas { min-height: 18rem; } .pip-viewer-controls { justify-content: space-between; } }
      `}</style>
    </section>
  )
}
