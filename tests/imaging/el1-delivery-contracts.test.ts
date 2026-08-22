// tests/imaging/el1-delivery-contracts.test.ts — the static half of EL-1's
// mandatory adversarial coverage (JOR-243, ADR-0005). EL-1 is an optimisation
// layer on ADR-0003's delivery model, so the things most worth guarding are
// the ones an optimisation is tempted to bend: a viewer's pinned props, a
// second signed-URL minter, a TTL written by hand, a PHI response marked
// cacheable, a colour typed in as hex, and a cut elective sneaking back in.
// Each test below states the property, then proves the scan discriminates by
// running it against a deliberately broken sample.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()

const VIEWER_FILES = [
  'components/imaging/ImageViewer.tsx',
  'components/imaging/CineViewer.tsx',
  'components/imaging/Filmstrip.tsx',
  'components/imaging/CineControls.tsx',
]

function source(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: REPO_ROOT })
    .toString()
    .trim()
    .split('\n')
    .filter(Boolean)
}

/** The `name:` / `name?:` members of a type block, by nesting depth. */
function members(block: string, depth: number): { required: string[]; optional: string[] } {
  const indent = ' '.repeat(2 * depth)
  const required: string[] = []
  const optional: string[] = []
  for (const line of block.split('\n')) {
    if (!line.startsWith(indent) || line.startsWith(`${indent} `)) continue
    // Members are written one per line, or several separated by semicolons.
    // A line that opens an inline object declares one member whose own
    // members belong to the nesting inside it, not to this level.
    const segments = line.includes('{') ? [line.trim()] : line.trim().split(';')
    for (const segment of segments) {
      const match = /^(\w+)(\??):/.exec(segment.trim())
      if (!match) continue
      ;(match[2] === '?' ? optional : required).push(match[1])
    }
  }
  return { required: required.sort(), optional: optional.sort() }
}

function typeBlock(file: string, name: string): string {
  const contents = source(file)
  const start = contents.indexOf(`export type ${name} = {`)
  expect(start, `${file} declares ${name}`).toBeGreaterThan(-1)
  const end = contents.indexOf('\n}\n', start)
  return contents.slice(start, end)
}

describe('mandatory adversarial: EL-1 never adds a required prop to a pinned viewer', () => {
  test('imageViewerPropsKeepExactlyTheirPinnedRequiredMembers', function imageViewerPropsKeepExactlyTheirPinnedRequiredMembers() {
    const block = typeBlock('components/imaging/ImageViewer.tsx', 'ImageViewerProps')

    expect(members(block, 1)).toEqual({
      required: ['images', 'variant'],
      optional: ['initialImageId', 'shareLinkTtlHours'].concat('signingFailed').sort(),
    })
    // The pinned per-image shape, thumbUrl included — a viewer that made any
    // of these optional would be reading a manifest this build never sends.
    expect(members(block, 2).required).toEqual(['expiresAt', 'height', 'id', 'ordinal', 'thumbUrl', 'url', 'width'])
    expect(members(block, 2).optional).toEqual([])
  })

  test('cineViewerPropsKeepExactlyTheirPinnedRequiredMembers', function cineViewerPropsKeepExactlyTheirPinnedRequiredMembers() {
    const block = typeBlock('components/imaging/CineViewer.tsx', 'CineViewerProps')

    expect(members(block, 1)).toEqual({ required: ['clip'], optional: [] })
    expect(members(block, 2)).toEqual({
      required: ['defaultFps', 'expiresAt', 'frameCount', 'frames', 'id'],
      // EL-1's poster is additive: a manifest without one still renders.
      optional: ['posterUrl'],
    })
  })

  test('adversarial: a newly required prop is caught, an optional one is not', function adversarialRequiredPropIsCaught() {
    const pinned = { required: ['clip'], optional: [] as string[] }
    const withRequired = 'export type CineViewerProps = {\n  clip: Clip\n  prefetchWindow: number\n'
    const withOptional = 'export type CineViewerProps = {\n  clip: Clip\n  prefetchWindow?: number\n'

    expect(members(withRequired, 1)).not.toEqual(pinned)
    expect(members(withOptional, 1)).toEqual({ required: ['clip'], optional: ['prefetchWindow'] })
  })
})

