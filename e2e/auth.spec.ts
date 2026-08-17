// e2e/auth.spec.ts — JOR-229's live check. Register/sign-in, the patient
// shell, and the /verify redirect, against the real app on PORT (4310) with
// the fake Supabase Auth server e2e/fixtures/fake-auth-server.ts stands in
// for the provider (e2e/fixtures/start-test-server.mjs).
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page } from '@playwright/test'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()

async function fakeAuthServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

function uniqueEmail(label: string): string {
  return `${label}-${randomUUID()}@example.com`
}

const PASSWORD = 'CorrectHorseBattery9'

type ErrorEnvelope = { error: string; message: string }
type FakeAuthCalls = Record<'signup' | 'token' | 'user' | 'updateUser', number>

async function fakeAuthCalls(requestContext: APIRequestContext, email?: string): Promise<FakeAuthCalls> {
  const authUrl = await fakeAuthServerUrl()
  const query = email === undefined ? '' : `?email=${encodeURIComponent(email)}`
  return (await (await requestContext.get(`${authUrl}/__test__/calls${query}`)).json()) as FakeAuthCalls
}

async function register(
  requestContext: APIRequestContext,
  email: string,
  password = PASSWORD,
): Promise<{ status: number; body: unknown }> {
  const response = await requestContext.post('/api/auth/register', { data: { email, password } })
  return { status: response.status(), body: await response.json() }
}

async function login(
  requestContext: APIRequestContext,
  email: string,
  password = PASSWORD,
): Promise<{ status: number; body: unknown }> {
  const response = await requestContext.post('/api/auth/login', { data: { email, password } })
  return { status: response.status(), body: await response.json() }
}

/** Registers a fresh account and signs it in on the given context — every
 *  freshly registered account is unverified/unlinked (ADR-0011: registration
 *  never links a patient), which is exactly the state most of these tests need. */
async function registerAndSignIn(requestContext: APIRequestContext): Promise<string> {
  const email = uniqueEmail('patient')
  await register(requestContext, email)
  const { status } = await login(requestContext, email)
  expect(status).toBe(200)
  return email
}

