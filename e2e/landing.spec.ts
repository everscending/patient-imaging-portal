// e2e/landing.spec.ts — JOR-310: marketing landing page contract. Keeps the
// sign-in CTA, the /login and /register links, and the single-h1 shape from
// silently drifting once the copy changes again.
import { test, expect } from '@playwright/test'
import { config } from '../lib/config'

test.describe('Landing page (JOR-310)', () => {
  test('acceptance: shows the wordmark, one h1, and CTAs to /login and /register', async ({ page }) => {
    await page.goto('/')

    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toHaveAttribute('href', '/login')
    await expect(page.getByRole('link', { name: 'Create an account' })).toHaveAttribute('href', '/register')

    const header = page.locator('header')
    await expect(header).toContainText('Patient Imaging Portal')
    await expect(header.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')

    const footer = page.locator('footer')
    await expect(footer).toContainText('Patient Imaging Portal')
    await expect(footer.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login')
  })

  test('acceptance: wordmark renders the configured practice name in both header and footer', async ({ page }) => {
    await page.goto('/')

    await expect(page.locator('header')).toContainText(config.practiceName)
    await expect(page.locator('footer')).toContainText(config.practiceName)
  })

  test('mobileLayout_at390pxHasNoBodyOverflowAndVisible44pxSignInCta', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await page.goto('/')

    expect(await page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement
      return root.scrollWidth <= root.clientWidth
    })).toBe(true)

    const primaryCta = page.locator('main').getByRole('link', { name: 'Sign in' })
    await expect(primaryCta).toBeVisible()
    const box = await primaryCta.boundingBox()
    expect(box?.height).toBeGreaterThanOrEqual(44)
  })
})
