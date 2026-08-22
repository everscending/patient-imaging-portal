// JOR-255 — E13's wiring proof for the EL-1 measured-improvement ticket
// (JOR-249) and the delivery optimisation it measures (JOR-243, ADR-0005).
// This spec introduces no new product scope. docs/el1-benchmark.md is
// JOR-249's committed before-and-after record; tests/performance/
// el1-benchmark-contract.test.ts already guards its internal honesty at the
// logic tier (verdicts follow their numbers, the before column is read from
// the baseline, techniques name modules that exist). This spec confirms, at
// the wiring tier against the RUNNING app, that the benchmark's claims are
// what the live build actually does, and that no Priority-1 criterion paid
// for the speed it records.
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, test } from '@playwright/test'
import type { APIRequestContext, Page, Route } from '@playwright/test'
import {
  E2_FOREIGN_CLIP_ID,
  E2_FOREIGN_REPORT_ID,
  E2_FOREIGN_STUDY_ID,
  E2_PERFORMANCE_CLIP_ID,
  E2_SEEDED_CLIP_ID,
  E2_SEEDED_STUDY_ID,
  E3_MISSING_CINE_FRAME_INDEX,
} from './fixtures/fake-auth-server'
import {
  acquireIdentityFixtureLock,
  IDENTITY_FIXTURE_HOOK_TIMEOUT_MS,
  releaseIdentityFixtureLock,
} from './fixtures/identity-fixture-lock'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const PASSWORD = 'Jor255BenchmarkPassword9'
const SEEDED_PATIENT = { patientRef: 'PT-4471', dateOfBirth: '1988-03-14' }
let identityFixtureLockToken: string | undefined

// The viewer's own fetch for the frame on screen and the `<img>` element
// showing it can coalesce into one extra request (e2e/cine-viewer.spec.ts),
// and the poster may still be settling alongside frame 0 the first time the
// window fills against the real fixture server. Two, not one, keeps the
// bound meaningful without being a false positive on this extra path.
const FRAME_WINDOW_ALLOWANCE = 2

async function source(relativePath: string): Promise<string> {
  return readFile(path.join(REPO_ROOT, relativePath), 'utf8')
}

// The bound the viewer states for itself, read from the component rather
// than copied here — the same technique el1-benchmark-contract.test.ts and
// e2e/cine-viewer.spec.ts use, so this spec cannot drift from either.
function viewerConstant(name: string): number {
  return Number(
    new RegExp(`export const ${name} = (\\d+)`).exec(
      readFileSync(path.join(REPO_ROOT, 'components/imaging/CineViewer.tsx'), 'utf8'),
    )?.[1],
  )
}
const CINE_FRAME_WINDOW = viewerConstant('CINE_FRAME_WINDOW')

async function fakeServerUrl(): Promise<string> {
  const raw = await readFile(path.join(REPO_ROOT, '.local', 'fake-auth-server.json'), 'utf8')
  return (JSON.parse(raw) as { url: string }).url
}

async function resetIdentity(request: APIRequestContext): Promise<void> {
  expect((await request.post(`${await fakeServerUrl()}/__test__/reset-identity`)).ok()).toBe(true)
}

async function registerSignInAndVerify(request: APIRequestContext, label: string): Promise<void> {
  const email = `jor-255-${label}-${randomUUID()}@example.test`
  expect((await request.post('/api/auth/register', { data: { email, password: PASSWORD } })).status()).toBe(201)
  expect((await request.post('/api/auth/login', { data: { email, password: PASSWORD } })).status()).toBe(200)
  expect((await request.post('/api/identity/verify', { data: SEEDED_PATIENT })).status()).toBe(200)
}

/** Intercepts every signed-storage byte fetch (thumbnail, full image, poster
 *  or cine frame) and holds it until released, so which one settled first —
 *  and how many are in flight at once — is directly observable rather than
 *  inferred. Mirrors e2e/cine-viewer.spec.ts's holdFrames, generalised past
 *  frame requests because a real manifest's frame storage keys are hashed
 *  and unpredictable, unlike this fixture's readable image/poster keys. */