describe('mandatory adversarial: no signed URL is minted, and no TTL written, outside lib/imaging/signing.ts', () => {
  // The minting scan itself lives in tests/imaging/signing.test.ts
  // (onlySigningModuleInTreeCallsCreateSignedUrls). This adds the surfaces
  // EL-1 touches: a viewer that assembled a storage URL, or a component or
  // seed file that wrote its own expiry, would both be invisible to a scan
  // that only looked for the Storage SDK call.
  const ttlSeconds = 300
  // The seconds on their own, never as part of a longer token — a design
  // token named base-300 is a colour, not an expiry.
  const ttlLiteral = new RegExp(`(?<![\\w-])${ttlSeconds}(?![\\w-])`)
  const storageUrl = /storage\/v1|object\/sign|createSigned/i

  test('viewersAndSeedNeverBuildAStorageUrlOrNameATtl', function viewersAndSeedNeverBuildAStorageUrlOrNameATtl() {
    for (const file of [...VIEWER_FILES, 'db/seed/assets.ts', 'db/seed/rows.ts']) {
      expect(source(file), `${file} must not assemble a storage URL`).not.toMatch(storageUrl)
    }
    // The TTL belongs to signed URLs, so the scan covers the files that
    // handle them; db/seed/rows.ts counts days, not seconds.
    for (const file of VIEWER_FILES) {
      const codeOnly = source(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      expect(codeOnly, `${file} must not write a TTL literal`).not.toMatch(ttlLiteral)
      expect(codeOnly, `${file} must not compute an expiry`).not.toMatch(/expiresIn|signedUrlTtl/)
    }
  })

  test('adversarial: a hand-written TTL and a hand-built storage URL are both caught', function adversarialHandWrittenTtlAndUrlCaught() {
    const mutant = `const url = '/storage/v1/object/sign/phi/' + key\nconst ttl = ${ttlSeconds}\n`
    expect(mutant).toMatch(storageUrl)
    expect(mutant).toMatch(ttlLiteral)
    expect('background: var(--pip-color-base-300)').not.toMatch(ttlLiteral)
  })
})

describe('mandatory adversarial: no PHI-bearing response is marked publicly cacheable', () => {
  // EL-1 caches storage objects, never PHI responses. A `public` or shared
  // max-age directive on any PHI route or PHI page would put a patient's
  // manifest in a shared cache, which no amount of speed would justify.
  const publiclyCacheable = /cache-control['"\s:,]*[^\n]*\b(public|s-maxage|stale-while-revalidate)\b/i

  test('noPhiRouteOrPageDeclaresAPublicCacheDirective', function noPhiRouteOrPageDeclaresAPublicCacheDirective() {
    const candidates = trackedFiles().filter(
      (file) =>
        (file.startsWith('app/') && (file.endsWith('.ts') || file.endsWith('.tsx'))) ||
        file === 'next.config.ts' ||
        file === 'vercel.json' ||
        file === 'middleware.ts',
    )
    expect(candidates.length).toBeGreaterThan(0)

    for (const file of candidates) {
      expect(source(file), `${file} must not mark a response publicly cacheable`).not.toMatch(publiclyCacheable)
    }
  })

  test('adversarial: a public cache directive on a PHI route is caught', function adversarialPublicCacheDirectiveCaught() {
    expect("headers.set('Cache-Control', 'public, max-age=600')").toMatch(publiclyCacheable)
    expect("{ key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, private' }").not.toMatch(publiclyCacheable)
  })
})

describe('mandatory adversarial: a viewer never carries a hex colour literal', () => {
  const hexLiteral = /#[0-9a-fA-F]{3,8}\b/

  test('everyViewerUsesDesignTokensOnly', function everyViewerUsesDesignTokensOnly() {
    for (const file of VIEWER_FILES) {
      expect(source(file), `${file} must use tokens, never a hex literal`).not.toMatch(hexLiteral)
      expect(source(file)).toMatch(/var\(--pip-color-/)
    }
  })

  test('adversarial: a hex literal added to a viewer is caught', function adversarialHexLiteralCaught() {
    expect('.cine-viewer__poster { filter: blur(1px); background: #0b0b0b; }').toMatch(hexLiteral)
  })
})

describe('mandatory adversarial: no cut elective is built (ADR-0005)', () => {
  // EL-2 waitlist/auto-fill, EL-3 recurring appointments, EL-4 intake capture
  // and EL-5 natural-language booking are cut. Built at runtime so this
  // file's own words never trip its own scan.
  const cutFeatureTerms = ['wait' + 'list', 'auto' + 'fill', 'recurr', 'insurance', 'intake', 'natural' + 'Language', 'utterance']
  const cutFeature = new RegExp(cutFeatureTerms.join('|'), 'i')

  test('noProductCodePathImplementsACutElective', function noProductCodePathImplementsACutElective() {
    const candidates = trackedFiles().filter(
      (file) =>
        /^(app|components|lib|db|k6|scripts)\//.test(file) &&
        (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.sql') || file.endsWith('.js')),
    )
    expect(candidates.length).toBeGreaterThan(0)

    for (const file of candidates) {
      expect(source(file), `${file} must not implement a cut elective`).not.toMatch(cutFeature)
    }
  })

  test('adversarial: a cut elective reappearing in product code is caught', function adversarialCutElectiveCaught() {
    expect('export async function joinWaitlist(slotId: string) {}').toMatch(cutFeature)
    expect('export async function prefetchNextFrame(index: number) {}').not.toMatch(cutFeature)
  })
})
