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
  computeAssetPool,
  FRAME_HEIGHT,
  FRAME_WIDTH,
  FRAMES_PER_CINE_SET,
  generateAssetPool,
  POOL_BYTE_CEILING,
  POSTER_HEIGHT,
  POSTER_WIDTH,
  STILL_COUNT,
  STILL_HEIGHT,
  STILL_WIDTH,
  THUMB_HEIGHT,
  THUMB_WIDTH,
  type AssetPool,
} from '../../db/seed/assets'
import { buildRowSet } from '../../db/seed/rows'
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

function derivativeManifestOf(pool: AssetPool): { key: string; sha256: string }[] {
  return pool.assets
    .filter((a) => a.kind === 'still-thumb' || a.kind === 'cine-poster')
    .map((a) => ({ key: a.key, sha256: a.sha256 }))
    .sort((a, b) => a.key.localeCompare(b.key))
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
  // Two genuine computations: beforeAll's generateAssetPool call performed
  // the first real computation (and cached it — JOR-320); this test performs
  // ONE more via the uncached computeAssetPool and compares. Running two
  // computeAssetPool calls back to back inside this test doubled the block
  // to ~63 s of contiguous synchronous work on the hosted runner, tripping
  // both the 60 s test timeout and birpc's worker-RPC deadline — one fresh
  // computation proves the same property at half the block.
  test('reproducesByteIdenticalPoolAcrossRuns', async function reproducesByteIdenticalPoolAcrossRuns() {
    // One genuine timer yield between beforeAll's ~30 s computation and this
    // one: without it the two stack into a single >60 s contiguous block on
    // the hosted runner and starve the vitest worker's RPC channel (birpc's
    // fixed deadline) even though every test passes. Microtask boundaries
    // between tests do not reach the timer phase; this does.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const again = computeAssetPool(DEFAULT_SEED)
    expect(again).not.toBe(pool)
    expect(fullManifestOf(again)).toEqual(fullManifestOf(pool))
    expect(again.totalBytes).toBe(pool.totalBytes)
    expect(again.missingKey).toBe(pool.missingKey)
  }, GENERATE_TIMEOUT_MS * 3)

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
  test('differentSeedProducesADifferentPool', async function differentSeedProducesADifferentPool() {
    // Same timer-yield rationale as reproducesByteIdenticalPoolAcrossRuns:
    // this is the file's third full pool computation, and without a real
    // yield it stacks onto the previous one into a >60 s hosted block.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const alternate = generateAssetPool(`${DEFAULT_SEED}-alternate`)
    expect(fullManifestOf(alternate)).not.toEqual(fullManifestOf(pool))
    expect(alternate.missingKey).not.toBe(pool.missingKey)
  }, GENERATE_TIMEOUT_MS * 3)
})

