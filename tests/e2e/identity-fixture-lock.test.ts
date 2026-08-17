import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  acquireIdentityFixtureLock,
  releaseIdentityFixtureLock,
} from '../../e2e/fixtures/identity-fixture-lock'

describe('shared identity fixture lock ownership', () => {
  test('the availability suite leases the shared audit-event fixture', async () => {
    const availabilitySuite = await readFile(
      path.join(process.cwd(), 'e2e/availability.spec.ts'),
      'utf8',
    )

    expect(availabilitySuite).toContain('acquireIdentityFixtureLock()')
    expect(availabilitySuite).toContain('releaseIdentityFixtureLock(identityFixtureLockToken)')
    expect(availabilitySuite).not.toContain('availability-fixture.lock')
  })

  test('a timed-out suite cannot release the active suite lease', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pip-identity-lock-'))
    const lockPath = path.join(root, 'lock')
    let ownerToken: string | undefined
    let timedOutToken: string | undefined
    try {
      ownerToken = await acquireIdentityFixtureLock({ lockPath, timeoutMs: 50, pollMs: 1 })
      await expect(
        acquireIdentityFixtureLock({ lockPath, timeoutMs: 5, pollMs: 1 }).then((token) => {
          timedOutToken = token
        }),
      ).rejects.toThrow('identity fixture lock timed out')

      // Playwright still runs afterAll when beforeAll times out. Cleanup by
      // that non-owner must not remove the lease held by the active suite.
      await releaseIdentityFixtureLock(timedOutToken, { lockPath })
      await expect(
        acquireIdentityFixtureLock({ lockPath, timeoutMs: 5, pollMs: 1 }),
      ).rejects.toThrow('identity fixture lock timed out')

      await releaseIdentityFixtureLock(ownerToken, { lockPath })
      ownerToken = undefined
      const successorToken = await acquireIdentityFixtureLock({ lockPath, timeoutMs: 50, pollMs: 1 })
      await releaseIdentityFixtureLock(successorToken, { lockPath })
    } finally {
      await releaseIdentityFixtureLock(ownerToken, { lockPath })
      await rm(root, { recursive: true, force: true })
    }
  })

  test.each(['share-create.spec.ts', 'cine-viewer.spec.ts'])(
    '%s leases the canonical identity fixture for its serial live checks',
    async (suite) => {
      const source = await readFile(path.join(process.cwd(), 'e2e', suite), 'utf8')

      expect(source).toContain('acquireIdentityFixtureLock()')
      expect(source).toContain('releaseIdentityFixtureLock(identityFixtureLockToken)')
      expect(source).toContain('IDENTITY_FIXTURE_HOOK_TIMEOUT_MS')
      expect(source).not.toContain("path.join(REPO_ROOT, '.local', 'identity-fixture.lock')")
    },
  )
})
