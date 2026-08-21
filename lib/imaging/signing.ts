// lib/imaging/signing.ts — the ONLY minter of signed Storage URLs (§2, ADR-0003)
import { config } from '../config'
import { serviceClient } from '../db/client'

export type SignedKey = { key: string; url: string | null; available: boolean; batchFailed?: true }

// The one private bucket (§9, db/storage/bucket.sql) — no second bucket, no
// public policy. bucket.sql deliberately leaves storage.objects with no
// select policy for anon/authenticated, so signing only works through the
// service-role client below; a policy-backed client would make the
// signature decorative.
const PHI_BUCKET = 'phi'

type BatchSignResult = { path: string | null; signedUrl: string | null; error: string | null }

// Storage keys are flat, opaque identifiers, never a path with segments
// (ADR-0003, CONTEXT.md). A key carrying a slash is either a traversal
// attempt ('../x'), an absolute path, or another bucket's name — it never
// reaches Storage, and comes back unavailable exactly like a genuine miss.
function isOpaqueKey(key: string): boolean {
  return key.length > 0 && !key.includes('/') && !key.includes('\\')
}

async function fetchSignedUrls(keys: string[]): Promise<{ results: Map<string, BatchSignResult>; batchFailed: boolean }> {
  const results = new Map<string, BatchSignResult>()
  if (keys.length === 0) return { results, batchFailed: false }

  const { data, error } = await serviceClient()
    .storage.from(PHI_BUCKET)
    .createSignedUrls(keys, config.signedUrlTtlSeconds)

  // A batch-level failure (network, auth) leaves every key unresolved and is
  // preserved separately from an individual missing object.
  if (error || !data) return { results, batchFailed: true }

  for (const item of data) {
    if (item.path !== null) results.set(item.path, item)
  }
  return { results, batchFailed: false }
}

/** TTL is config.signedUrlTtlSeconds (300). A key whose object is missing
 *  comes back { url: null, available: false } — never a throw. This is
 *  EC-2's source. */
export async function signStorageKeys(keys: string[]): Promise<SignedKey[]> {
  if (keys.length === 0) return []

  const safeKeys = keys.filter(isOpaqueKey)
  const { results, batchFailed } = await fetchSignedUrls(safeKeys)

  return keys.map((key) => {
    const result = results.get(key)
    if (result && !result.error && result.signedUrl) {
      return { key, url: result.signedUrl, available: true }
    }
    return batchFailed
      ? { key, url: null, available: false, batchFailed: true }
      : { key, url: null, available: false }
  })
}