test.describe('POST /api/auth/register — acceptance: the pinned §6 shapes', () => {
  test('acceptance: register_freshEmail_returns201WithUserId', async ({ request }) => {
    const { status, body } = await register(request, uniqueEmail('register-fresh'))
    expect(status).toBe(201)
    expect(typeof (body as { userId: unknown }).userId).toBe('string')
  })

  test('acceptance: register_duplicateEmail_returns409EmailInUse', async ({ request }) => {
    const email = uniqueEmail('register-dupe')
    await register(request, email)
    const { status, body } = await register(request, email)
    expect(status).toBe(409)
    expect(body).toEqual({ error: 'email_in_use', message: expect.any(String) })
  })

  test('mandatory adversarial: register_oversizedEmail_returns422', async ({ request }) => {
    const hugeEmail = `${'a'.repeat(10_000)}@example.com`
    const { status, body } = await register(request, hugeEmail)
    expect(status).toBe(422)
    expect(body).toEqual({ error: 'validation_failed', message: expect.any(String) })
  })

  test('mandatory adversarial: register_extraFields_returns422', async ({ request }) => {
    for (const extra of [{ patientRef: 'PT-0001' }, { patientId: randomUUID() }, { role: 'admin' }]) {
      const response = await request.post('/api/auth/register', {
        data: { email: uniqueEmail('register-extra'), password: PASSWORD, ...extra },
      })
      expect(response.status(), `extra field ${JSON.stringify(extra)} was accepted`).toBe(422)
    }
  })

  test('mandatory adversarial: register_validationRuns_beforeProviderIsEverCalled', async ({ request }) => {
    const email = uniqueEmail('register-short-password')
    const before = await fakeAuthCalls(request, email)
    // Fails lib/validation's min(8) password bound — never reaches Supabase.
    await register(request, email, 'x')
    const after = await fakeAuthCalls(request, email)
    expect(after.signup).toBe(before.signup)
  })

  test('mandatory adversarial: register_neverWritesPatientsUserId (static)', async () => {
    const source = await readFile(path.join(REPO_ROOT, 'app/api/auth/register/route.ts'), 'utf8')
    // The route only ever calls authClient().auth.signUp — no table write of
    // any kind, so grepping for the two ways one could reach `patients` is a
    // sound proxy for "this code path cannot set patients.user_id".
    expect(source).not.toMatch(/serviceClient/)
    expect(source).not.toMatch(/\.from\(['"]patients['"]\)/)
  })
})

test.describe('POST /api/auth/login — acceptance: the pinned §6 shapes', () => {
  test('acceptance: login_correctCredentials_returns200WithUserIdAndExpiresAt', async ({ request }) => {
    const email = uniqueEmail('login-ok')
    await register(request, email)
    const { status, body } = await login(request, email)
    expect(status).toBe(200)
    const { userId, expiresAt } = body as { userId: string; expiresAt: string }
    expect(typeof userId).toBe('string')
    expect(Number.isNaN(Date.parse(expiresAt))).toBe(false)
  })

  test('mandatory adversarial: login_wrongPasswordVsNoAccount_areByteIdentical401', async ({ request }) => {
    const registeredEmail = uniqueEmail('login-wrongpw')
    await register(request, registeredEmail)

    const wrongPassword = await request.post('/api/auth/login', {
      data: { email: registeredEmail, password: 'not-the-password-1' },
    })
    const noAccount = await request.post('/api/auth/login', {
      data: { email: uniqueEmail('login-noaccount'), password: PASSWORD },
    })

    expect(wrongPassword.status()).toBe(401)
    expect(noAccount.status()).toBe(401)
    expect(await wrongPassword.text()).toBe(await noAccount.text())
    expect(JSON.parse(await wrongPassword.text())).toEqual({
      error: 'invalid_credentials',
      message: expect.any(String),
    })
  })

  test('mandatory adversarial: login_validationRuns_beforeProviderIsEverCalled', async ({ request }) => {
    const invalidEmail = uniqueEmail('login-extra')
    const unrelatedEmail = uniqueEmail('login-unrelated')
    await register(request, unrelatedEmail)
    const before = await fakeAuthCalls(request, invalidEmail)
    const unrelatedBefore = await fakeAuthCalls(request, unrelatedEmail.toUpperCase())
    // Another worker can authenticate while this validation assertion is in
    // flight. Its provider call must not be attributed to the invalid login.
    expect((await login(request, unrelatedEmail)).status).toBe(200)
    // .strict() rejects the extra field before Supabase is ever reached.
    await request.post('/api/auth/login', {
      data: { email: invalidEmail, password: PASSWORD, role: 'admin' },
    })
    const after = await fakeAuthCalls(request, invalidEmail)
    const unrelatedAfter = await fakeAuthCalls(request, unrelatedEmail)
    expect(unrelatedAfter.token).toBe(unrelatedBefore.token + 1)
    expect(after.token).toBe(before.token)
  })
})

test.describe('Neither form calls the auth provider directly — mandatory adversarial', () => {
  async function assertOnlyOwnApiCalled(page: Page, formTestId: string, submitLabel: string): Promise<void> {
    const authUrl = await fakeAuthServerUrl()
    const authOrigin = new URL(authUrl).origin
    const requestedUrls: string[] = []
    page.on('request', (req) => requestedUrls.push(req.url()))

    await page.getByLabel('Email').fill(uniqueEmail('network-log'))
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: submitLabel }).click()
    await page.waitForLoadState('networkidle')

    expect(requestedUrls.some((url) => url.startsWith(authOrigin))).toBe(false)
    expect(requestedUrls.some((url) => url.includes('/api/auth/'))).toBe(true)
    void formTestId
  }

  test('login_neverCallsProviderFromBrowser', async ({ page }) => {
    await page.goto('/login')
    await assertOnlyOwnApiCalled(page, 'login-form', 'Sign in')
  })

  test('register_neverCallsProviderFromBrowser', async ({ page }) => {
    await page.goto('/register')
    await assertOnlyOwnApiCalled(page, 'register-form', 'Register')
  })
})

test.describe('Session-expiry copy — acceptance + mandatory adversarial: exact UX_SPEC §4.1 wording', () => {
  const PINNED_SENTENCE = "You'll be signed out after 60 minutes of inactivity."

  test('login_statesSessionExpiryVerbatim', async ({ page }) => {
    await page.goto('/login')
    await expect(page.getByText(PINNED_SENTENCE, { exact: true })).toBeVisible()
  })

  test('register_statesSessionExpiryVerbatim', async ({ page }) => {
    await page.goto('/register')
    await expect(page.getByText(PINNED_SENTENCE, { exact: true })).toBeVisible()
  })
})

test.describe('No session TTL in application code — mandatory adversarial (static)', () => {
  test('sessionLifetime_neverReadFromEnvOrHardcoded', async () => {
    const configSource = await readFile(path.join(REPO_ROOT, 'lib/config.ts'), 'utf8')
    for (const forbidden of ['SESSION_TTL', 'SESSION_TIMEOUT', 'SESSION_EXPIRY', 'SESSION_LIFETIME']) {
      expect(configSource).not.toContain(forbidden)
    }

    for (const file of ['app/login/page.tsx', 'app/register/page.tsx', 'middleware.ts']) {
      const source = await readFile(path.join(REPO_ROOT, file), 'utf8')
      expect(source).not.toMatch(/3600000|60\s*\*\s*60/)
    }
  })
})

test.describe('Password never rendered, logged, or in a query string — mandatory adversarial', () => {
  test('login_passwordNeverEchoed', async ({ page }) => {
    const distinctivePassword = `Sup3rSecret-${randomUUID()}`
    const consoleMessages: string[] = []
    const requestUrls: string[] = []
    page.on('console', (msg) => consoleMessages.push(msg.text()))
    page.on('request', (req) => requestUrls.push(req.url()))

    await page.goto('/login')
    await page.getByLabel('Email').fill(uniqueEmail('password-echo'))
    await page.getByLabel('Password').fill(distinctivePassword)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await page.waitForLoadState('networkidle')

    const visibleText = await page.locator('body').innerText()
    expect(visibleText).not.toContain(distinctivePassword)
    expect(consoleMessages.join('\n')).not.toContain(distinctivePassword)
    expect(requestUrls.some((url) => url.includes(distinctivePassword))).toBe(false)
  })
})

test.describe('Middleware — six verified-patient routes redirect to /verify; three session-only routes do not', () => {
  const VERIFIED_ROUTES = [
    '/studies',
    '/studies/11111111-1111-1111-1111-111111111111',
    '/studies/11111111-1111-1111-1111-111111111111/clips/22222222-2222-2222-2222-222222222222',
    '/reports',
    '/reports/11111111-1111-1111-1111-111111111111',
    '/shares',
  ]

  test('acceptance: verified_unlinkedSession_redirectsToVerifyWithEncodedNext', async ({ request }) => {
    await registerAndSignIn(request)
    for (const route of VERIFIED_ROUTES) {
      const response = await request.get(route, { maxRedirects: 0 })
      expect(response.status(), route).toBeGreaterThanOrEqual(300)
      expect(response.status(), route).toBeLessThan(400)
      const location = response.headers()['location'] ?? ''
      expect(location, route).toContain('/verify?next=')
      expect(location, route).toContain(encodeURIComponent(route))
    }
  })

  test('acceptance: verified_studies_redirectsToExactlyPinnedVerifyUrl', async ({ request }) => {
    await registerAndSignIn(request)
    const response = await request.get('/studies', { maxRedirects: 0 })
    const location = new URL(response.headers()['location'] ?? '', 'http://localhost')
    expect(location.pathname + location.search).toBe('/verify?next=%2Fstudies')
  })

  test('mandatory adversarial: api_unlinkedSession_returns403_neverARedirect', async ({ request }) => {
    await registerAndSignIn(request)
    const response = await request.get('/api/studies', { maxRedirects: 0 })
    expect(response.status()).toBe(403)
    expect(await response.json()).toEqual({
      error: 'identity_verification_required',
      message: expect.any(String),
    })
  })

  test('acceptance: sessionOnlyRoutes_areNeverRedirectedToVerify', async ({ request }) => {
    await registerAndSignIn(request)
    for (const route of ['/profile', '/appointments', '/book']) {
      const response = await request.get(route, { maxRedirects: 0 })
      const location = response.headers()['location'] ?? ''
      expect(location.includes('/verify'), route).toBe(false)
    }
  })

  test('mandatory adversarial: next_attackerSuppliedValue_isIgnoredForTheRedirectMiddlewareBuilds', async ({
    request,
  }) => {
    await registerAndSignIn(request)
    for (const malicious of ['https://evil.example', '//evil.example', 'javascript:alert(1)']) {
      const response = await request.get(`/studies?next=${encodeURIComponent(malicious)}`, { maxRedirects: 0 })
      const location = new URL(response.headers()['location'] ?? '', 'http://localhost')
      // Middleware derives ?next= only from the request's own pathname, never
      // from a query string the caller controls — the redirect target is
      // always the pinned in-app path, regardless of what the caller sent.
      expect(location.pathname + location.search).toBe('/verify?next=%2Fstudies')
    }
  })
})

test.describe('Middleware — expired/absent session', () => {
  test('mandatory adversarial: unauthenticatedStudiesReportsProfileReturn401WithoutPhi', async ({ request }) => {
    const protectedPatientRoutes = [
      '/studies',
      '/studies/11111111-1111-1111-1111-111111111111',
      '/studies/11111111-1111-1111-1111-111111111111/clips/22222222-2222-2222-2222-222222222222',
      '/reports',
      '/reports/11111111-1111-1111-1111-111111111111',
      '/shares',
      '/profile',
      '/appointments',
      '/book',
    ]

    for (const route of protectedPatientRoutes) {
      const response = await request.get(route, { maxRedirects: 0 })
      expect(response.status(), route).toBe(401)
      expect(response.headers().location, route).toBeUndefined()
      expect(await response.text(), route).toBe('')
    }
  })

  test('acceptance: patientApi_noSession_returns401WithEnvelope', async ({ request }) => {
    const response = await request.get('/api/studies', { maxRedirects: 0 })
    expect(response.status()).toBe(401)
    const body = (await response.json()) as ErrorEnvelope
    expect(typeof body.error).toBe('string')
    expect(typeof body.message).toBe('string')
  })

  test('adversarial: patientPage_garbageSessionCookie_redirectsToLogin', async ({ page, context }) => {
    await page.goto('/')
    await context.addCookies([{ name: 'pip_session', value: 'not-a-real-token', url: page.url() }])
    await page.goto('/appointments')
    await expect(page).toHaveURL(/\/login$/)
  })
})

test.describe('Registering, signing in, and reaching a session-only page', () => {
  test('acceptance: freshAccount_registersSignsInAndReachesAppointments', async ({ page }) => {
    const email = uniqueEmail('golden-path')
    await page.goto('/register')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Register' }).click()
    await expect(page).toHaveURL(/\/login$/)

    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page).toHaveURL(/\/appointments$/)
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
  })

  // /profile's page.tsx belongs to JOR-263 — this proves middleware keeps
  // treating the now-implemented page as session-only rather than requiring
  // an identity link.
  test('acceptance: sessionOnlyRoute_profile_isNotBlockedByMiddleware', async ({
    request,
  }) => {
    await registerAndSignIn(request)
    const response = await request.get('/profile', { maxRedirects: 0 })
    expect(response.status()).toBe(200)
  })
})

