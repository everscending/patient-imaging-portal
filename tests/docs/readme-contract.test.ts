// tests/docs/readme-contract.test.ts — JOR-258's own mandatory-adversarial
// suite for the root README. Every check below is a pure function of README
// text (plus, where the ticket requires cross-checking, the document it must
// agree with) so each one can be run both against the real README — proving
// it passes — and against a deliberately broken fixture — proving the check
// actually catches what it claims to catch. Mirrors db/seed/rows.ts's own
// validator-plus-adversarial-test shape.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

import { DEMO_ACCOUNT_EMAILS, DEMO_ACCOUNT_PASSWORD, DEMO_MAIL_DOMAIN } from '../../db/seed/rows'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const README_PATH = path.join(REPO_ROOT, 'README.md')
const README = readFileSync(README_PATH, 'utf8')
const CONFIG_SOURCE = readFileSync(path.join(REPO_ROOT, 'lib', 'config.ts'), 'utf8')
const CONTEXT = readFileSync(path.join(REPO_ROOT, 'CONTEXT.md'), 'utf8')
const PERFORMANCE_BASELINE = readFileSync(path.join(REPO_ROOT, 'docs', 'performance-baseline.md'), 'utf8')
const EL1_BENCHMARK = readFileSync(path.join(REPO_ROOT, 'docs', 'el1-benchmark.md'), 'utf8')

function section(markdown: string, heading: string): string {
  const lines = markdown.split('\n')
  const start = lines.findIndex((l) => l.trim() === heading)
  if (start === -1) throw new Error(`readme-contract fixture: heading not found: ${heading}`)
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i
      break
    }
  }
  return lines.slice(start, end).join('\n')
}

// ── 1. secret or real credential ───────────────────────────────────────────
const REAL_SUPABASE_PROJECT_REF = 'dyvbopxzwkavhggawedt' // docs/deploy.md's real project ref

export function containsSecretOrRealCredential(content: string): boolean {
  return (
    /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(content) || // a JWT
    /\$2[aby]\$\d{2}\$/.test(content) || // a bcrypt hash
    content.includes(REAL_SUPABASE_PROJECT_REF) ||
    /sk-[A-Za-z0-9]{20,}/.test(content)
  )
}

describe('mandatory adversarial: secret or real credential in the README', () => {
  test('the real README carries none', () => {
    expect(containsSecretOrRealCredential(README)).toBe(false)
  })

  test('adversarial: a real Supabase project ref is caught', () => {
    expect(containsSecretOrRealCredential(`connect to https://${REAL_SUPABASE_PROJECT_REF}.supabase.co`)).toBe(true)
  })

  test('adversarial: a JWT-shaped string is caught', () => {
    expect(
      containsSecretOrRealCredential('SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.abcdefghijklmnopqrstuvwxyz'),
    ).toBe(true)
  })
})

// ── 2. a stated parameter disagreeing with lib/config.ts ───────────────────
const STATED_PARAMETER_ENV_KEYS = [
  'SHARE_LINK_TTL_HOURS',
  'MIN_CHANGE_NOTICE_HOURS',
  'REMINDER_LEAD_HOURS',
  'IDENTITY_MAX_ATTEMPTS',
  'IDENTITY_LOCKOUT_MINUTES',
  'SIGNED_URL_TTL_SECONDS',
] as const

export function configDefault(configSource: string, envKey: string): number {
  const match = configSource.match(new RegExp(`intWithDefault\\('${envKey}',\\s*(\\d+)\\)`))
  if (!match) throw new Error(`readme-contract: lib/config.ts has no intWithDefault default for ${envKey}`)
  return Number(match[1])
}

export function readmeStatedValue(readmeContent: string, envKey: string): number {
  const match = readmeContent.match(new RegExp('`' + envKey + '` \\| (\\d+) \\|'))
  if (!match) throw new Error(`readme-contract: README has no stated-parameters row for ${envKey}`)
  return Number(match[1])
}

describe('mandatory adversarial: a stated parameter disagreeing with lib/config.ts', () => {
  test.each(STATED_PARAMETER_ENV_KEYS)('%s: README value matches lib/config.ts default', (envKey) => {
    expect(readmeStatedValue(README, envKey)).toBe(configDefault(CONFIG_SOURCE, envKey))
  })

  test('adversarial: a README stating the wrong default disagrees with lib/config.ts', () => {
    const wrongReadme = README.replace('`SHARE_LINK_TTL_HOURS` | 48 |', '`SHARE_LINK_TTL_HOURS` | 47 |')
    expect(readmeStatedValue(wrongReadme, 'SHARE_LINK_TTL_HOURS')).not.toBe(configDefault(CONFIG_SOURCE, 'SHARE_LINK_TTL_HOURS'))
  })
})

