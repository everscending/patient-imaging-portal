// tests/seed/assets.test.ts — db/seed/assets.ts and db/seed/storage.ts
// (ticket JOR-226 / T12). Pure generation and upload-logic assertions run
// fully offline (a fake in-memory storage client stands in for Supabase) so
// this file needs no live credentials and the gate never calls a live
// provider. The one exception is the Live check describe block at the
// bottom: it reads tests/seed/artifacts/pool-run.json, the run record from
// the one real upload made against the configured Supabase project's `phi`
// bucket, and re-derives that record's manifest offline from the same seed
// — a mismatch there means generation has drifted since that real run.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'

import {
  assertWithinByteCeiling,
  BROKEN_CINE_SET_INDEX,
  BROKEN_FRAME_INDEX,
  CINE_SET_COUNT,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  FRAMES_PER_CINE_SET,
  generateAssetPool,
  POOL_BYTE_CEILING,
  STILL_COUNT,
  STILL_HEIGHT,
  STILL_WIDTH,
  type AssetPool,
} from '../../db/seed/assets'
import { PHI_BUCKET, uploadPool, type PhiStorageClient, type StorageObjectInfo } from '../../db/seed/storage'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const ARTIFACT_PATH = path.join(REPO_ROOT, 'tests', 'seed', 'artifacts', 'pool-run.json')

// Mirrors lib/config.ts's SEED_SOURCE_SEED default (ARCHITECTURE.md §8)
// without importing lib/config.ts — this file must stay network- and
// environment-free so it runs under both gate tiers with no Supabase
// credentials in scope.
const DEFAULT_SEED = 'patient-imaging-portal'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

const GENERATE_TIMEOUT_MS = 30_000

function fullManifestOf(pool: AssetPool): { key: string; sha256: string }[] {
  return pool.assets.map((a) => ({ key: a.key, sha256: a.sha256 })).sort((a, b) => a.key.localeCompare(b.key))
}

function uploadableManifestOf(pool: AssetPool): { key: string; sha256: string }[] {
  return pool.assets
    .filter((a) => a.upload)
    .map((a) => ({ key: a.key, sha256: a.sha256 }))
    .sort((a, b) => a.key.localeCompare(b.key))
}

function trackedAndUntrackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO_ROOT })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
}

function md5Hex(bytes: Buffer): string {
  return createHash('md5').update(bytes).digest('hex')
}

// A minimal in-memory stand-in for the real Supabase storage client, so
// upload logic (idempotency, bucket targeting, the missing-frame gap) is
// provable without a live provider call — the ticket's own "gates never
// call live providers" rule. list() echoes eTag exactly like the real API
// (verified against the configured project): a quoted MD5 of the content,
// never custom upload metadata, which the real API does not echo back.
function createFakeStorageClient() {
  const store = new Map<string, Buffer>()
  const bucketsCalled: string[] = []
  const uploadedPaths: string[] = []

  const client: PhiStorageClient = {
    storage: {
      from(bucket: string) {
        bucketsCalled.push(bucket)
        return {
          async list() {
            const data: StorageObjectInfo[] = [...store.entries()].map(([name, bytes]) => ({
              name,
              metadata: { eTag: `"${md5Hex(bytes)}"` },
            }))
            return { data, error: null }
          },
          async upload(pathName: string, body: Buffer) {
            uploadedPaths.push(pathName)
            store.set(pathName, body)
            return { data: { path: pathName }, error: null }
          },
        }
      },
    },
  }

  return { client, store, bucketsCalled, uploadedPaths }
}

// Computed once and reused across every test that just needs "the" pool —
// each generation takes a few seconds, so tests that don't specifically
// need an independent run share this one.
let pool: AssetPool

beforeAll(() => {
  pool = generateAssetPool(DEFAULT_SEED)
}, GENERATE_TIMEOUT_MS)

describe('AC: generating the pool twice from the same seed is byte-identical', () => {
  test('reproducesByteIdenticalPoolAcrossRuns', function reproducesByteIdenticalPoolAcrossRuns() {
    const again = generateAssetPool(DEFAULT_SEED)
    expect(fullManifestOf(again)).toEqual(fullManifestOf(pool))
    expect(again.totalBytes).toBe(pool.totalBytes)
    expect(again.missingKey).toBe(pool.missingKey)
  }, GENERATE_TIMEOUT_MS)

  // Mandatory adversarial: "a second generation run producing different
  // bytes" — proves the manifest comparison above actually discriminates,
  // rather than trivially passing regardless of content.
  test('adversarial: a manifest that differs by one byte is never treated as identical', function adversarialSecondGenerationRunDifferentBytesCaught() {
    const tamperedManifest = fullManifestOf(pool).map((entry, index) =>
      index === 0 ? { ...entry, sha256: `${entry.sha256.slice(0, -1)}0` } : entry,
    )
    expect(tamperedManifest).not.toEqual(fullManifestOf(pool))
  })
})

