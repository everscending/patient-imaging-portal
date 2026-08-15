// Covers JOR-229's full acceptance criteria and every bullet under
// "Mandatory adversarial tests" (see the ticket body / MR description for
// the bullet -> test mapping). Runs against a real app instance
// (playwright.config.ts's webServer) and a real Supabase Auth surface — in
// CI that is the project named by repository secrets; locally, where no
// project is configured, e2e/fixtures/start-test-server.mjs stands up a
// small local double (e2e/fixtures/fake-auth-server.ts) with the same wire
// shapes, the same way ADR-0013 stood up a local Postgres rather than
// depending on reachable cloud infra for tests.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import { SESSION_COOKIE_NAME, sanitizeNextPath } from '../lib/session-cookie'

const SESSION_EXPIRY_SENTENCE = "You'll be signed out after 60 minutes of inactivity."

function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`
}

const VALID_PASSWORD = 'CorrectHorseBattery9'

async function registerAccount(request: import('@playwright/test').APIRequestContext, email: string, password = VALID_PASSWORD) {
  const response = await request.post('/api/auth/register', { data: { email, password } })
  const body = await response.json().catch(() => ({}))
  return { response, body }
}

async function loginAccount(request: import('@playwright/test').APIRequestContext, email: string, password = VALID_PASSWORD) {
  const response = await request.post('/api/auth/login', { data: { email, password } })
  const body = await response.json().catch(() => ({}))
  const setCookie = response.headers()['set-cookie'] ?? ''
  const match = /pip_session=([^;]+)/.exec(setCookie)
  return { response, body, token: match?.[1] }
}

function cookieHeader(token: string): { Cookie: string } {
  return { Cookie: `${SESSION_COOKIE_NAME}=${token}` }
}

// Marks an account linked to a patient record the same way FR-2's real
// `/verify` flow will (a later ticket): through Supabase Auth's admin API,
// setting app_metadata.patientRef. Locally this targets the fake Auth
// double's admin endpoint (e2e/fixtures/fake-auth-server.ts implements the
// same shape); in CI, where that double never starts, it targets the real
// project directly with the real service-role key already in the
// environment.
async function linkPatient(userId: string, patientRef = 'PT-0001'): Promise<void> {
  const fakeAuthFile = path.join('.local', 'fake-auth.json')
  let baseUrl: string
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }

  if (existsSync(fakeAuthFile)) {
    baseUrl = (JSON.parse(readFileSync(fakeAuthFile, 'utf8')) as { baseUrl: string }).baseUrl
  } else {
    const { config } = await import('../lib/config')
    baseUrl = config.supabaseUrl
    headers.apikey = config.supabaseServiceRoleKey
    headers.Authorization = `Bearer ${config.supabaseServiceRoleKey}`
  }

  const response = await fetch(`${baseUrl}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ app_metadata: { patientRef } }),
  })
  if (!response.ok) {
    throw new Error(`linkPatient: admin update failed with ${response.status}`)
  }
}

async function registerLoginAndLink(request: import('@playwright/test').APIRequestContext, opts: { linked: boolean }) {
  const email = uniqueEmail(opts.linked ? 'linked' : 'unlinked')
  const { body: registerBody } = await registerAccount(request, email)
  if (opts.linked) await linkPatient(registerBody.userId)
  const { token } = await loginAccount(request, email)
  if (!token) throw new Error('registerLoginAndLink: no session cookie returned')
  return { email, userId: registerBody.userId as string, token }
}

test.describe('session-expiry sentence — UX_SPEC §4.1, pinned verbatim', () => {
  test('acceptance: /login states the sentence verbatim, and /register states the sentence verbatim (also the adversarial case: a screen that omits it or words it differently fails this exact match)', async ({
    page,
  }) => {
    await page.goto('/login')
    await expect(page.getByText(SESSION_EXPIRY_SENTENCE, { exact: true })).toBeVisible()

    await page.goto('/register')
    await expect(page.getByText(SESSION_EXPIRY_SENTENCE, { exact: true })).toBeVisible()
  })
})

