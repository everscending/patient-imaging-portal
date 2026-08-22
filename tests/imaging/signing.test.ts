// tests/imaging/signing.test.ts — lib/imaging/signing.ts's own tests (JOR-256).
//
// signStorageKeys's only production dependency is lib/db/client.ts's
// serviceClient(), which itself talks to Supabase's Storage REST layer.
// There is no live Storage server in this ticket's harness ("No live-app
// contact in this ticket" — T26 exercises signed delivery against the
// running app) — so, the same way tests/audit/events.test.ts stubs
// anonClient(), this file stubs serviceClient() with an in-memory fake
// bucket and asserts against that.
//
// Bullet → test function (this ticket's "Mandatory adversarial tests"):
//   a key for an object that does not exist, rejected as a throw
//     → missingObjectResolvesNullUnavailableInsteadOfThrowing
//   a batch in which the first key is missing, rejected if the remaining
//   keys come back unsigned or the call rejects
//     → firstKeyMissingStillSignsRemainingKeys
//   a returned array whose order differs from the input order, rejected
//     → outputOrderMatchesInputOrderRegardlessOfBackendResponseOrder
//   a hardcoded 300 or a caller-supplied TTL argument, rejected
//     → noHardcodedTtlLiteralAndNoSecondArgumentAccepted
//   a URL still valid past config.signedUrlTtlSeconds, rejected
//     → expiresInPassedToStorageIsConfigSignedUrlTtlSeconds
//   a key containing '../', an absolute path, or another bucket's name,
//   rejected: resolves available: false, reaches no object outside phi
//     → maliciousKeyNeverReachesStorageAndResolvesUnavailable
//   any signed-URL minting outside this module, rejected
//     → onlySigningModuleInTreeCallsCreateSignedUrls

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('server-only', () => ({}))

type FakeStorageObject = { signedUrl: string | null; error: string | null }

const { fakeBucket, fromMock, createSignedUrlsMock, serviceClientMock, resetFakeBucket, setResponseOrder } =
  vi.hoisted(() => {
    const objects = new Map<string, FakeStorageObject>()
    let responseOrder: 'input' | 'reversed' = 'input'

    const createSignedUrlsMock = vi.fn(async (paths: string[], expiresIn: number) => {
      const items = paths.map((requestedPath) => {
        const object = objects.get(requestedPath)
        if (!object) {
          return { path: requestedPath, signedUrl: null, error: 'Object not found', signedURL: null }
        }
        return {
          path: requestedPath,
          signedUrl: `${object.signedUrl}?expiresIn=${expiresIn}`,
          error: object.error,
          signedURL: null,
        }
      })
      const ordered = responseOrder === 'reversed' ? [...items].reverse() : items
      return { data: ordered, error: null }
    })

    const fromMock = vi.fn((bucket: string) => {
      if (bucket !== 'phi') throw new Error(`fake storage: unexpected bucket "${bucket}"`)
      return { createSignedUrls: createSignedUrlsMock }
    })

    const serviceClientMock = vi.fn(() => ({ storage: { from: fromMock } }))

    return {
      fakeBucket: objects,
      fromMock,
      createSignedUrlsMock,
      serviceClientMock,
      resetFakeBucket: () => {
        objects.clear()
        responseOrder = 'input'
      },
      setResponseOrder: (next: 'input' | 'reversed') => {
        responseOrder = next
      },
    }
  })

vi.mock('../../lib/db/client', () => ({
  serviceClient: serviceClientMock,
  anonClient: vi.fn(),
  authClient: vi.fn(),
}))

const REQUIRED_ENV = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://test-project.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
  SOURCE_REF_SALT: 'test-source-ref-salt',
}

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO_ROOT })
    .toString()
    .trim()
    .split('\n')
}

function putPresentObject(key: string): void {
  fakeBucket.set(key, { signedUrl: `https://signed.example/${key}`, error: null })
}

