// Patient-facing imaging manifests. Authorization belongs to guardPhiAccess;
// this module only reads through the caller's RLS-scoped client and turns
// opaque storage keys into the pinned wire shapes.
import 'server-only'

import { anonClient } from '../db/client'
import { config } from '../config'
import { signStorageKeys } from './signing'

type Client = ReturnType<typeof anonClient>

type StudyRow = { id: string; description: string; visit_id: string }
type VisitRow = { id: string; occurred_at: string; status: 'completed' | 'scheduled' | 'cancelled'; provider_id: string }
// The visit a study belongs to used to cost a second, dependent round. It is
// a to-one embedded resource, so PostgREST returns it with the study itself.
type StudyWithVisitRow = StudyRow & { visits: VisitRow | null }
const STUDY_WITH_VISIT_COLUMNS = 'id, description, visit_id, visits(id, occurred_at, status, provider_id)'
type ProviderRow = { id: string; full_name: string }
type ImageRow = { id: string; width: number; height: number; ordinal: number; storage_key: string; thumb_key: string | null }
type ClipRow = { id: string; study_id: string; frame_count: number; default_fps: number; poster_key: string | null }
type FrameRow = { frame_index: number; storage_key: string }

function expiresAt(): string {
  return new Date(Date.now() + config.signedUrlTtlSeconds * 1000).toISOString()
}

async function rows<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await query
  if (error) throw new Error('studies: caller-scoped read failed')
  return (data as T[] | null) ?? []
}

async function row<T>(query: PromiseLike<{ data: unknown; error: unknown }>): Promise<T | null> {
  const { data, error } = await query
  if (error) throw new Error('studies: caller-scoped read failed')
  return (data as T | null) ?? null
}

async function completedVisit(client: Client, visitId: string): Promise<VisitRow | null> {
  const visit = await row<VisitRow>(client.from('visits').select('id, occurred_at, status, provider_id').eq('id', visitId).maybeSingle())
  return visit?.status === 'completed' ? visit : null
}

function embeddedCompletedVisit(study: StudyWithVisitRow | null): VisitRow | null {
  return study?.visits?.status === 'completed' ? study.visits : null
}

export async function listStudies(client: Client): Promise<{ studies: Array<Record<string, string | number>> }> {
  const studies = await rows<StudyRow>(client.from('studies').select('id, description, visit_id'))
  const visible = await Promise.all(
    studies.map(async (study) => ({ study, visit: await completedVisit(client, study.visit_id) })),
  )
  const completed = visible.filter((entry): entry is { study: StudyRow; visit: VisitRow } => entry.visit !== null)

  return {
    studies: await Promise.all(
      completed.map(async ({ study, visit }) => {
        const [provider, images, clips] = await Promise.all([
          row<ProviderRow>(client.from('providers').select('id, full_name').eq('id', visit.provider_id).maybeSingle()),
          rows<{ id: string }>(client.from('images').select('id').eq('study_id', study.id)),
          rows<{ id: string }>(client.from('cine_clips').select('id').eq('study_id', study.id)),
        ])
        // providers are globally readable by policy; a missing row means the
        // relational record is inconsistent, not an excuse to expose a name.
        return {
          id: study.id,
          description: study.description,
          occurredAt: visit.occurred_at,
          providerName: provider?.full_name ?? '',
          imageCount: images.length,
          clipCount: clips.length,
        }
      }),
    ),
  }
}

export async function studyDetail(client: Client, studyId: string): Promise<Record<string, unknown> | null> {
  const study = await row<StudyWithVisitRow>(client.from('studies').select(STUDY_WITH_VISIT_COLUMNS).eq('id', studyId).maybeSingle())
  const visit = embeddedCompletedVisit(study)
  if (!study || !visit) return null

  const [images, clips] = await Promise.all([
    rows<ImageRow>(client.from('images').select('id, width, height, ordinal, storage_key, thumb_key').eq('study_id', studyId).order('ordinal')),
    rows<ClipRow>(client.from('cine_clips').select('id, study_id, frame_count, default_fps, poster_key').eq('study_id', studyId)),
  ])
  const imageKeys = images.flatMap((image) => [image.storage_key, ...(image.thumb_key ? [image.thumb_key] : [])])
  const signed = await signStorageKeys(imageKeys)
  const signedByKey = new Map(signed.map((entry) => [entry.key, entry]))
  const expiry = expiresAt()
  const clipPosters = await signStorageKeys(clips.flatMap((clip) => (clip.poster_key ? [clip.poster_key] : [])))
  const postersByKey = new Map(clipPosters.map((entry) => [entry.key, entry]))

  return {
    id: study.id,
    description: study.description,
    occurredAt: visit.occurred_at,
    imageSigningFailed: signed.some((entry) => entry.batchFailed),
    images: images.map((image) => ({
      id: image.id,
      width: image.width,
      height: image.height,
      ordinal: image.ordinal,
      url: signedByKey.get(image.storage_key)?.url ?? null,
      thumbUrl: image.thumb_key ? (signedByKey.get(image.thumb_key)?.url ?? null) : null,
      expiresAt: expiry,
    })),
    clips: clips.map((clip) => ({
      id: clip.id,
      frameCount: clip.frame_count,
      defaultFps: clip.default_fps,
      posterUrl: clip.poster_key ? (postersByKey.get(clip.poster_key)?.url ?? null) : null,
    })),
  }
}

export async function clipManifest(client: Client, studyId: string, clipId: string): Promise<Record<string, unknown> | null> {
  const clip = await row<ClipRow & { studies: StudyWithVisitRow | null }>(
    client.from('cine_clips')
      .select(`id, study_id, frame_count, default_fps, poster_key, studies(${STUDY_WITH_VISIT_COLUMNS})`)
      .eq('id', clipId).eq('study_id', studyId).maybeSingle(),
  )
  if (!clip || !embeddedCompletedVisit(clip.studies)) return null

  const storedFrames = await rows<FrameRow>(client.from('cine_frames').select('frame_index, storage_key').eq('clip_id', clipId).order('frame_index'))
  const keysByIndex = new Map(storedFrames.map((frame) => [frame.frame_index, frame.storage_key]))
  const signed = await signStorageKeys(storedFrames.map((frame) => frame.storage_key))
  const signedByKey = new Map(signed.map((entry) => [entry.key, entry]))
  const expiry = expiresAt()

  return {
    id: clip.id,
    frameCount: clip.frame_count,
    defaultFps: clip.default_fps,
    frames: Array.from({ length: clip.frame_count }, (_, index) => {
      const key = keysByIndex.get(index)
      const entry = key ? signedByKey.get(key) : undefined
      return entry?.available && entry.url
        ? { index, url: entry.url, available: true }
        : { index, available: false }
    }),
    expiresAt: expiry,
  }
}