test.describe('POST /api/auth/register — pinned interface', () => {
  test('acceptance: 201 { userId } for a fresh email', async ({ request }) => {
    const { response, body } = await registerAccount(request, uniqueEmail('fresh'))
    expect(response.status()).toBe(201)
    expect(typeof body.userId).toBe('string')
    expect(body.userId.length).toBeGreaterThan(0)
  })

  test('acceptance: 409 email_in_use for an email already registered', async ({ request }) => {
    const email = uniqueEmail('dupe')
    await registerAccount(request, email)
    const { response, body } = await registerAccount(request, email)
    expect(response.status()).toBe(409)
    expect(body.error).toBe('email_in_use')
    expect(typeof body.message).toBe('string')
  })

  test('adversarial: a malformed body (wrong content-type) is 422 validation_failed', async ({ request }) => {
    const response = await request.post('/api/auth/register', {
      headers: { 'content-type': 'text/plain' },
      data: 'not json',
    })
    expect(response.status()).toBe(422)
    expect((await response.json()).error).toBe('validation_failed')
  })

  test('adversarial: an oversized email (10 KB) is 422 validation_failed', async ({ request }) => {
    const oversizedEmail = `${'a'.repeat(10_000)}@example.test`
    const { response, body } = await registerAccount(request, oversizedEmail)
    expect(response.status()).toBe(422)
    expect(body.error).toBe('validation_failed')
  })

  for (const extraField of ['patientRef', 'patientId', 'role']) {
    test(`adversarial: an extra "${extraField}" field is 422 validation_failed`, async ({ request }) => {
      const response = await request.post('/api/auth/register', {
        data: { email: uniqueEmail('extra-field'), password: VALID_PASSWORD, [extraField]: 'x' },
      })
      expect(response.status()).toBe(422)
      expect((await response.json()).error).toBe('validation_failed')
    })
  }

  test('adversarial: a payload that fails validation never reaches Supabase Auth — the same email registers cleanly afterward', async ({
    request,
  }) => {
    const email = uniqueEmail('never-reaches-provider')
    const invalid = await request.post('/api/auth/register', {
      data: { email, password: VALID_PASSWORD, patientId: 'should-not-be-here' },
    })
    expect(invalid.status()).toBe(422)

    // If the invalid request had reached the provider, this email would
    // already be registered and the next call would be 409, not 201.
    const { response, body } = await registerAccount(request, email)
    expect(response.status()).toBe(201)
    expect(typeof body.userId).toBe('string')
  })

  test('acceptance + adversarial: registration links no patient record — a freshly registered account requesting /studies is redirected to /verify, never a non-null link', async ({
    request,
  }) => {
    const email = uniqueEmail('no-link')
    await registerAccount(request, email)
    const { token } = await loginAccount(request, email)
    const response = await request.get('/studies', { headers: cookieHeader(token!), maxRedirects: 0 })
    expect(response.status()).toBe(307)
    expect(response.headers().location).toContain('/verify')
  })
})

test.describe('POST /api/auth/login — pinned interface', () => {
  test('acceptance: 200 { userId, expiresAt } on success', async ({ request }) => {
    const email = uniqueEmail('login-success')
    await registerAccount(request, email)
    const { response, body } = await loginAccount(request, email)
    expect(response.status()).toBe(200)
    expect(typeof body.userId).toBe('string')
    expect(typeof body.expiresAt).toBe('string')
    expect(Number.isNaN(Date.parse(body.expiresAt))).toBe(false)
  })

  test('adversarial: a wrong password and a never-registered email return byte-identical 401 invalid_credentials', async ({
    request,
  }) => {
    const email = uniqueEmail('wrong-password')
    await registerAccount(request, email)

    const wrongPassword = await request.post('/api/auth/login', { data: { email, password: 'not-the-password' } })
    const noSuchAccount = await request.post('/api/auth/login', {
      data: { email: uniqueEmail('never-registered'), password: 'anything-at-all' },
    })

    expect(wrongPassword.status()).toBe(401)
    expect(noSuchAccount.status()).toBe(401)
    expect(await wrongPassword.json()).toEqual(await noSuchAccount.json())
  })

  test('adversarial: a login payload that fails validation never reaches Supabase Auth — even with correct credentials, an extra field is 422 rather than 200', async ({
    request,
  }) => {
    const email = uniqueEmail('login-validation-first')
    await registerAccount(request, email)
    const response = await request.post('/api/auth/login', {
      data: { email, password: VALID_PASSWORD, role: 'admin' },
    })
    // The route's only two failure shapes are 422 (validation, before any
    // provider call) and 401 (the provider's own rejection). Correct
    // credentials would succeed (200) if this ever reached the provider —
    // 422 here is only possible if validation rejected it first.
    expect(response.status()).toBe(422)
    expect((await response.json()).error).toBe('validation_failed')
  })
})