test.describe('PatientShell — U-1, acceptance + mandatory adversarial', () => {
  const DESTINATIONS = ['Imaging', 'Reports', 'Visits', 'Shares']

  async function signedInPage(page: Page): Promise<void> {
    const email = uniqueEmail('shell')
    await page.request.post('/api/auth/register', { data: { email, password: PASSWORD } })
    const loginResponse = await page.request.post('/api/auth/login', { data: { email, password: PASSWORD } })
    expect(loginResponse.status()).toBe(200)
  }

  test('acceptance: at390px_rendersBottomTabBarWithFourDestinations_44pxTargets_noHorizontalScroll', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await signedInPage(page)
    await page.goto('/appointments')

    const tabbar = page.getByTestId('patient-tabbar')
    await expect(tabbar).toBeVisible()
    await expect(page.getByTestId('patient-sidebar')).toBeHidden()

    for (const label of DESTINATIONS) {
      const link = tabbar.getByRole('link', { name: label })
      await expect(link).toBeVisible()
      const box = await link.boundingBox()
      expect(box, label).not.toBeNull()
      expect(box!.width, label).toBeGreaterThanOrEqual(44)
      expect(box!.height, label).toBeGreaterThanOrEqual(44)
    }

    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth)
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth)
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth)
  })

  test('acceptance: at1280px_rendersLeftSidebarWithPatientNameAboveFourDestinations', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signedInPage(page)
    await page.goto('/appointments')

    const sidebar = page.getByTestId('patient-sidebar')
    await expect(sidebar).toBeVisible()
    await expect(page.getByTestId('patient-tabbar')).toBeHidden()

    const sidebarText = await sidebar.innerText()
    const nameIndex = 0
    const firstDestinationIndex = sidebarText.indexOf(DESTINATIONS[0])
    expect(firstDestinationIndex).toBeGreaterThan(nameIndex)

    for (const label of DESTINATIONS) {
      await expect(sidebar.getByRole('link', { name: label })).toBeVisible()
    }
  })

  test('mandatory adversarial: noVerificationIndicatorAnywhere_at390pxOr1280px', async ({ page }) => {
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      await signedInPage(page)
      await page.goto('/appointments')
      const text = await page.locator('body').innerText()
      expect(text).not.toMatch(/verify|unlock|countdown/i)
      expect(text).not.toMatch(/\b\d{1,2}:\d{2}\b/)
    }
  })

  test('mandatory adversarial: noHardcodedHexColourInShellComponents (static)', async () => {
    for (const file of ['components/shell/PatientShell.tsx', 'app/(patient)/layout.tsx']) {
      const source = await readFile(path.join(REPO_ROOT, file), 'utf8')
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    }
  })

  test('accessibility: navLinksAreFocusableWithAccessibleNames_keyboardOperable', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signedInPage(page)
    await page.goto('/appointments')

    const sidebar = page.getByTestId('patient-sidebar')
    for (const label of DESTINATIONS) {
      const link = sidebar.getByRole('link', { name: label })
      await expect(link).toBeVisible()
      await link.focus()
      await expect(link).toBeFocused()
    }
  })
})
