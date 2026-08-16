// e2e/degraded.spec.ts — JOR-247's live check. Runs against the real app on
// PORT (4310, playwright.config.ts's webServer). The database and Storage
// probes in app/api/health/route.ts both resolve through the app's single
// NEXT_PUBLIC_SUPABASE_URL, which start-test-server.mjs already points at
// e2e/fixtures/fake-auth-server.ts for the whole suite — so that fixture's
// GET /rest/v1/ and GET /storage/v1/bucket/phi handlers stand in for the two
// dependencies, and its POST /__test__/health-state toggles each
// independently between 'ok' (answers immediately), 'down' (the connection
// is refused) and 'hang' (never answers, forcing the probe's own timeout).
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from '@playwright/test'
import type { APIRequestContext } from '@playwright/test'
import DependencyError from '../components/system/DependencyError'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()

type DependencyState = 'ok' | 'down' | 'hang'
type HealthBody = { app: unknown; database: unknown; storage: unknown }

async function fakeAuthServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function setHealthState(
  request: APIRequestContext,
  state: { database?: DependencyState; storage?: DependencyState },
): Promise<void> {
  const authUrl = await fakeAuthServerUrl()
  const response = await request.post(`${authUrl}/__test__/health-state`, { data: state })
  expect(response.status()).toBe(200)
}

test.describe('GET /api/health — acceptance: the pinned §6 shape, always 200', () => {
  test.afterEach(async ({ request }) => {
    await setHealthState(request, { database: 'ok', storage: 'ok' })
  })

  test('acceptance: health_allReachable_returns200WithExactlyThreeOkKeys', async ({ request }) => {
    await setHealthState(request, { database: 'ok', storage: 'ok' })
    const response = await request.get('/api/health')
    expect(response.status()).toBe(200)
    const body = (await response.json()) as HealthBody
    expect(body).toEqual({ app: 'ok', database: 'ok', storage: 'ok' })
  })

  test('acceptance: health_databaseUnreachable_returns200WithDatabaseDownAndAppOk', async ({ request }) => {
    await setHealthState(request, { database: 'down', storage: 'ok' })
    const response = await request.get('/api/health')
    expect(response.status()).toBe(200)
    const body = (await response.json()) as HealthBody
    expect(body).toEqual({ app: 'ok', database: 'down', storage: 'ok' })
  })

  test('acceptance: health_storageUnreachable_returns200WithStorageDown', async ({ request }) => {
    await setHealthState(request, { database: 'ok', storage: 'down' })
    const response = await request.get('/api/health')
    expect(response.status()).toBe(200)
    const body = (await response.json()) as HealthBody
    expect(body).toEqual({ app: 'ok', database: 'ok', storage: 'down' })
  })

  test('acceptance: health_noSessionNoCookies_returns200', async ({ baseURL, playwright }) => {
    // A fresh request context: no login has ever happened on it, so there is
    // no session cookie and no linked account (PF-9's uptime check carries
    // neither).
    const anonymous = await playwright.request.newContext({ baseURL })
    try {
      const response = await anonymous.get('/api/health')
      expect(response.status()).toBe(200)
    } finally {
      await anonymous.dispose()
    }
  })

  test('acceptance (static): health_neverCallsGuardOrWritesAuditEvents', async () => {
    const source = await readFile(path.join(REPO_ROOT, 'app/api/health/route.ts'), 'utf8')
    expect(source).not.toMatch(/guardPhiAccess/)
    expect(source).not.toMatch(/audit_events/)
    expect(source).not.toMatch(/cookies\(/)
    expect(source).not.toMatch(/getSessionToken/)
  })

  test('acceptance (static): health_dependencyDownWritesOneStructuredLogLineNamingDependencyAndOutcomeNoPHI', async () => {
    const source = await readFile(path.join(REPO_ROOT, 'app/api/health/route.ts'), 'utf8')
    // One console.error call per down dependency, each a JSON object naming
    // only the dependency and the outcome — never the caught error, so the
    // line can never carry a connection string, a host name or PHI.
    const logCalls = source.match(/console\.error\(JSON\.stringify\(\{[^}]*\}\)\)/g) ?? []
    expect(logCalls.length).toBe(1)
    expect(logCalls[0]).toMatch(/dependency/)
    expect(logCalls[0]).toMatch(/outcome:\s*'down'/)
    expect(source).toMatch(/if \(database === 'down'\) logDependencyDown\('database'\)/)
    expect(source).toMatch(/if \(storage === 'down'\) logDependencyDown\('storage'\)/)
  })
})