// ── 3. a HIPAA-compliance / certification / executed-BAA claim (CUT-4) ─────
export function containsComplianceOverclaim(content: string): boolean {
  return (
    /HIPAA[\s-]*(certified|compliant|certification|compliance)/i.test(content) ||
    /\b(is|are|has been|have been)\s+(HIPAA\s+)?certified\b/i.test(content) ||
    /executed\s+(a|the|its)?\s*BAA/i.test(content) ||
    /BAA\s+(has been|have been|is)\s+executed/i.test(content)
  )
}

describe('mandatory adversarial: a HIPAA-compliance, certification, or executed-BAA claim', () => {
  test('the real README makes no such claim', () => {
    expect(containsComplianceOverclaim(README)).toBe(false)
  })

  test.each([
    'This application is HIPAA compliant.',
    'The team is HIPAA certified for this build.',
    'We have executed a BAA with every vendor.',
    'A BAA has been executed with Supabase.',
  ])('adversarial: %s is caught', (claim) => {
    expect(containsComplianceOverclaim(claim)).toBe(true)
  })
})

// ── 4. the BAA vendor list missing the storage vendor ───────────────────────
export function baaListNamesStorageVendorVercelAndResend(content: string): boolean {
  const baa = section(content, '## Business Associate Agreement (BAA) disclosure')
  return /Supabase[^\n]*Storage/.test(baa) && /Vercel/.test(baa) && /Resend/.test(baa)
}

describe('mandatory adversarial: the BAA list missing the storage vendor', () => {
  test('the real README names Supabase Storage, Vercel, and Resend', () => {
    expect(baaListNamesStorageVendorVercelAndResend(README)).toBe(true)
  })

  test('adversarial: a BAA section naming Supabase only for data, never Storage, is caught', () => {
    const broken = README.replace(
      '- **Supabase** — Postgres (data), **Storage** (images, cine clips, and\n  frames), and Auth (accounts and sessions).\n',
      '- **Supabase** — Postgres (data) and Auth (accounts and sessions).\n',
    )
    expect(baaListNamesStorageVendorVercelAndResend(broken)).toBe(false)
  })
})

// ── 5. a performance number with no committed measurement file behind it ───
export function performanceNumbersAreTraceable(readmeContent: string, evidence: string): { untraceable: string[] } {
  const performanceSection = section(readmeContent, '## Performance')
  const numbers = [...performanceSection.matchAll(/[\d,]+\.\d+ ms/g)].map((m) => m[0])
  return { untraceable: numbers.filter((n) => !evidence.includes(n)) }
}

describe('mandatory adversarial: a performance number with no committed measurement file behind it', () => {
  const evidence = `${PERFORMANCE_BASELINE}\n${EL1_BENCHMARK}`

  test('every ms figure in the README Performance section traces to a committed measurement file', () => {
    expect(performanceNumbersAreTraceable(README, evidence).untraceable).toEqual([])
  })

  test('adversarial: a fabricated figure with no committed measurement behind it is caught', () => {
    const fabricated = `## Performance\n\n- PF-1 single image: 999.99 ms p95, invented for this test.\n`
    expect(performanceNumbersAreTraceable(fabricated, evidence).untraceable).toEqual(['999.99 ms'])
  })
})

// ── 6. a missing residue ────────────────────────────────────────────────────
const REQUIRED_RESIDUE_MARKERS = [
  /signed URLs outlive revocation/i,
  /audit granularity is the access grant/i,
  /shared pool assets warm caches/i,
  /password hashing is delegated to Supabase Auth/i,
]

export function missingResidues(content: string): RegExp[] {
  const residues = section(content, '## Known residues')
  return REQUIRED_RESIDUE_MARKERS.filter((marker) => !marker.test(residues))
}

describe('mandatory adversarial: a missing residue', () => {
  test('the real README states all four residues', () => {
    expect(missingResidues(README)).toEqual([])
  })

  test('adversarial: a Known residues section missing one entry is caught', () => {
    const broken = README.replace(
      /4\. \*\*Password hashing is delegated to Supabase Auth\*\*[\s\S]*?`ADR-0004`\)\.\n/,
      '',
    )
    expect(missingResidues(broken)).toHaveLength(1)
  })
})