function holdSignedObjects(page: Page): {
  started: () => number
  startedUrls: () => string[]
  inFlight: () => number
  release: (match?: (url: string) => boolean) => Promise<void>
} {
  const startedUrls: string[] = []
  const pending: Route[] = []
  void page.route('**/storage/v1/object/sign/phi/**', (route) => {
    startedUrls.push(route.request().url())
    pending.push(route)
  })
  return {
    started: () => startedUrls.length,
    startedUrls: () => [...startedUrls],
    inFlight: () => pending.length,
    release: async (match) => {
      const releasing = match ? pending.filter((route) => match(route.request().url())) : [...pending]
      for (const route of releasing) {
        pending.splice(pending.indexOf(route), 1)
        await route.continue()
      }
    },
  }
}

// ── shared predicates, exercised live below and adversarially further down ─

function assertForeignConcealedAsNotFound(status: number): void {
  expect(status, 'JOR-255: a foreign resource must be concealed as 404, never 403').toBe(404)
  expect(status).not.toBe(403)
}

function assertGapDeclaredByManifestOnly(
  frame: { index: number; available: boolean } | undefined,
  expectedIndex: number,
): void {
  expect(frame, 'JOR-255 EC-2: the gap must come from the manifest, never a failed or slow fetch').toEqual({
    index: expectedIndex,
    available: false,
  })
}

