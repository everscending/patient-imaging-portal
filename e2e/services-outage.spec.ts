// JOR-305 — the real route and configured local database boundary, with no
// response interception or live Supabase project.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { expect, test, type APIRequestContext } from '@playwright/test'

async function fakeServerUrl(): Promise<string> {
  const raw = await readFile(path.resolve('.local/fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function setDatabase(request: APIRequestContext, database: 'ok' | 'down'): Promise<void> {
  const response = await request.post(`${await fakeServerUrl()}/__test__/health-state`, {
    data: { database, storage: 'ok' },
  })
  expect(response.status()).toBe(200)
}

test('database outage returns a degraded services envelope instead of 500', async ({ request }) => {
  const email = `jor-305-${randomUUID()}@example.com`
  expect((await request.post('/api/auth/register', {
    data: { email, password: 'CorrectHorseBattery9' },
  })).status()).toBe(201)
  expect((await request.post('/api/auth/login', {
    data: { email, password: 'CorrectHorseBattery9' },
  })).status()).toBe(200)

  try {
    await setDatabase(request, 'down')
    const response = await request.get('/api/services')
    expect(response.status()).toBe(503)
    expect(response.headers()['content-type']).toContain('application/json')
    expect(await response.json()).toEqual({
      error: 'services_unavailable',
      message: 'Services are temporarily unavailable.',
    })
  } finally {
    await setDatabase(request, 'ok')
  }
})