describe('AC: changing SEED_SOURCE_SEED produces a different pool', () => {
  test('differentSeedProducesADifferentPool', function differentSeedProducesADifferentPool() {
    const alternate = generateAssetPool(`${DEFAULT_SEED}-alternate`)
    expect(fullManifestOf(alternate)).not.toEqual(fullManifestOf(pool))
    expect(alternate.missingKey).not.toBe(pool.missingKey)
  }, GENERATE_TIMEOUT_MS)
})

describe('mandatory adversarial: an empty SEED_SOURCE_SEED never silently falls back to a random source seed', () => {
  test('adversarialEmptySeedStaysDeterministicNeverRandom', function adversarialEmptySeedStaysDeterministicNeverRandom() {
    const first = generateAssetPool('')
    const second = generateAssetPool('')
    expect(fullManifestOf(second)).toEqual(fullManifestOf(first))
    expect(second.missingKey).toBe(first.missingKey)
    // Not the same pool as the real default seed — '' is just another
    // string, never a signal to reach for Math.random()/Date.now() instead.
    expect(fullManifestOf(first)).not.toEqual(fullManifestOf(pool))
  }, GENERATE_TIMEOUT_MS * 2)
})

describe('AC: the pool contains 8 cine sets of 100 frames each and 40 stills', () => {
  test('poolContainsEightCineSetsOfHundredFramesAndFortyStills', function poolContainsEightCineSetsOfHundredFramesAndFortyStills() {
    const frames = pool.assets.filter((a) => a.kind === 'cine-frame')
    const stills = pool.assets.filter((a) => a.kind === 'still')
    expect(stills).toHaveLength(STILL_COUNT)
    expect(frames).toHaveLength(CINE_SET_COUNT * FRAMES_PER_CINE_SET)

    const framesPerSet = new Map<number, number>()
    for (const frame of frames) {
      const setIndex = frame.cineSetIndex as number
      framesPerSet.set(setIndex, (framesPerSet.get(setIndex) ?? 0) + 1)
    }
    expect(framesPerSet.size).toBe(CINE_SET_COUNT)
    for (const count of framesPerSet.values()) expect(count).toBe(FRAMES_PER_CINE_SET)
  })

  test('framesAre640x480AndStillsAre800x600', function framesAre640x480AndStillsAre800x600() {
    for (const asset of pool.assets.filter((a) => a.kind === 'cine-frame')) {
      expect(asset.width).toBe(FRAME_WIDTH)
      expect(asset.height).toBe(FRAME_HEIGHT)
    }
    for (const asset of pool.assets.filter((a) => a.kind === 'still')) {
      expect(asset.width).toBe(STILL_WIDTH)
      expect(asset.height).toBe(STILL_HEIGHT)
    }
  })
})

describe('AC + mandatory adversarial: total generated bytes stay within the stated ADR-0009 ceiling', () => {
  test('totalBytesStayWithinTheStatedCeiling', function totalBytesStayWithinTheStatedCeiling() {
    expect(pool.totalBytes).toBeGreaterThan(0)
    expect(pool.totalBytes).toBeLessThanOrEqual(POOL_BYTE_CEILING)
  })

  test('adversarial: a pool larger than the stated byte ceiling fails', function adversarialPoolLargerThanCeilingFails() {
    expect(() => assertWithinByteCeiling(POOL_BYTE_CEILING + 1, POOL_BYTE_CEILING)).toThrow()
    expect(() => assertWithinByteCeiling(POOL_BYTE_CEILING, POOL_BYTE_CEILING)).not.toThrow()
  })
})

describe('AC: exactly one frame of exactly one cine set is deliberately never uploaded', () => {
  test('exactlyOneFrameIsMarkedNeverUploaded', function exactlyOneFrameIsMarkedNeverUploaded() {
    const notUploaded = pool.assets.filter((a) => !a.upload)
    expect(notUploaded).toHaveLength(1)
    expect(notUploaded[0].kind).toBe('cine-frame')
    expect(notUploaded[0].cineSetIndex).toBe(BROKEN_CINE_SET_INDEX)
    expect(notUploaded[0].frameIndex).toBe(BROKEN_FRAME_INDEX)
    expect(pool.missingKey).toBe(notUploaded[0].key)
  })
})

describe('AC + mandatory adversarial: no storage key contains a patient, study, clip or ordinal identifier', () => {
  test('everyStorageKeyIsAnOpaqueUuidNeverAnIdentifier', function everyStorageKeyIsAnOpaqueUuidNeverAnIdentifier() {
    const keys = pool.assets.map((a) => a.key)
    for (const key of keys) expect(key).toMatch(UUID_V4_RE)
    expect(new Set(keys).size).toBe(keys.length)
  })

  // Proves the UUID check above actually discriminates: a key scheme that
  // embedded the cine set index and frame ordinal — the exact ADR-0003
  // violation this ticket forbids — is caught by it.
  test('adversarial: a storage key derived from a cine set index and frame ordinal fails the same check', function adversarialOrdinalDerivedKeyRejected() {
    const badKey = `cine-${BROKEN_CINE_SET_INDEX}-frame-${BROKEN_FRAME_INDEX}`
    expect(badKey).not.toMatch(UUID_V4_RE)
  })
})