test.describe('GET /api/health — mandatory adversarial tests', () => {
  test.afterEach(async ({ request }) => {
    await setHealthState(request, { database: 'ok', storage: 'ok' })
  })

  test('mandatory adversarial: health_databaseUnreachable_neverReturns500Or503OrATimeout', async ({ request }) => {
    await setHealthState(request, { database: 'down', storage: 'ok' })
    const started = Date.now()
    const response = await request.get('/api/health', { timeout: 10_000 })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(response.status()).toBe(200)
    expect((await response.json()) as HealthBody).toMatchObject({ database: 'down' })
  })

  test('mandatory adversarial: health_storageUnreachable_neverReturns500Or503OrATimeout', async ({ request }) => {
    await setHealthState(request, { database: 'ok', storage: 'down' })
    const started = Date.now()
    const response = await request.get('/api/health', { timeout: 10_000 })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(response.status()).toBe(200)
    expect((await response.json()) as HealthBody).toMatchObject({ storage: 'down' })
  })

  test('mandatory adversarial: health_bothUnreachable_returns200WithBothDownAndAppOk', async ({ request }) => {
    await setHealthState(request, { database: 'down', storage: 'down' })
    const response = await request.get('/api/health')
    expect(response.status()).toBe(200)
    const body = (await response.json()) as HealthBody
    expect(body).toEqual({ app: 'ok', database: 'down', storage: 'down' })
  })

  test('mandatory adversarial: health_hangingProbe_stillAnswersWithinABoundedTime', async ({ request }) => {
    await setHealthState(request, { database: 'hang', storage: 'ok' })
    const started = Date.now()
    const response = await request.get('/api/health', { timeout: 10_000 })
    const elapsedMs = Date.now() - started
    expect(response.status()).toBe(200)
    // The probe's own AbortController timeout (2s) bounds this — the request
    // never rides the hang out to Playwright's own 10s ceiling.
    expect(elapsedMs).toBeLessThan(8_000)
    const body = (await response.json()) as HealthBody
    expect(body).toEqual({ app: 'ok', database: 'down', storage: 'ok' })
  })

  test('mandatory adversarial: health_response_neverContainsAKeyBeyondAppDatabaseStorage', async ({ request }) => {
    const scenarios: Array<{ database: DependencyState; storage: DependencyState }> = [
      { database: 'ok', storage: 'ok' },
      { database: 'down', storage: 'ok' },
      { database: 'ok', storage: 'down' },
      { database: 'down', storage: 'down' },
    ]
    for (const scenario of scenarios) {
      await setHealthState(request, scenario)
      const response = await request.get('/api/health')
      const body = (await response.json()) as Record<string, unknown>
      expect(Object.keys(body).sort(), JSON.stringify(scenario)).toEqual(['app', 'database', 'storage'])
    }
  })

  test('mandatory adversarial: health_response_neverContainsAHostNameOrDatabaseErrorString', async ({
    request,
  }) => {
    await setHealthState(request, { database: 'down', storage: 'down' })
    const response = await request.get('/api/health')
    const text = await response.text()
    expect(text).not.toMatch(/ECONNREFUSED|ECONNRESET|ETIMEDOUT/i)
    expect(text).not.toMatch(/postgres|supabase\.co|127\.0\.0\.1|localhost/i)
    expect(text).not.toMatch(/at .*\(.*:\d+:\d+\)/) // a stack trace frame
    expect(JSON.parse(text)).toEqual({ app: 'ok', database: 'down', storage: 'down' })
  })

  test('mandatory adversarial (static): health_probeCatchBlockNeverForwardsTheCaughtError', async () => {
    const source = await readFile(path.join(REPO_ROOT, 'app/api/health/route.ts'), 'utf8')
    // The catch clause below `probe(...)` must be empty of the caught
    // binding — the only way to guarantee an error's message or stack can
    // never reach the response body is for the code to never read it.
    expect(source).toMatch(/catch\s*\{\s*return 'down'/)
  })
})

test.describe('DependencyError — acceptance + mandatory adversarial: UX_SPEC §4.14, CQ-5', () => {
  // DependencyError is presentational (per JOR-247's design decisions) and no
  // real screen consumes app/api/health/route.ts yet — imaging and report
  // screens are T58/T71's own scope. This renders the actual component via
  // react-dom/server (not a reimplementation) into a real Chromium page, so
  // a broken component — wrong copy, a div instead of a button, a missing
  // accessible name, an undersized target — fails these tests exactly as it
  // would once a later ticket wires it into a real screen.
  async function renderDependencyErrorPage(): Promise<string> {
    const html = renderToStaticMarkup(createElement(DependencyError, { onRetry: () => {} }))
    const globalsCss = await readFile(path.join(REPO_ROOT, 'app/globals.css'), 'utf8')
    return `<!doctype html><html><head><meta charset="utf-8"><style>${globalsCss}</style></head><body>${html}</body></html>`
  }

  test('acceptance: dependencyError_rendersPinnedCopyAndAFocusableAccessibleRetryButton', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.setContent(await renderDependencyErrorPage())

    await expect(page.getByTestId('dependency-error')).toBeVisible()
    await expect(
      page.getByText('Images are temporarily unavailable… your data is safe', { exact: true }),
    ).toBeVisible()

    const retry = page.getByRole('button', { name: 'Try again' })
    await expect(retry).toBeVisible()
    await retry.focus()
    await expect(retry).toBeFocused()
  })

  test('acceptance: dependencyError_retryButtonIsAtLeast44x44pxAt390pxWidth', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.setContent(await renderDependencyErrorPage())

    const box = await page.getByTestId('dependency-error-retry').boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeGreaterThanOrEqual(44)
    expect(box!.height).toBeGreaterThanOrEqual(44)
  })

  test('mandatory adversarial: dependencyError_neverRendersARawErrorAStackTraceOrABlankBody', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.setContent(await renderDependencyErrorPage())

    const bodyText = await page.locator('body').innerText()
    expect(bodyText.trim().length).toBeGreaterThan(0)
    expect(bodyText).not.toMatch(/at .*\(.*:\d+:\d+\)/)
    expect(bodyText).not.toMatch(/TypeError|ReferenceError|ECONNREFUSED|stack trace/i)
    expect(bodyText).not.toMatch(/database|storage/i) // never names which dependency failed
  })
})