// ── 7. a demo credential not in the seeded data ─────────────────────────────
export function unseededDemoCredentials(content: string): { emails: string[]; badPassword: boolean } {
  const mentionedEmails = [...content.matchAll(new RegExp(`[a-z0-9._%+-]+@${DEMO_MAIL_DOMAIN}`, 'gi'))].map((m) => m[0])
  const emails = mentionedEmails.filter((email) => !(DEMO_ACCOUNT_EMAILS as readonly string[]).includes(email))
  const badPassword = !content.includes(DEMO_ACCOUNT_PASSWORD)
  return { emails, badPassword }
}

describe('mandatory adversarial: a demo credential not in the seeded data', () => {
  test('every demo address and the demo password in the README are seeded', () => {
    const result = unseededDemoCredentials(README)
    expect(result.emails).toEqual([])
    expect(result.badPassword).toBe(false)
  })

  test('adversarial: an invented demo address is caught', () => {
    const result = unseededDemoCredentials(`sign in as nurse@${DEMO_MAIL_DOMAIN} / ${DEMO_ACCOUNT_PASSWORD}`)
    expect(result.emails).toEqual([`nurse@${DEMO_MAIL_DOMAIN}`])
  })
})

// ── 8. quick start omitting the concurrency or leakage test ────────────────
export function quickStartCoversConcurrencyAndLeakage(content: string): { concurrency: boolean; leakage: boolean } {
  const quickStart = section(content, '## Grader quick start')
  return {
    concurrency: quickStart.includes('tests/scheduling/booking-concurrency.test.ts'),
    leakage: quickStart.includes('tests/adversarial/cross-patient.test.ts'),
  }
}

describe('mandatory adversarial: quick start omitting the concurrency or leakage test', () => {
  test('the real quick start names both suites', () => {
    const result = quickStartCoversConcurrencyAndLeakage(README)
    expect(result.concurrency).toBe(true)
    expect(result.leakage).toBe(true)
  })

  test('adversarial: a quick start silent on the leakage test is caught', () => {
    const broken = README.replace(/tests\/adversarial\/cross-patient\.test\.ts/g, '')
    expect(quickStartCoversConcurrencyAndLeakage(broken).leakage).toBe(false)
  })
})

// ── 9. a words-we-avoid term present ────────────────────────────────────────
// A curated subset of CONTEXT.md's "words we avoid" table: terms with no
// legitimate use anywhere in this README, so a whole-word or fixed-phrase
// match cannot false-positive against an approved term used correctly
// elsewhere (e.g. "session" in "session JWT", or "verify" in "identity
// verification", both stay out of this list because CONTEXT.md scopes their
// ban to a different context this README does not use them in).
const BANNED_WORDS = ['photo', 'picture', 'snapshot', 'video', 'movie', 'PII', 'DICOM', 'PACS', 'finalized', 'reservation']
const BANNED_PHRASES = ['cancel the share link', 'cancel a share link', 'delete the share link', 'delete a share link', 'available slot', 'slot is available']

// The Vocabulary section's whole job — like CONTEXT.md's own "words we
// avoid" table — is to name a banned term as the contrast to the approved
// one ("signed, never finalized"). That naming is the compliant use CONTEXT.md
// itself asks for (ticket JOR-258, item 11), so it is excluded from the scan;
// a banned term anywhere else in the README is not naming-for-contrast.
function withoutVocabularySection(content: string): string {
  return content.replace(section(content, '## Vocabulary'), '')
}

export function wordsWeAvoidPresent(content: string): string[] {
  const scanned = content.includes('## Vocabulary') ? withoutVocabularySection(content) : content
  const hits: string[] = []
  for (const word of BANNED_WORDS) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(scanned)) hits.push(word)
  }
  for (const phrase of BANNED_PHRASES) {
    if (scanned.toLowerCase().includes(phrase)) hits.push(phrase)
  }
  return hits
}

describe('mandatory adversarial: a words-we-avoid term present', () => {
  test('fixture sanity: every banned word/phrase here is drawn from CONTEXT.md', () => {
    expect(CONTEXT).toMatch(/Words we avoid/)
  })

  test('the real README uses none of the banned terms', () => {
    expect(wordsWeAvoidPresent(README)).toEqual([])
  })

  test.each(['a video of the cine clip', 'please cancel the share link', 'this domain treats PII carefully'])(
    'adversarial: %s is caught',
    (bad) => {
      expect(wordsWeAvoidPresent(bad).length).toBeGreaterThan(0)
    },
  )
})
