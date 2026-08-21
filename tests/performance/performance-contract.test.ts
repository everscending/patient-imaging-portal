import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const files = {
  imaging: 'k6/imaging.js',
  slots: 'k6/slots.js',
  booking: 'k6/booking.js',
  playback: 'e2e/playback-frames.spec.ts',
  baseline: 'docs/performance-baseline.md',
} as const

function source(file: keyof typeof files): string {
  return readFileSync(path.join(REPO_ROOT, files[file]), 'utf8')
}

describe('JOR-221 performance contract', () => {
  test('hardcodedBaseUrlOrBareWellKnownPortIsRejected', () => {
    for (const file of Object.keys(files) as Array<keyof typeof files>) {
      const content = source(file)
      expect(content, file).not.toMatch(/https?:\/\/[^\s"')]+:\d+/)
      for (const port of ['3000', '5432', '5433', '8080']) {
        expect(content, file).not.toMatch(new RegExp(`\\b${port}\\b`))
      }
    }
    for (const file of ['imaging', 'slots', 'booking'] as const) {
      expect(source(file)).toMatch(/__ENV\.BASE_URL[\s\S]*__ENV\.PORT[\s\S]*4310/)
    }
  })

  test('fixedListenPortFixtureIsRejected', () => {
    for (const file of Object.values(files)) {
      expect(readFileSync(path.join(REPO_ROOT, file), 'utf8'), file).not.toMatch(/\.listen\(\s*\d+/)
    }
  })

  test('pf4AndPf6ComeOnlyFromServerTimingLinesWithAtLeastTwentySamples', () => {
    const baseline = source('baseline')
    expect(baseline).toMatch(/PF-4[\s\S]*server timing lines[\s\S]*samples:\s*[2-9]\d/i)
    expect(baseline).toMatch(/PF-6[\s\S]*server timing lines[\s\S]*samples:\s*[2-9]\d/i)
    expect(baseline).toMatch(/PF-4 and PF-6 are never computed from k6 request duration/i)
    expect(source('booking')).not.toMatch(/Trend\([^)]*pf[46]|http_req_duration/i)
  })

  test('bookingLoadIsBoundedAndRetrySafeAcrossRuns', () => {
    const booking = source('booking')
    expect(booking).toMatch(/const RUN_ID = __ENV\.RUN_ID/)
    expect(booking).toMatch(/\^\[0-9a-f\]\{8\}\$/)
    expect(booking).toMatch(/let completed = false[\s\S]*if \(completed\)[\s\S]*completed = true/)
    expect(booking).toMatch(/response\.status === 200 \|\| response\.status === 201/)
    expect(booking).toMatch(/booking\.status === 201[\s\S]*http\.post\(`\$\{BASE_URL\}\/api\/shares`/)
    expect(booking).toMatch(/recipientEmail:[^\n]*RUN_ID[^\n]*__VU/)
  })

  test('imagingMetricsFetchSignedStorageBytesAfterTheManifest', () => {
    const imaging = source('imaging')
    expect(imaging).toMatch(/frames\.length === 100[\s\S]*frames\.every\([^\n]*frame\.available[^\n]*frame\.url/)
    expect(imaging).toMatch(/\/api\/studies\/\$\{study\.id}/)
    expect(imaging).toMatch(/http\.get\(image\.url/)
    expect(imaging).toMatch(/\/clips\/\$\{data\.clip\.id}/)
    expect(imaging).toMatch(/http\.get\(firstFrameTarget\.url/)
    expect(imaging).toMatch(/http\.batch\(remainingFrames/)
  })

  test('playbackReadsManifestDefaultFpsAndTraversesOneHundredIndicesWithoutLiteralDefault', () => {
    const playback = source('playback')
    expect(playback).toMatch(/frameCount[^\n]*100|toHaveLength\(100\)/)
    expect(playback).toMatch(/manifest\.defaultFps/)
    expect(playback).toMatch(/cine-viewer/)
    expect(playback).toMatch(/cine-play/)
    expect(playback).toMatch(/cine-fps/)
    expect(playback).toMatch(/PLAYBACK_LIVE/)
    expect(playback).toMatch(/every\([^\n]*frame\.available[^\n]*frame\.url/)
    expect(playback).toMatch(/naturalWidth[^\n]*> 0/)
    expect(playback).toMatch(/data-playback-ready/)
    expect(playback).not.toMatch(/\b12\b/)
  })

  test('emptyDatasetCannotProduceABaselineAndVirtualUsersRotateAssets', () => {
    const imaging = source('imaging')
    const slots = source('slots')
    expect(imaging).toMatch(/studies\.length[^\n]*0[\s\S]*fail\(/)
    expect(imaging).toMatch(/__VU[\s\S]*studies\.length/)
    expect(slots).toMatch(/slots\.length[^\n]*0[\s\S]*fail\(/)
    expect(source('baseline')).toMatch(/50 patients[\s\S]*10 providers[\s\S]*150 studies[\s\S]*250 cine clips[\s\S]*700 images[\s\S]*16,?000 slots/i)
  })

  test('baselineRecordsEveryRequiredConditionAndWarmPoolCaveat', () => {
    const baseline = source('baseline')
    for (const condition of ['Commit', 'Date', 'Dataset', 'Host', 'VU ramp', 'Duration', 'Run count']) {
      expect(baseline).toMatch(new RegExp(`\\| ${condition} \\|`, 'i'))
    }
    expect(baseline).toMatch(/ADR-0009[\s\S]*warm[\s\S]*pool asset/i)
    expect(baseline).toMatch(/PF-1[\s\S]*PF-2[\s\S]*PF-3[\s\S]*PF-4[\s\S]*PF-5[\s\S]*PF-6/)
  })

  test('pendingOrOutOfTargetMeasurementsCannotPassAsABaseline', () => {
    const baseline = source('baseline')
    expect(baseline).not.toMatch(/\bPending\b/i)
    expect(baseline).toMatch(/\| Commit \| [0-9a-f]{40} \|/)
    expect(baseline).toMatch(/\| Date \| \d{4}-\d{2}-\d{2}T[^|]+Z \|/)

    const limits = new Map([
      ['PF-1', 1_000],
      ['PF-2', 1_000],
      ['PF-3', 5_000],
      ['PF-4', 1_000],
      ['PF-5', 1_000],
      ['PF-6', 1_000],
    ])
    // A row may only exceed its target when tagged "accepted exceedance" —
    // that tag requires the disposition paragraph below (JOR-302/EL-1/T67),
    // so a miss can never slide through silently, only as a disclosed one.
    const rows = [...baseline.matchAll(/^\| (PF-[1-6])[^|]*\|[^|]*\|[^|]*\| ([\d.]+) ms p95(?:; samples: (\d+))?(; accepted exceedance)? \|$/gm)]
    expect(rows).toHaveLength(limits.size)
    const acceptedExceedances: string[] = []
    for (const [, requirement, milliseconds, samples, acceptedTag] of rows) {
      if (acceptedTag) {
        expect(Number(milliseconds), requirement).toBeGreaterThanOrEqual(limits.get(requirement)!)
        acceptedExceedances.push(requirement)
      } else {
        expect(Number(milliseconds), requirement).toBeLessThan(limits.get(requirement)!)
      }
      if (requirement === 'PF-4' || requirement === 'PF-6') {
        expect(Number(samples), `${requirement} server-timing sample count`).toBeGreaterThanOrEqual(20)
      }
    }
    // Only the two pre-elective misses JOR-302 accepted may carry the tag.
    expect(acceptedExceedances.sort()).toEqual(['PF-1', 'PF-3'])
    const disposition = baseline.match(/^## Disposition[\s\S]*?(?=\n## |$(?!\n))/m)?.[0]
    expect(disposition, 'baseline has a "## Disposition" section').toBeDefined()
    expect(disposition).toMatch(/JOR-302/)
    expect(disposition).toMatch(/EL-1/)
    expect(disposition).toMatch(/T67/)
  })

  test('adversarial: an undisclosed miss cannot borrow the accepted-exceedance tag', () => {
    const baseline = source('baseline').replace(
      '| PF-2 cine first frame | p95 < 1.0 s | `pf2_cine_first_frame_ms`: 100-frame manifest plus first signed Storage frame bytes | 707.00 ms p95 |',
      '| PF-2 cine first frame | p95 < 1.0 s | `pf2_cine_first_frame_ms`: 100-frame manifest plus first signed Storage frame bytes | 1707.00 ms p95; accepted exceedance |',
    )
    const rows = [...baseline.matchAll(/^\| (PF-[1-6])[^|]*\|[^|]*\|[^|]*\| ([\d.]+) ms p95(?:; samples: (\d+))?(; accepted exceedance)? \|$/gm)]
    const acceptedExceedances = rows.filter(([, , , , tag]) => tag).map(([, requirement]) => requirement)
    expect(acceptedExceedances.sort()).not.toEqual(['PF-1', 'PF-3'])
  })

  test('gateNamesPerformanceContractAndPlaybackEvidence', () => {
    const loom = readFileSync(path.join(REPO_ROOT, '.loom.yml'), 'utf8')
    const ui = execFileSync(path.join(REPO_ROOT, 'scripts/gate.sh'), ['ui', '--list'], { encoding: 'utf8' })
    // playback-frames.spec.ts runs inside the single combined `product`
    // Playwright invocation (playwright.config.ts's testIgnore excludes only
    // the wiring specs), so only its report validator is a distinct command.
    for (const command of [
      'npx vitest run --project unit tests/performance/performance-contract.test.ts',
      'node scripts/validate-playwright-report.mjs test-results/playwright.json e2e/playback-frames.spec.ts',
    ]) {
      expect(loom).toContain(command)
      expect(ui).toContain(command)
    }
    expect(readFileSync(path.join(REPO_ROOT, 'playwright.config.ts'), 'utf8')).not.toMatch(
      /testIgnore:[^\n]*playback-frames/,
    )
  })
})