test.describe.serial('JOR-255 E13 live wiring against the running app', () => {
  test.beforeAll(async () => {
    test.setTimeout(IDENTITY_FIXTURE_HOOK_TIMEOUT_MS)
    identityFixtureLockToken = await acquireIdentityFixtureLock()
  })
  test.afterAll(async () => releaseIdentityFixtureLock(identityFixtureLockToken))
  test.beforeEach(async ({ request }) => resetIdentity(request))

  test('acceptance: thumbnail-first render is live — the thumbnail paints while the full image is still on the wire', async ({ page }) => {
    await registerSignInAndVerify(page.request, 'ec3')
    const held = holdSignedObjects(page)
    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('image-viewer')).toBeVisible()
    // Hydration must complete before a held request is released: the native
    // <img> load event does not bubble, and releasing earlier can fire it on
    // a not-yet-hydrated node before React's onLoad listener attaches,
    // losing the event (see e2e/image-viewer.spec.ts's openViewer, which
    // waits on this same attribute before its own throttled-image test).
    await expect(page.getByTestId('image-viewer')).toHaveAttribute('data-hydrated', 'true', { timeout: 15_000 })
    await expect.poll(() => held.startedUrls().some((url) => url.includes('full-1.png'))).toBe(true)
    await held.release((url) => url.includes('thumb-1.png'))

    const thumbnail = page.getByTestId('image-thumbnail')
    await expect
      .poll(() => thumbnail.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0))
      .toBe(true)
    expect(held.inFlight(), 'the full image request must still be pending while the thumbnail is already painted').toBeGreaterThan(0)

    await held.release()
    await expect(page.getByTestId('image-full')).toHaveCSS('opacity', '1')
    await expect(page.getByTestId('image-thumbnail')).toHaveCount(0)
  })

  test('acceptance: the cine poster paints before frame 0 arrives', async ({ page }) => {
    await registerSignInAndVerify(page.request, 'poster')
    const held = holdSignedObjects(page)
    // E2_SEEDED_CLIP_ID carries EL-1's poster derivative; E2_PERFORMANCE_CLIP_ID
    // does not, so the poster path is exercised here and the window bound below.
    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('cine-viewer')).toBeVisible()
    await expect.poll(() => held.startedUrls().some((url) => url.includes('poster-1.png'))).toBe(true)
    await held.release((url) => url.includes('poster-1.png'))

    const poster = page.getByTestId('cine-poster')
    await expect(poster).toBeVisible()
    await expect
      .poll(() => poster.evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0))
      .toBe(true)
    expect(held.inFlight(), 'a frame byte request must still be pending while the poster is already shown').toBeGreaterThan(0)

    // Drains the rest of the clip in windowed rounds (E2_SEEDED_CLIP_ID keeps
    // its EC-2 gap at frame 42, so only 99 of the 100 frames ever fetch, plus
    // the one poster request already released above) — proving the poster
    // handed off cleanly into ordinary bounded-window playback, not just
    // that it painted once.
    for (let round = 0; round < 40 && held.inFlight() > 0; round++) {
      await held.release()
      await page.waitForTimeout(50)
    }
    await expect(page.getByTestId('cine-viewer')).toHaveAttribute('data-playback-ready', 'true', { timeout: 30_000 })
    expect(held.started()).toBe(100)
  })

  test('acceptance: the documented CINE_FRAME_WINDOW bounds live in-flight frame requests, never the whole 100-frame clip', async ({ page }) => {
    await registerSignInAndVerify(page.request, 'window')
    expect(CINE_FRAME_WINDOW).toBeGreaterThan(0)
    expect(CINE_FRAME_WINDOW).toBeLessThan(100)
    const held = holdSignedObjects(page)

    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_PERFORMANCE_CLIP_ID}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('cine-viewer')).toBeVisible()

    await expect.poll(held.started, { timeout: 15_000 }).toBeGreaterThan(0)
    expect(held.inFlight()).toBeLessThanOrEqual(1 + FRAME_WINDOW_ALLOWANCE)

    await held.release()
    await expect.poll(held.inFlight, { timeout: 15_000 }).toBeGreaterThan(1)
    expect(held.inFlight()).toBeLessThanOrEqual(CINE_FRAME_WINDOW + FRAME_WINDOW_ALLOWANCE)
    expect(held.started()).toBeLessThan(100)

    for (let round = 0; round < 60 && held.started() < 100; round++) {
      await held.release()
      await page.waitForTimeout(50)
      expect(held.inFlight()).toBeLessThanOrEqual(CINE_FRAME_WINDOW + FRAME_WINDOW_ALLOWANCE)
    }
    expect(held.started()).toBe(100)
    await held.release()
    await expect(page.getByTestId('cine-viewer')).toHaveAttribute('data-playback-ready', 'true', { timeout: 30_000 })
  })

  // Re-asserts e2e/el1-regression.spec.ts's key denial (FR-6) and gap (EC-2)
  // criteria directly against the live app. It deliberately does not re-run
  // the other eight — el1-regression.spec.ts is registered in the gate (see
  // the wiring-contracts block below) and runs there in full; duplicating it
  // here would be the honest-assertion violation this ticket is checking for.
  test('acceptance: key Priority-1 denial (FR-6) and gap (EC-2) criteria hold live', async ({ page }) => {
    await registerSignInAndVerify(page.request, 'p1')

    for (const url of [
      `/api/studies/${E2_FOREIGN_STUDY_ID}`,
      `/api/studies/${E2_FOREIGN_STUDY_ID}/clips/${E2_FOREIGN_CLIP_ID}`,
      `/api/reports/${E2_FOREIGN_REPORT_ID}`,
    ]) {
      assertForeignConcealedAsNotFound((await page.request.get(url)).status())
    }

    const manifestResponse = await page.request.get(`/api/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`)
    expect(manifestResponse.status()).toBe(200)
    const payload = (await manifestResponse.json()) as { frames: Array<{ index: number; available: boolean }> }
    assertGapDeclaredByManifestOnly(payload.frames[E3_MISSING_CINE_FRAME_INDEX], E3_MISSING_CINE_FRAME_INDEX)

    await page.goto(`/studies/${E2_SEEDED_STUDY_ID}/clips/${E2_SEEDED_CLIP_ID}`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByTestId('cine-viewer')).toBeVisible()
    await page.getByRole('slider', { name: 'Frame scrubber' }).fill(String(E3_MISSING_CINE_FRAME_INDEX))
    await expect(page.getByTestId('cine-frame-gap')).toHaveText(`Frame ${E3_MISSING_CINE_FRAME_INDEX} unavailable`)
  })
})

