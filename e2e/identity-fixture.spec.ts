// JOR-273 — prove the shared fake Supabase service supports the real identity
// route and Auth metadata-update wire shapes that JOR-263 consumes. Product UI
// behavior belongs to e2e/verify.spec.ts; these checks stay at the fixture seam.
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PASSWORD = 'CorrectHorseBattery9'
let identityFixtureLockToken: string | undefined

async function fakeServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function resetIdentity(request: APIRequestContext): Promise<void> {
  const response = await request.post(`${await fakeServerUrl()}/__test__/reset-identity`)
  expect(response.ok()).toBe(true)
}

async function registerAndSignIn(request: APIRequestContext): Promise<void> {
  const email = `fixture-${randomUUID()}@example.com`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
}

test.describe('JOR-273 shared identity/profile fixture', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))

  test.beforeEach(async ({ request }) => {
    await resetIdentity(request)
    await registerAndSignIn(request)
  })

  test('real identity route reaches mismatch, lockout, and successful-link behavior', async ({ request }) => {
    const wrongReference = await request.post('/api/identity/verify', {
      data: { patientRef: 'PT-9999', dateOfBirth: '1988-03-14' },
      headers: { 'x-forwarded-for': '192.0.2.10' },
    })
    const wrongDateOfBirth = await request.post('/api/identity/verify', {
      data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-15' },
      headers: { 'x-forwarded-for': '192.0.2.10' },
    })
    const secondReferenceFailure = await request.post('/api/identity/verify', {
      data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-16' },
      headers: { 'x-forwarded-for': '192.0.2.10' },
    })
    const thirdReferenceFailure = await request.post('/api/identity/verify', {
      data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-17' },
      headers: { 'x-forwarded-for': '192.0.2.10' },
    })
    const lockedCorrectAttempt = await request.post('/api/identity/verify', {
      data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' },
      headers: { 'x-forwarded-for': '192.0.2.10' },
    })

    for (const response of [
      wrongReference,
      wrongDateOfBirth,
      secondReferenceFailure,
      thirdReferenceFailure,
      lockedCorrectAttempt,
    ]) {
      expect(response.status()).toBe(400)
      expect((await response.json()).error).toBe('identity_mismatch')
    }

    await resetIdentity(request)
    const success = await request.post('/api/identity/verify', {
      data: { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' },
      headers: { 'x-forwarded-for': '192.0.2.11' },
    })
    expect(success.status()).toBe(200)
    expect(await success.json()).toEqual({ patientRef: 'PT-4471', linkedAt: expect.any(String) })

    const state = (await (await request.get(`${await fakeServerUrl()}/__test__/identity-state`)).json()) as {
      patients: Array<{ patient_ref: string; user_id: string | null }>
      identityAttempts: Array<{ succeeded: boolean }>
    }
    expect(state.patients.find((patient) => patient.patient_ref === 'PT-4471')?.user_id).toEqual(expect.any(String))
    expect(state.identityAttempts).toContainEqual(expect.objectContaining({ succeeded: true }))
  })

  test('fake Auth updates and subsequently returns account metadata', async ({ request }) => {
    const token = (await request.storageState()).cookies.find((cookie) => cookie.name === 'pip_session')?.value
    expect(token).toEqual(expect.any(String))
    const authUrl = await fakeServerUrl()

    const update = await request.put(`${authUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { data: { full_name: 'Morgan Patient', phone: '+1 555 0100' } },
    })
    expect(update.status()).toBe(200)

    const readBack = await request.get(`${authUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    expect((await readBack.json()).user_metadata).toEqual({
      full_name: 'Morgan Patient',
      phone: '+1 555 0100',
    })
  })
})