describe('JOR-320: generateAssetPool is memoized per source seed', () => {
  test('sameSeedReturnsTheSameCachedPoolObject', function sameSeedReturnsTheSameCachedPoolObject() {
    const again = generateAssetPool(DEFAULT_SEED)
    // Reference identity, not just equal content — this is what proves the
    // second call was a cache hit rather than a second computation.
    expect(again).toBe(pool)
  })

  test('differentSeedReturnsADistinctPoolObject', function differentSeedReturnsADistinctPoolObject() {
    const alternate = generateAssetPool(`${DEFAULT_SEED}-jor-320-distinct`)
    expect(alternate).not.toBe(pool)
  }, GENERATE_TIMEOUT_MS)

  // Mutation canary: every caller sharing the same seed now gets the exact
  // same pool object back, so a future caller that writes to it would
  // poison every other caller of that seed, not just itself. Deep-freezing
  // the pool before handing it to the two real consumers pins today's
  // "read-only" behavior — a regression here throws in this test instead of
  // silently corrupting a later run's data.
  test('adversarial: neither buildRowSet nor uploadPool writes to the pool they are given', async function adversarialNeitherConsumerWritesToTheSharedPool() {
    const seed = `${DEFAULT_SEED}-jor-320-freeze-canary`
    const frozen = generateAssetPool(seed)
    // Object.freeze on the asset objects (and the array/pool holding them)
    // catches any attempt to reassign a field like `key` or `upload`. A
    // Buffer can't itself be frozen (Node refuses to freeze a typed array
    // with elements), so the byte-content snapshot below stands in for
    // catching an in-place write to `asset.bytes`.
    for (const asset of frozen.assets) Object.freeze(asset)
    Object.freeze(frozen.assets)
    Object.freeze(frozen)
    const bytesBefore = frozen.assets.map((asset) => Buffer.from(asset.bytes))

    const rowSet = buildRowSet({
      pool: frozen,
      sourceSeed: seed,
      now: new Date('2026-01-01T00:00:00.000Z'),
      minChangeNoticeHours: 24,
    })
    expect(rowSet.patients.length).toBeGreaterThan(0)

    const { client } = createFakeStorageClient()
    await expect(uploadPool(client, frozen)).resolves.toBeDefined()

    frozen.assets.forEach((asset, index) => {
      expect(Buffer.compare(asset.bytes, bytesBefore[index])).toBe(0)
    })
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

describe('EL-1 AC: one thumbnail per still and one poster per cine set, each materially smaller than its source', () => {
  test('everyStillHasAThumbnailAndEveryCineSetHasAPoster', function everyStillHasAThumbnailAndEveryCineSetHasAPoster() {
    const thumbs = pool.assets.filter((a) => a.kind === 'still-thumb')
    const posters = pool.assets.filter((a) => a.kind === 'cine-poster')

    expect(thumbs).toHaveLength(STILL_COUNT)
    expect(posters).toHaveLength(CINE_SET_COUNT)
    expect(new Set(thumbs.map((a) => a.stillIndex))).toEqual(new Set(pool.assets.filter((a) => a.kind === 'still').map((a) => a.stillIndex)))
    expect(new Set(posters.map((a) => a.cineSetIndex))).toEqual(new Set(Array.from({ length: CINE_SET_COUNT }, (_, index) => index)))

    for (const thumb of thumbs) {
      expect(thumb.width).toBe(THUMB_WIDTH)
      expect(thumb.height).toBe(THUMB_HEIGHT)
      expect(thumb.upload).toBe(true)
    }
    for (const poster of posters) {
      expect(poster.width).toBe(POSTER_WIDTH)
      expect(poster.height).toBe(POSTER_HEIGHT)
      expect(poster.upload).toBe(true)
    }
  })

  // The point of a thumbnail-first render is that the first fetch is small.
  // A derivative that is not much smaller than its source buys nothing, so
  // the size relationship is asserted rather than assumed.
  test('everyDerivativeIsAtMostAQuarterOfItsSourceSize', function everyDerivativeIsAtMostAQuarterOfItsSourceSize() {
    const largestStill = Math.max(...pool.assets.filter((a) => a.kind === 'still').map((a) => a.bytes.length))
    const largestFrame = Math.max(...pool.assets.filter((a) => a.kind === 'cine-frame').map((a) => a.bytes.length))

    for (const thumb of pool.assets.filter((a) => a.kind === 'still-thumb')) {
      expect(thumb.bytes.length).toBeLessThan(largestStill / 4)
    }
    for (const poster of pool.assets.filter((a) => a.kind === 'cine-poster')) {
      expect(poster.bytes.length).toBeLessThan(largestFrame / 4)
    }
  })
})

describe('mandatory adversarial: the derivative generator is deterministic, never a fresh random field per run', () => {
  test('adversarialDerivativeGeneratorReproducesByteIdenticalDerivativesAcrossRuns', function adversarialDerivativeGeneratorReproducesByteIdenticalDerivativesAcrossRuns() {
    const first = derivativeManifestOf(pool)
    const second = derivativeManifestOf(generateAssetPool(DEFAULT_SEED))

    expect(second).toEqual(first)
    expect(first).toHaveLength(STILL_COUNT + CINE_SET_COUNT)
    // Each derivative reduces a different source, so no two may collide —
    // a generator that emitted one shared placeholder would pass a
    // determinism check on its own.
    expect(new Set(first.map((entry) => entry.sha256)).size).toBe(first.length)
    expect(new Set(first.map((entry) => entry.key)).size).toBe(first.length)
  }, GENERATE_TIMEOUT_MS * 2)

  // Proves the comparison above discriminates: one byte of derivative drift
  // — what a Math.random or wall-clock source would produce on every run —
  // is caught, so the passing case above is evidence and not a tautology.
  test('adversarial: a derivative manifest that differs by one byte is never treated as identical', function adversarialDerivativeDriftCaught() {
    const first = derivativeManifestOf(pool)
    const drifted = first.map((entry, index) =>
      index === 0 ? { ...entry, sha256: `${entry.sha256.slice(0, -1)}0` } : entry,
    )
    expect(drifted).not.toEqual(first)
  })

  test('adversarial: a different seed produces different derivatives too', function adversarialDifferentSeedProducesDifferentDerivatives() {
    const other = derivativeManifestOf(generateAssetPool(`${DEFAULT_SEED}-other`))
    expect(other.map((entry) => entry.sha256)).not.toEqual(derivativeManifestOf(pool).map((entry) => entry.sha256))
  }, GENERATE_TIMEOUT_MS * 2)
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
      derivativesPendingUpload: { objectCount: number; totalBytes: number; manifest: { key: string; sha256: string }[] }
    }

    // Regenerated offline, from the artifact's own recorded seed — no
    // network call. A mismatch here means generation drifted since the one
    // real upload this record was taken from (the ticket's "a run whose
    // manifest differs from the previous run's fails the ticket").
    //
    // `manifest` stays exactly what that real run uploaded. EL-1's
    // derivatives (JOR-243) were generated after it, so they are recorded
    // separately as pending until the deployed stack is re-provisioned —
    // keeping this record an honest account of what is actually in the
    // bucket, while still pinning every derivative byte against drift.
    const current = generateAssetPool(artifact.seed)
    const currentUploadable = current.assets.filter((a) => a.upload)
    const currentUploadedBytes = currentUploadable.reduce((sum, a) => sum + a.bytes.length, 0)
    const pending = artifact.derivativesPendingUpload
    const expectedManifest = [...artifact.manifest, ...pending.manifest].sort((a, b) => a.key.localeCompare(b.key))

    expect(uploadableManifestOf(current)).toEqual(expectedManifest)
    expect(currentUploadable.length).toBe(artifact.objectCount + pending.objectCount)
    expect(currentUploadedBytes).toBe(artifact.totalBytes + pending.totalBytes)
    expect(current.missingKey).toBe(artifact.missingKey)
  }, GENERATE_TIMEOUT_MS)

  // The derivatives are additive: every key the real run uploaded still
  // generates the same bytes, so re-provisioning uploads 48 new objects and
  // rewrites none of the 839 already there.
  test('el1DerivativesAddObjectsWithoutRewritingAnyPreviouslyUploadedOne', function el1DerivativesAddObjectsWithoutRewritingAnyPreviouslyUploadedOne() {
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as {
      seed: string
      manifest: { key: string; sha256: string }[]
      derivativesPendingUpload: { manifest: { key: string; sha256: string }[] }
    }
    const current = new Map(uploadableManifestOf(pool).map((entry) => [entry.key, entry.sha256]))
    expect(artifact.seed).toBe(DEFAULT_SEED)
    for (const entry of artifact.manifest) expect(current.get(entry.key)).toBe(entry.sha256)

    const recorded = new Set(artifact.manifest.map((entry) => entry.key))
    for (const entry of artifact.derivativesPendingUpload.manifest) {
      expect(recorded.has(entry.key)).toBe(false)
      expect(current.get(entry.key)).toBe(entry.sha256)
    }
  })
})