test.describe('JOR-255 E13 wiring contracts', () => {
  const files = { benchmark: 'docs/el1-benchmark.md', baseline: 'docs/performance-baseline.md' } as const

  // Mirrors tests/performance/el1-benchmark-contract.test.ts's parsing —
  // this file does not re-verify the logic that test already owns (before
  // read from the baseline, verdicts honest, techniques implemented); it
  // only needs enough of the same shape to state its own wiring predicates.
  function condition(document: string, name: string): string | undefined {
    return new RegExp(`^\\| ${name} \\| (.+) \\|$`, 'mi').exec(document)?.[1]?.trim()
  }

  const AFTER_ROW = /^\| (PF-[1-3])[^|]*\| p95 < [\d.]+ s \| ([\d.]+) ms p95 \| [\d.]+ ms p95 \| [\d.]+ ms p95 \| (met|missed|unstable) \|$/gm

  function resultRows(document: string): Array<{ requirement: string; before: number; verdict: string }> {
    return [...document.matchAll(AFTER_ROW)].map(([, requirement, before, verdict]) => ({
      requirement: requirement!,
      before: Number(before),
      verdict: verdict!,
    }))
  }

  function hasBothColumns(document: string): boolean {
    const rows = resultRows(document)
    return /^\| Requirement \| Target \| Before \| After run 1 \| After run 2 \| Verdict \|$/m.test(document)
      && rows.length === 3
      && rows.every((row) => Number.isFinite(row.before))
  }

  function sharedConditions(document: string, baseline: string): boolean {
    return ['VU ramp', 'Dataset'].every((name) => condition(document, name) === condition(baseline, name))
      && ['Host', 'Duration'].every((name) => {
        const stated = condition(document, name)
        return Boolean(stated) && (condition(baseline, name) ?? '').includes(stated!)
      })
  }

  function techniquesNotePresent(document: string): boolean {
    return [...document.matchAll(/^\| [^|]+ \| ((?:`[^`]+`(?:, )?)+) \| [^|]+ \|$/gm)].length >= 4
  }

  function disposed(document: string): boolean {
    const unmet = resultRows(document).filter((row) => row.verdict !== 'met')
    if (unmet.length === 0) return true
    const disposition = /^## Disposition[\s\S]*?(?=\n## |$(?!\n))/m.exec(document)?.[0]
    return Boolean(disposition)
      && unmet.every((row) => disposition!.includes(row.requirement))
      && /human-accepted/i.test(disposition!)
      && /JOR-235/.test(disposition!)
  }

  // Built at runtime so this file's own words never trip its own scan —
  // mirrors tests/imaging/el1-delivery-contracts.test.ts's cut-elective list.
  const cutFeatureTerms = ['wait' + 'list', 'auto' + 'fill', 'recurr', 'insurance', 'intake', 'natural' + 'Language', 'utterance']
  const cutFeature = new RegExp(cutFeatureTerms.join('|'), 'i')
  function noCutElective(document: string): boolean {
    return !cutFeature.test(document)
  }

  function regressionRegisteredInGate(loom: string, gate: string): boolean {
    const validator = 'node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/el1-regression.spec.ts'
    return loom.includes(validator) && gate.includes(validator)
  }

  test('acceptance: the committed benchmark carries both columns, matches the baseline conditions, states its techniques, disposes every unmet row, and names no cut elective', async () => {
    const [benchmark, baseline] = await Promise.all([source(files.benchmark), source(files.baseline)])
    expect(hasBothColumns(benchmark), 'benchmark must carry both a Before and an After column').toBe(true)
    expect(sharedConditions(benchmark, baseline), 'benchmark conditions must match the baseline').toBe(true)
    expect(techniquesNotePresent(benchmark), 'benchmark must state its techniques').toBe(true)
    // PF-3 is committed as `unstable` with a human-accepted Disposition —
    // JOR-235 is its final authority. That is the legitimate committed
    // state, not a gate failure to be second-guessed here.
    expect(disposed(benchmark), 'every non-met row must be named in an accepted disposition').toBe(true)
    expect(noCutElective(benchmark), 'benchmark must not claim a cut elective').toBe(true)
  })

  test('acceptance: the Priority-1 regression spec is registered in the gate, not just present on disk', () => {
    const loom = readFileSync(path.join(REPO_ROOT, '.loom.yml'), 'utf8')
    const gate = readFileSync(path.join(REPO_ROOT, 'scripts/gate.sh'), 'utf8')
    expect(regressionRegisteredInGate(loom, gate)).toBe(true)
  })

  test('mandatory adversarial: a benchmark missing entirely, or missing its Before column, fails the wiring pass', async () => {
    expect(hasBothColumns('')).toBe(false)

    const benchmark = await source(files.benchmark)
    const beforeStripped = benchmark
      .replace(
        /^\| Requirement \| Target \| Before \| After run 1 \| After run 2 \| Verdict \|$/m,
        '| Requirement | Target | After run 1 | After run 2 | Verdict |',
      )
      .replace(/^(\| PF-[1-3][^|]*\| p95 < [\d.]+ s )\| [\d.]+ ms p95 /gm, '$1')
    expect(hasBothColumns(beforeStripped), 'a benchmark stripped of its Before column must be rejected').toBe(false)
  })

  test('mandatory adversarial: a benchmark with its techniques note stripped fails the wiring pass', async () => {
    const benchmark = await source(files.benchmark)
    expect(techniquesNotePresent(benchmark)).toBe(true)
    const withoutTechniques = benchmark.replace(/^## Techniques[\s\S]*?(?=\n## )/m, '')
    expect(withoutTechniques, 'the Techniques section was actually removed').not.toBe(benchmark)
    expect(techniquesNotePresent(withoutTechniques), 'a benchmark missing its techniques note must be rejected').toBe(false)
  })

  test('mandatory adversarial: a P1 criterion failing fails the wiring pass', () => {
    expect(() => assertForeignConcealedAsNotFound(403)).toThrow()
    expect(() => assertGapDeclaredByManifestOnly({ index: 42, available: true }, 42)).toThrow()
    expect(() => assertGapDeclaredByManifestOnly(undefined, 42)).toThrow()
  })

  test('mandatory adversarial: benchmark conditions that differ from the baseline fail the wiring pass', async () => {
    const [benchmark, baseline] = await Promise.all([source(files.benchmark), source(files.baseline)])
    expect(sharedConditions(benchmark, baseline)).toBe(true)

    for (const tampered of [
      benchmark.replace(/^\| VU ramp \| .+$/m, '| VU ramp | 10 s to 20 VUs, 40 s to 200 VUs, 10 s down to 0 |'),
      benchmark.replace(/^\| Duration \| .+$/m, '| Duration | 15 s |'),
      benchmark.replace(/^\| Dataset \| .+$/m, '| Dataset | one study, one clip, ten frames |'),
      benchmark.replace(/^\| Host \| .+$/m, '| Host | a local production build on a laptop |'),
    ]) {
      expect(sharedConditions(tampered, baseline), 'an after run at other conditions must be rejected').toBe(false)
    }
  })

  test('mandatory adversarial: any cut elective present fails the wiring pass', async () => {
    const benchmark = await source(files.benchmark)
    expect(noCutElective(benchmark)).toBe(true)
    for (const tampered of [
      `${benchmark}\nA patient can join a waitlist and auto-fill a cancelled slot.\n`,
      `${benchmark}\nRecurring appointments are now supported.\n`,
      `${benchmark}\nNatural-language booking accepts an utterance and books the slot.\n`,
    ]) {
      expect(noCutElective(tampered), 'a benchmark claiming a cut elective must be rejected').toBe(false)
    }
  })
})
