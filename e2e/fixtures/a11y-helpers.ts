import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect } from '@playwright/test'
import type { APIRequestContext, Locator, Page } from '@playwright/test'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()

export async function fixtureUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

export async function resetFixtures(request: APIRequestContext): Promise<void> {
  expect((await request.post(`${await fixtureUrl()}/__test__/reset-identity`)).ok()).toBe(true)
  expect((await request.post(`${await fixtureUrl()}/__test__/reset-booking`)).ok()).toBe(true)
}

export async function expectNoPageOverflow(page: Page): Promise<void> {
  const scrollLeft = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement
    root.scrollLeft = 0
    root.scrollLeft = root.scrollWidth - root.clientWidth
    const result = root.scrollLeft
    root.scrollLeft = 0
    return result
  })
  expect(scrollLeft).toBe(0)
}

export async function expectTapTarget(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible()
  const box = await locator.boundingBox()
  expect(box?.width).toBeGreaterThanOrEqual(44)
  expect(box?.height).toBeGreaterThanOrEqual(44)
}

const BASE_NAMED_CONTROL_SELECTORS = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  '[role="button"]',
]

export async function expectNamedControls(page: Page, extraSelectors: string[] = []): Promise<void> {
  const controls = page.locator([...BASE_NAMED_CONTROL_SELECTORS, ...extraSelectors].join(','))
  for (let index = 0; index < await controls.count(); index += 1) {
    const control = controls.nth(index)
    if (!await control.isVisible()) continue
    const html = await control.evaluate((element) => element.outerHTML.slice(0, 180))
    await expect(control, `Unnamed interactive control: ${html}`).toHaveAccessibleName(/\S/)
  }
}

export async function expectVisibleKeyboardFocus(control: Locator): Promise<void> {
  await expect(control).toBeFocused()
  expect(await control.evaluate((element) => {
    const style = getComputedStyle(element)
    return (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none'
  })).toBe(true)
}

export async function tabTo(
  page: Page,
  target: Locator,
  options: { backwards?: boolean, limit?: number, assertNamedAtEachStep?: boolean } = {},
): Promise<void> {
  const key = options.backwards ? 'Shift+Tab' : 'Tab'
  for (let press = 0; press < (options.limit ?? 40); press += 1) {
    await page.keyboard.press(key)
    const hasDocumentFocus = await page.evaluate(() => {
      for (const previous of document.querySelectorAll('[data-keyboard-focus-check]')) previous.removeAttribute('data-keyboard-focus-check')
      const active = document.activeElement
      if (!(active instanceof HTMLElement) || active === document.body || active.matches('nextjs-portal')) return false
      active.setAttribute('data-keyboard-focus-check', '')
      return true
    })
    // Native date inputs expose an internal picker stop that briefly moves
    // focus outside the document before Tab returns to the next app control.
    if (!hasDocumentFocus) continue
    if (options.assertNamedAtEachStep) {
      const focused = page.locator('[data-keyboard-focus-check]')
      await expect(focused).toHaveCount(1)
      await expect(focused).toHaveAccessibleName(/\S/)
    }
    if (await target.evaluate((element) => element === document.activeElement)) {
      await expectVisibleKeyboardFocus(target)
      return
    }
  }
  throw new Error(`Could not reach ${await target.evaluate((element) => element.outerHTML.slice(0, 180))} with ${key}`)
}

export type ContrastOptions = {
  rendersOwnValueSelector?: string
  forbiddenColours?: ReadonlyArray<readonly [number, number, number]>
}

export async function expectRenderedTextContrast(page: Page, options: ContrastOptions = {}): Promise<void> {
  // The default excludes input types that render no text of their own
  // (range/checkbox/radio/color/file): a text-contrast rule applied to a
  // textless control measures the platform's native widget styling, which
  // differs per OS — the hosted Linux runner's native range slider scored
  // 2.92:1 against the pinned 4.5:1 while macOS passed, failing e12-wiring
  // on an element with no rendered text (2026-08-22). accessibility.spec.ts
  // passes its own stricter selector and is unaffected.
  const rendersOwnValueSelector = options.rendersOwnValueSelector
    ?? 'input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="color"]):not([type="file"]), textarea, select'
  const forbiddenColours = options.forbiddenColours ?? []
  const offenders = await page.evaluate(({ rendersOwnValueSelector, forbiddenColours }) => {
    type Colour = [number, number, number, number]
    const parse = (value: string): Colour | null => {
      const channels = value.match(/[\d.]+/g)?.map(Number)
      if (!channels || channels.length < 3) return null
      return [channels[0]!, channels[1]!, channels[2]!, channels[3] ?? 1]
    }
    const composite = (foreground: Colour, background: Colour): Colour => {
      const alpha = foreground[3] + background[3] * (1 - foreground[3])
      if (alpha === 0) return [0, 0, 0, 0]
      return [
        (foreground[0] * foreground[3] + background[0] * background[3] * (1 - foreground[3])) / alpha,
        (foreground[1] * foreground[3] + background[1] * background[3] * (1 - foreground[3])) / alpha,
        (foreground[2] * foreground[3] + background[2] * background[3] * (1 - foreground[3])) / alpha,
        alpha,
      ]
    }
    const luminance = ([red, green, blue]: Colour) => {
      const channel = (value: number) => {
        const normalized = value / 255
        return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
      }
      return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue)
    }
    const background = (element: Element): Colour => {
      const layers: Colour[] = []
      for (let current: Element | null = element; current; current = current.parentElement) {
        const colour = parse(getComputedStyle(current).backgroundColor)
        if (colour && colour[3] > 0) layers.push(colour)
      }
      return layers.reverse().reduce((result, layer) => composite(layer, result), [255, 255, 255, 1] as Colour)
    }

    return [...document.body.querySelectorAll<HTMLElement>('*')].flatMap((element) => {
      const style = getComputedStyle(element)
      const hasOwnText = [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
      const rendersOwnValue = element.matches(rendersOwnValueSelector)
      const rect = element.getBoundingClientRect()
      if ((!hasOwnText && !rendersOwnValue) || rect.width < 2 || rect.height < 2 || style.visibility === 'hidden' || style.display === 'none' || element.matches(':disabled, .pip-visually-hidden')) return []
      const foreground = parse(style.color)
      if (!foreground) return []
      for (const [red, green, blue] of forbiddenColours) {
        if (foreground[0] === red && foreground[1] === green && foreground[2] === blue) {
          return [{ html: element.outerHTML.slice(0, 180), violation: `forbidden text colour ${style.color}` }]
        }
      }
      const backdrop = background(element)
      const renderedForeground = composite(foreground, backdrop)
      const light = luminance(renderedForeground)
      const dark = luminance(backdrop)
      const ratio = (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05)
      const size = Number.parseFloat(style.fontSize)
      const weight = Number.parseInt(style.fontWeight, 10) || 400
      const minimum = size >= 24 || (size >= 18.66 && weight >= 700) ? 3 : 4.5
      return ratio + 0.01 < minimum
        ? [{ html: element.outerHTML.slice(0, 180), violation: `${ratio.toFixed(2)}:1; requires ${minimum}:1` }]
        : []
    })
  }, { rendersOwnValueSelector, forbiddenColours })
  expect(offenders).toEqual([])
}