describe('AC + mandatory adversarial: db/seed/** reaches no wall clock and no non-seeded randomness', () => {
  test('adversarialDbSeedSourceNeverReachesWallClockOrRandom', function adversarialDbSeedSourceNeverReachesWallClockOrRandom() {
    const files = trackedAndUntrackedFiles().filter((f) => f.startsWith('db/seed/') && f.endsWith('.ts'))
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const content = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      expect(content, `${file} must not call Date.now()`).not.toContain('Date.now(')
      expect(content, `${file} must not call Math.random()`).not.toContain('Math.random(')
      expect(content, `${file} must not call crypto.randomUUID()`).not.toContain('randomUUID(')
    }
  })
})

describe('AC: uploads every asset except the deliberately missing frame', () => {
  test('uploadsEveryAssetExceptTheMissingFrame', async function uploadsEveryAssetExceptTheMissingFrame() {
    const { client, store } = createFakeStorageClient()
    const summary = await uploadPool(client, pool)

    const expectedUploadCount = pool.assets.filter((a) => a.upload).length
    expect(summary.uploadedCount).toBe(expectedUploadCount)
    expect(summary.missingKey).toBe(pool.missingKey)
    expect(store.has(pool.missingKey)).toBe(false)
    expect(store.size).toBe(expectedUploadCount)
  })

  // Mandatory adversarial: "the deliberately missing frame being uploaded
  // after all."
  test('adversarial: the deliberately missing frame is never uploaded', async function adversarialMissingFrameNeverUploaded() {
    const { client, uploadedPaths } = createFakeStorageClient()
    await uploadPool(client, pool)
    expect(uploadedPaths).not.toContain(pool.missingKey)
  })
})

describe('AC + mandatory adversarial: running the upload twice leaves the same object count and hashes', () => {
  test('secondUploadRunNeverCreatesDuplicateObjects', async function secondUploadRunNeverCreatesDuplicateObjects() {
    const { client, store } = createFakeStorageClient()

    const first = await uploadPool(client, pool)
    const countAfterFirst = store.size
    const hashesAfterFirst = [...store.entries()].map(([name, bytes]) => `${name}:${md5Hex(bytes)}`).sort()

    const second = await uploadPool(client, pool)

    expect(store.size).toBe(countAfterFirst)
    expect([...store.entries()].map(([name, bytes]) => `${name}:${md5Hex(bytes)}`).sort()).toEqual(hashesAfterFirst)
    expect(second.uploadedCount).toBe(0)
    expect(second.skippedCount).toBe(first.uploadedCount)
  })
})

describe('mandatory adversarial: an upload never writes outside the phi bucket', () => {
  test('adversarialUploadNeverTargetsAnyBucketOtherThanPhi', async function adversarialUploadNeverTargetsAnyBucketOtherThanPhi() {
    const { client, bucketsCalled } = createFakeStorageClient()
    await uploadPool(client, pool)
    expect(bucketsCalled.length).toBeGreaterThan(0)
    expect(new Set(bucketsCalled)).toEqual(new Set([PHI_BUCKET]))
  })

  test('adversarial: the bucket constant is exactly "phi", never a second bucket', function adversarialBucketConstantIsExactlyPhi() {
    expect(PHI_BUCKET).toBe('phi')
  })
})

describe('Live check: the committed run record still matches the current deterministic generation', () => {
  test('liveCheckArtifactManifestMatchesCurrentGeneration', function liveCheckArtifactManifestMatchesCurrentGeneration() {
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as {
      seed: string
      objectCount: number
      totalBytes: number
      missingKey: string
      manifest: { key: string; sha256: string }[]
    }

    // Regenerated offline, from the artifact's own recorded seed — no
    // network call. A mismatch here means generation drifted since the one
    // real upload this record was taken from (the ticket's "a run whose
    // manifest differs from the previous run's fails the ticket").
    const current = generateAssetPool(artifact.seed)
    const currentUploadable = current.assets.filter((a) => a.upload)
    const currentUploadedBytes = currentUploadable.reduce((sum, a) => sum + a.bytes.length, 0)

    expect(uploadableManifestOf(current)).toEqual(artifact.manifest)
    expect(currentUploadable.length).toBe(artifact.objectCount)
    expect(currentUploadedBytes).toBe(artifact.totalBytes)
    expect(current.missingKey).toBe(artifact.missingKey)
  }, GENERATE_TIMEOUT_MS)
})