test.describe('the browser never calls the auth provider directly (ADR-0012 #15)', () => {
  test('adversarial: registering and signing in issue requests only to this app\'s own /api/auth/* routes, never to the provider\'s hostname', async ({
    page,
  }) => {
    const requestedUrls: string[] = []
    page.on('request', (req) => requestedUrls.push(req.url()))

    const email = uniqueEmail('no-direct-provider-call')
    await page.goto('/register')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(VALID_PASSWORD)
    await page.getByTestId('register-submit').click()
    await page.waitForURL('**/login')

    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(VALID_PASSWORD)
    await page.getByTestId('login-submit').click()
    await page.waitForURL('**/profile')

    const appOrigin = new URL(page.url()).origin
    const foreignRequests = requestedUrls.filter((url) => !url.startsWith(appOrigin) && !url.startsWith('data:'))
    expect(foreignRequests).toEqual([])

    const authApiCalls = requestedUrls.filter((url) => url.includes('/api/auth/'))
    expect(authApiCalls.some((url) => url.includes('/api/auth/register'))).toBe(true)
    expect(authApiCalls.some((url) => url.includes('/api/auth/login'))).toBe(true)
  })
})

test.describe('middleware — page routes redirect, never render (§5, §7)', () => {
  const lockedRoutes = [
    { path: '/studies', next: '%2Fstudies' },
    { path: '/studies/abc-123', next: '%2Fstudies%2Fabc-123' },
    { path: '/studies/abc-123/clips/def-456', next: '%2Fstudies%2Fabc-123%2Fclips%2Fdef-456' },
    { path: '/reports', next: '%2Freports' },
    { path: '/reports/abc-123', next: '%2Freports%2Fabc-123' },
    { path: '/shares', next: '%2Fshares' },
  ]

  for (const route of lockedRoutes) {
    test(`adversarial: an unlinked account requesting ${route.path} is redirected to /verify?next=${route.next}, never rendered`, async ({
      request,
    }) => {
      const { token } = await registerLoginAndLink(request, { linked: false })
      const response = await request.get(route.path, { headers: cookieHeader(token), maxRedirects: 0 })
      expect(response.status()).toBe(307)
      expect(response.headers().location).toContain(`/verify?next=${route.next}`)
    })
  }

  test('acceptance: a linked account requesting /studies is not redirected to /verify', async ({ request }) => {
    const { token } = await registerLoginAndLink(request, { linked: true })
    const response = await request.get('/studies', { headers: cookieHeader(token), maxRedirects: 0 })
    expect(response.status()).not.toBe(307)
  })

  for (const path of ['/profile', '/appointments', '/book']) {
    test(`acceptance: an unlinked account requesting ${path} is not redirected to /verify`, async ({ request }) => {
      const { token } = await registerLoginAndLink(request, { linked: false })
      const response = await request.get(path, { headers: cookieHeader(token), maxRedirects: 0 })
      const location = response.headers().location ?? ''
      expect(location).not.toContain('/verify')
    })
  }

  test('acceptance: an unauthenticated request to a patient page redirects to /login', async ({ request }) => {
    const response = await request.get('/profile', { maxRedirects: 0 })
    expect(response.status()).toBe(307)
    expect(response.headers().location).toContain('/login')
  })
})

