import type { CineViewerProps } from '../../../../../../components/imaging/CineViewer'

type Clip = CineViewerProps['clip']
type WireFrame =
  | { index: number; available: true; url: string }
  | { index: number; available: false; url?: string | null }
type WireClip = Omit<Clip, 'frames'> & { frames: WireFrame[] }

function isFrame(value: unknown): value is WireFrame {
  if (!value || typeof value !== 'object') return false
  const frame = value as { index?: unknown; available?: unknown; url?: unknown }
  if (!Number.isInteger(frame.index) || typeof frame.available !== 'boolean') return false
  if (frame.available) return typeof frame.url === 'string'
  return frame.url === undefined || frame.url === null || typeof frame.url === 'string'
}

function isClip(value: unknown): value is WireClip {
  if (!value || typeof value !== 'object') return false
  const clip = value as Partial<Clip>
  return (
    typeof clip.id === 'string' &&
    typeof clip.frameCount === 'number' &&
    typeof clip.defaultFps === 'number' &&
    typeof clip.expiresAt === 'string' &&
    Array.isArray(clip.frames) &&
    clip.frames.every(isFrame)
  )
}

export function normalizeClipPayload(value: unknown): Clip | null {
  if (!isClip(value)) return null
  return {
    ...value,
    frames: value.frames.map((frame) => ({
      index: frame.index,
      url: frame.available ? frame.url : null,
      available: frame.available,
    })),
  }
}
