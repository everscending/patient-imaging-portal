// db/seed/storage.ts — uploads an AssetPool (db/seed/assets.ts) to the
// private `phi` bucket (T6, db/storage/bucket.sql), idempotently. Never
// imports the Supabase JS SDK directly (ARCHITECTURE.md §2 reserves that to
// lib/db/client.ts) — instead it depends on the minimal structural shape
// below, which the real SupabaseClient satisfies and a fake client can
// implement for offline tests.
import { createHash } from 'node:crypto'

import type { AssetPool, PoolAsset } from './assets'

export const PHI_BUCKET = 'phi'

export type StorageObjectInfo = {
  name: string
  // Supabase's list() does not echo back custom upload metadata (verified
  // against the real API) — eTag is the backend's own content hash, quoted,
  // and is what "already present with the same content hash" is checked
  // against below.
  metadata: { eTag?: string } | null
}

export type StorageError = { message: string }

export type PhiStorageClient = {
  storage: {
    from(bucket: string): {
      list(prefix: string, options: { limit: number }): Promise<{ data: StorageObjectInfo[] | null; error: StorageError | null }>
      upload(
        path: string,
        body: Buffer,
        options: { contentType: string; upsert: boolean },
      ): Promise<{ data: unknown; error: StorageError | null }>
    }
  }
}

export type AssetUploadOutcome = 'uploaded' | 'skipped-already-present'

export type UploadPoolSummary = {
  outcomes: Record<string, AssetUploadOutcome>
  uploadedCount: number
  skippedCount: number
  missingKey: string
}

// One list() covers the whole ADR-0009 pool (840 assets) in a single call.
const LIST_LIMIT = 1000

async function listExistingByKey(client: PhiStorageClient): Promise<Map<string, StorageObjectInfo>> {
  const { data, error } = await client.storage.from(PHI_BUCKET).list('', { limit: LIST_LIMIT })
  if (error) throw new Error(`db/seed/storage: listing ${PHI_BUCKET} failed: ${error.message}`)

  const existing = new Map<string, StorageObjectInfo>()
  for (const object of data ?? []) existing.set(object.name, object)
  return existing
}

async function uploadAsset(client: PhiStorageClient, asset: PoolAsset): Promise<void> {
  const { error } = await client.storage.from(PHI_BUCKET).upload(asset.key, asset.bytes, {
    contentType: 'image/png',
    upsert: true,
  })
  if (error) throw new Error(`db/seed/storage: uploading ${asset.key} failed: ${error.message}`)
}

function md5Hex(bytes: Buffer): string {
  return createHash('md5').update(bytes).digest('hex')
}

// The backend quotes eTag ("<md5>"); strip the quotes so it compares
// directly against md5Hex's output.
function normalizedETag(eTag: string | undefined): string | null {
  if (!eTag) return null
  return eTag.replace(/^"|"$/g, '')
}

/** Uploads every `pool` asset to `phi` except the one marked `upload: false` (EC-2), skipping any already present under a matching content hash. */
export async function uploadPool(client: PhiStorageClient, pool: AssetPool): Promise<UploadPoolSummary> {
  const existing = await listExistingByKey(client)

  const outcomes: Record<string, AssetUploadOutcome> = {}
  let uploadedCount = 0
  let skippedCount = 0

  for (const asset of pool.assets) {
    if (!asset.upload) continue

    const found = existing.get(asset.key)
    const existingETag = normalizedETag(found?.metadata?.eTag)
    if (existingETag !== null && existingETag === md5Hex(asset.bytes)) {
      outcomes[asset.key] = 'skipped-already-present'
      skippedCount += 1
      continue
    }

    await uploadAsset(client, asset)
    outcomes[asset.key] = 'uploaded'
    uploadedCount += 1
  }

  return { outcomes, uploadedCount, skippedCount, missingKey: pool.missingKey }
}