test.describe('middleware — API routes return status codes, never a redirect (§5)', () => {
  test('adversarial: /api/studies with a session and an unlinked account is 403 with the error envelope, never a redirect', async ({
    request,
  }) => {
    const { token } = await registerLoginAndLink(request, { linked: false })
    const response = await request.get('/api/studies', { headers: cookieHeader(token), maxRedirects: 0 })
    expect(response.status()).toBe(403)
    expect(response.headers().location).toBeUndefined()
    const body = await response.json()
    expect(body.error).toBe('identity_verification_required')
    expect(typeof body.message).toBe('string')
  })

  test('acceptance: an unauthenticated request to a patient API route is 401 with the error envelope, never a redirect', async ({
    request,
  }) => {
    const response = await request.get('/api/studies', { maxRedirects: 0 })
    expect(response.status()).toBe(401)
    expect(response.headers().location).toBeUndefined()
    const body = await response.json()
    expect(typeof body.error).toBe('string')
    expect(typeof body.message).toBe('string')
  })
})

test.describe('sanitizeNextPath — the ?next= open-redirect guard', () => {
  const maliciousInputs = [
    'https://evil.example/steal',
    '//evil.example/steal',
    'javascript:alert(1)',
    '/\\evil.example',
  ]

  for (const input of maliciousInputs) {
    test(`adversarial: "${input}" resolves to the safe in-app default, never the raw value`, () => {
      const result = sanitizeNextPath(input)
      expect(result.startsWith('/')).toBe(true)
      expect(result.startsWith('//')).toBe(false)
      expect(result).toBe('/studies')
    })
  }

  test('acceptance: a genuine in-app path passes through unchanged', () => {
    expect(sanitizeNextPath('/studies/abc-123')).toBe('/studies/abc-123')
  })
})

test.describe('the patient shell (UX_SPEC §3, U-1)', () => {
  async function signedInProfilePage(browser: import('@playwright/test').Browser, request: import('@playwright/test').APIRequestContext, baseURL: string) {
    const { token } = await registerLoginAndLink(request, { linked: false })
    const context = await browser.newContext()
    await context.addCookies([{ name: SESSION_COOKIE_NAME, value: token, url: baseURL }])
    const page = await context.newPage()
    await page.goto('/profile')
    return { context, page }
  }

  test('acceptance: at 390px renders a bottom tab bar with exactly Imaging, Reports, Visits, Shares, fixed to the bottom, no horizontal scroll', async ({
    browser,
    request,
    baseURL,
  }) => {
    const { context, page } = await signedInProfilePage(browser, request, baseURL!)
    await page.setViewportSize({ width: 390, height: 844 })

    const tabbar = page.getByTestId('shell-tabbar')
    await expect(tabbar).toBeVisible()
    await expect(tabbar).toHaveText(['Imaging', 'Reports', 'Visits', 'Shares'].join(''))

    const box = await tabbar.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.y + box!.height).toBeCloseTo(844, 0)

    const sidebar = page.getByTestId('shell-sidebar')
    await expect(sidebar).toBeHidden()

    const hasHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
    expect(hasHorizontalScroll).toBe(false)

    await context.close()
  })

  test('adversarial: a tab-bar control smaller than 44x44 at 390px is rejected', async ({ browser, request, baseURL }) => {
    const { context, page } = await signedInProfilePage(browser, request, baseURL!)
    await page.setViewportSize({ width: 390, height: 844 })

    for (const testId of ['shell-nav-imaging-tab', 'shell-nav-reports-tab', 'shell-nav-visits-tab', 'shell-nav-shares-tab']) {
      const box = await page.getByTestId(testId).boundingBox()
      expect(box).not.toBeNull()
      expect(box!.width).toBeGreaterThanOrEqual(44)
      expect(box!.height).toBeGreaterThanOrEqual(44)
    }

    await context.close()
  })

  test('acceptance: at 768px and above renders a persistent left sidebar with the patient name above the four destinations', async ({
    browser,
    request,
    baseURL,
  }) => {
    const { context, page } = await signedInProfilePage(browser, request, baseURL!)
    await page.setViewportSize({ width: 1280, height: 800 })

    const sidebar = page.getByTestId('shell-sidebar')
    await expect(sidebar).toBeVisible()
    await expect(page.getByTestId('shell-tabbar')).toBeHidden()

    const sidebarText = await sidebar.innerText()
    const nameIndex = sidebarText.indexOf(await page.getByTestId('shell-patient-name').innerText())
    const firstDestinationIndex = sidebarText.indexOf('Imaging')
    expect(nameIndex).toBeGreaterThanOrEqual(0)
    expect(firstDestinationIndex).toBeGreaterThan(nameIndex)

    for (const label of ['Imaging', 'Reports', 'Visits', 'Shares']) {
      await expect(sidebar.getByRole('link', { name: label })).toBeVisible()
    }

    await context.close()
  })

  test('adversarial: no verification countdown or badge is rendered at 390px or 1280px', async ({ browser, request, baseURL }) => {
    const { context, page } = await signedInProfilePage(browser, request, baseURL!)
    const bannedPattern = /countdown|verification required|minutes? (left|remaining)|unlock/i

    await page.setViewportSize({ width: 390, height: 844 })
    await expect(page.getByTestId('shell-tabbar')).not.toHaveText(bannedPattern)

    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(page.getByTestId('shell-sidebar')).not.toHaveText(bannedPattern)

    await context.close()
  })

  test('adversarial: no hardcoded hex colour in PatientShell.tsx, app/login/page.tsx or app/register/page.tsx', () => {
    const hexPattern = /#[0-9a-fA-F]{3,8}\b/
    for (const file of ['components/shell/PatientShell.tsx', 'app/login/page.tsx', 'app/register/page.tsx']) {
      const content = readFileSync(file, 'utf8')
      expect(content).not.toMatch(hexPattern)
    }
  })

  test('acceptance: every shell control is keyboard-focusable with an accessible name, and each page has exactly one <h1>', async ({
    browser,
    request,
    baseURL,
    page: unauthenticatedPage,
  }) => {
    const { context, page } = await signedInProfilePage(browser, request, baseURL!)
    await page.setViewportSize({ width: 1280, height: 800 })

    for (const label of ['Imaging', 'Reports', 'Visits', 'Shares']) {
      const link = page.getByTestId('shell-sidebar').getByRole('link', { name: label })
      await link.focus()
      await expect(link).toBeFocused()
    }

    await expect(page.locator('h1')).toHaveCount(1)
    await context.close()

    await unauthenticatedPage.goto('/login')
    await expect(unauthenticatedPage.locator('h1')).toHaveCount(1)
    await unauthenticatedPage.goto('/register')
    await expect(unauthenticatedPage.locator('h1')).toHaveCount(1)
  })
})