// Loads a fresh lib/imaging/signing.ts against REQUIRED_ENV plus overrides,
// so each test's TTL config is independent of any other test's env
// mutation — same pattern as tests/db/client.test.ts's loadClientModule.
async function loadSigningModule(overrides: Record<string, string> = {}) {
  const merged = { ...REQUIRED_ENV, ...overrides }
  for (const [key, value] of Object.entries(merged)) vi.stubEnv(key, value)
  vi.resetModules()
  return import('../../lib/imaging/signing')
}

beforeEach(() => {
  resetFakeBucket()
  serviceClientMock.mockClear()
  fromMock.mockClear()
  createSignedUrlsMock.mockClear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('AC: one SignedKey per input key, in input order, key echoed unchanged', () => {
  test('presentAndMissingKeysEachReturnTheirOwnEntry', async function presentAndMissingKeysEachReturnTheirOwnEntry() {
    putPresentObject('key-a')
    const { signStorageKeys } = await loadSigningModule()

    const result = await signStorageKeys(['key-a', 'key-missing'])

    expect(result).toEqual([
      { key: 'key-a', url: 'https://signed.example/key-a?expiresIn=300', available: true },
      { key: 'key-missing', url: null, available: false },
    ])
  })

  test('signsAgainstTheSinglePrivatePhiBucket', async function signsAgainstTheSinglePrivatePhiBucket() {
    putPresentObject('key-a')
    const { signStorageKeys } = await loadSigningModule()

    await signStorageKeys(['key-a'])

    expect(fromMock).toHaveBeenCalledWith('phi')
  })
})

describe('AC: a mixed batch keeps every key independent', () => {
  test('ninetyEightPresentAndTwoMissingReturnsOneHundredEntriesNinetyEightWithUrls', async function ninetyEightPresentAndTwoMissingReturnsOneHundredEntriesNinetyEightWithUrls() {
    const keys: string[] = []
    for (let i = 0; i < 100; i++) {
      const key = `frame-${i}`
      keys.push(key)
      if (i !== 12 && i !== 87) putPresentObject(key)
    }
    const { signStorageKeys } = await loadSigningModule()

    const result = await signStorageKeys(keys)

    expect(result).toHaveLength(100)
    const withUrls = result.filter((r) => r.available && r.url !== null)
    expect(withUrls).toHaveLength(98)
    expect(result[12]).toEqual({ key: 'frame-12', url: null, available: false })
    expect(result[87]).toEqual({ key: 'frame-87', url: null, available: false })
  })
})

describe('AC: an empty input array returns an empty array without contacting Storage', () => {
  test('emptyArrayResolvesEmptyAndNeverCallsServiceClient', async function emptyArrayResolvesEmptyAndNeverCallsServiceClient() {
    const { signStorageKeys } = await loadSigningModule()

    const result = await signStorageKeys([])

    expect(result).toEqual([])
    expect(serviceClientMock).not.toHaveBeenCalled()
  })
})

describe('AC: the TTL comes from config.signedUrlTtlSeconds, never a literal or a caller argument', () => {
  test('expiresInPassedToStorageIsConfigSignedUrlTtlSeconds', async function expiresInPassedToStorageIsConfigSignedUrlTtlSeconds() {
    putPresentObject('key-a')
    const { signStorageKeys } = await loadSigningModule({ SIGNED_URL_TTL_SECONDS: '111' })

    const result = await signStorageKeys(['key-a'])

    expect(createSignedUrlsMock).toHaveBeenCalledWith(['key-a'], 111)
    expect(result[0]?.url).toBe('https://signed.example/key-a?expiresIn=111')
  })

  test('noHardcodedTtlLiteralAndNoSecondArgumentAccepted', async function noHardcodedTtlLiteralAndNoSecondArgumentAccepted() {
    const source = readFileSync(path.join(REPO_ROOT, 'lib', 'imaging', 'signing.ts'), 'utf8')
    // The pinned interface's own doc comment (T21/T22/T66) mentions "(300)"
    // as documentation, which is not the code literal this guards against —
    // strip comments first so only executable code is checked for the digits.
    const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    expect(codeOnly).not.toMatch(/\b300\b/)
    expect(source).toContain('config.signedUrlTtlSeconds')

    const { signStorageKeys } = await loadSigningModule()
    // @ts-expect-error — signStorageKeys takes exactly one argument (`keys`);
    // this only compiles under ts-expect-error's blessing because tsc
    // --noEmit rejects a second, caller-supplied TTL argument.
    const withExtraArg = () => signStorageKeys(['key-a'], 60)
    expect(withExtraArg).toBeDefined()
  })
})

describe('mandatory adversarial: EL-1 derivative keys go through this same minter under the same contract', () => {
  // A thumbnail or poster key is a pool key like any other (JOR-243). It is
  // minted by this function, at this TTL, and comes back in the one SignedKey
  // shape — a derivative path with a shape of its own, or one that threw on a
  // derivative that was never uploaded, would break EC-2's source contract
  // for every caller that reads it.
  test('derivativeKeysReturnTheSameSignedKeyShapeAtTheSameTtl', async function derivativeKeysReturnTheSameSignedKeyShapeAtTheSameTtl() {
    putPresentObject('still-key')
    putPresentObject('thumb-key')
    putPresentObject('poster-key')
    const { signStorageKeys } = await loadSigningModule()

    const result = await signStorageKeys(['still-key', 'thumb-key', 'poster-key'])

    expect(createSignedUrlsMock).toHaveBeenCalledTimes(1)
    expect(createSignedUrlsMock).toHaveBeenCalledWith(['still-key', 'thumb-key', 'poster-key'], 300)
    for (const entry of result) {
      expect(Object.keys(entry).sort()).toEqual(['available', 'key', 'url'])
    }
    expect(result).toEqual([
      { key: 'still-key', url: 'https://signed.example/still-key?expiresIn=300', available: true },
      { key: 'thumb-key', url: 'https://signed.example/thumb-key?expiresIn=300', available: true },
      { key: 'poster-key', url: 'https://signed.example/poster-key?expiresIn=300', available: true },
    ])
  })

  test('aDerivativeThatWasNeverUploadedComesBackUnavailableNeverThrows', async function aDerivativeThatWasNeverUploadedComesBackUnavailableNeverThrows() {
    putPresentObject('still-key')
    const { signStorageKeys } = await loadSigningModule()

    // The source is present, its derivative is not — the case a stack seeded
    // before EL-1 and not yet re-provisioned is actually in.
    await expect(signStorageKeys(['still-key', 'thumb-not-uploaded'])).resolves.toEqual([
      { key: 'still-key', url: 'https://signed.example/still-key?expiresIn=300', available: true },
      { key: 'thumb-not-uploaded', url: null, available: false },
    ])
  })
})

describe('mandatory adversarial: a key for an object that does not exist never throws', () => {
  test('missingObjectResolvesNullUnavailableInsteadOfThrowing', async function missingObjectResolvesNullUnavailableInsteadOfThrowing() {
    const { signStorageKeys } = await loadSigningModule()

    await expect(signStorageKeys(['does-not-exist'])).resolves.toEqual([
      { key: 'does-not-exist', url: null, available: false },
    ])
  })
})

describe('mandatory adversarial: one missing key never affects the others in the same call', () => {
  test('firstKeyMissingStillSignsRemainingKeys', async function firstKeyMissingStillSignsRemainingKeys() {
    putPresentObject('key-b')
    putPresentObject('key-c')
    const { signStorageKeys } = await loadSigningModule()

    const result = await signStorageKeys(['key-missing', 'key-b', 'key-c'])

    expect(result[0]).toEqual({ key: 'key-missing', url: null, available: false })
    expect(result[1]).toEqual({ key: 'key-b', url: 'https://signed.example/key-b?expiresIn=300', available: true })
    expect(result[2]).toEqual({ key: 'key-c', url: 'https://signed.example/key-c?expiresIn=300', available: true })
  })
})

describe('mandatory adversarial: output order matches input order regardless of backend response order', () => {
  test('outputOrderMatchesInputOrderRegardlessOfBackendResponseOrder', async function outputOrderMatchesInputOrderRegardlessOfBackendResponseOrder() {
    putPresentObject('key-1')
    putPresentObject('key-2')
    putPresentObject('key-3')
    setResponseOrder('reversed')
    const { signStorageKeys } = await loadSigningModule()

    const result = await signStorageKeys(['key-1', 'key-2', 'key-3'])

    expect(result.map((r) => r.key)).toEqual(['key-1', 'key-2', 'key-3'])
    expect(result.every((r) => r.available)).toBe(true)
  })
})

describe('mandatory adversarial: a traversal, absolute-path, or cross-bucket key never reaches Storage', () => {
  test.each(['../secret-key', '/etc/passwd', 'other-bucket/key-a'])(
    'maliciousKeyNeverReachesStorageAndResolvesUnavailable: %s',
    async function maliciousKeyNeverReachesStorageAndResolvesUnavailable(maliciousKey) {
      putPresentObject('key-a')
      const { signStorageKeys } = await loadSigningModule()

      const result = await signStorageKeys([maliciousKey, 'key-a'])

      expect(result[0]).toEqual({ key: maliciousKey, url: null, available: false })
      expect(result[1]).toEqual({ key: 'key-a', url: 'https://signed.example/key-a?expiresIn=300', available: true })
      const [calledPaths] = createSignedUrlsMock.mock.calls[0] ?? [[]]
      expect(calledPaths).not.toContain(maliciousKey)
    },
  )

  test('everyKeyMaliciousNeverCallsCreateSignedUrls', async function everyKeyMaliciousNeverCallsCreateSignedUrls() {
    const { signStorageKeys } = await loadSigningModule()

    const result = await signStorageKeys(['../a', '/b'])

    expect(result).toEqual([
      { key: '../a', url: null, available: false },
      { key: '/b', url: null, available: false },
    ])
    expect(createSignedUrlsMock).not.toHaveBeenCalled()
  })
})

describe('mandatory adversarial: no signed-URL minting outside lib/imaging/signing.ts', () => {
  test('onlySigningModuleInTreeCallsCreateSignedUrls', function onlySigningModuleInTreeCallsCreateSignedUrls() {
    // Built at runtime, not spelled out literally, so this test file's own
    // source text — which legitimately names the method to assert against
    // it — never trips its own scan, the same trick
    // tests/lint/forbidden-imports.test.ts uses for the Supabase/Resend
    // package names.
    const method = ['createSigned', 'Urls'].join('')
    const hits = trackedFiles().filter((file) => {
      if (!file) return false
      if (file === 'tests/imaging/signing.test.ts') return false
      if (!(file.endsWith('.ts') || file.endsWith('.tsx'))) return false
      const content = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      return content.includes(`${method}(`)
    })
    expect(hits).toEqual(['lib/imaging/signing.ts'])
  })
})

describe('AC: the module imports its client from lib/db/client.ts and reads no raw environment variables directly', () => {
  test('sourceImportsServiceClientAndNeverReadsRawEnv', function sourceImportsServiceClientAndNeverReadsRawEnv() {
    const source = readFileSync(path.join(REPO_ROOT, 'lib', 'imaging', 'signing.ts'), 'utf8')
    const rawEnvAccess = 'process' + '.env'
    expect(source).not.toContain(rawEnvAccess)
    expect(source).toMatch(/from ['"]\.\.\/db\/client['"]/)
    expect(source).toContain('serviceClient')
  })
})