test.describe('no password or session artifact ever surfaces', () => {
  test('adversarial: the password never appears in the URL or a console log line during login or registration', async ({ page }) => {
    const consoleMessages: string[] = []
    page.on('console', (msg) => consoleMessages.push(msg.text()))

    const email = uniqueEmail('no-password-leak')
    await page.goto('/register')
    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(VALID_PASSWORD)
    await page.getByTestId('register-submit').click()
    await page.waitForURL('**/login')
    expect(page.url()).not.toContain(VALID_PASSWORD)

    await page.getByLabel('Email').fill(email)
    await page.getByLabel('Password').fill(VALID_PASSWORD)
    await page.getByTestId('login-submit').click()
    await page.waitForURL('**/profile')
    expect(page.url()).not.toContain(VALID_PASSWORD)

    expect(consoleMessages.join('\n')).not.toContain(VALID_PASSWORD)
  })
})

test.describe('the session TTL is not an application variable (ADR-0012 #6, §8)', () => {
  test('adversarial: lib/config.ts and .env.example carry no session-TTL key; docs/deploy.md and README.md state the 60-minute setting', () => {
    const configSource = readFileSync('lib/config.ts', 'utf8')
    const envExample = readFileSync('.env.example', 'utf8')
    const sessionTtlPattern = /session.{0,10}ttl|SESSION_TTL|sessionTimeout/i

    expect(configSource).not.toMatch(sessionTtlPattern)
    expect(envExample).not.toMatch(sessionTtlPattern)

    const deploy = readFileSync('docs/deploy.md', 'utf8')
    const readme = readFileSync('README.md', 'utf8')
    expect(deploy).toContain('60 minutes')
    expect(readme).toContain('60 minutes')
  })
})
