import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const DOCS_DIR = path.join(REPO_ROOT, 'docs')
const README_PATH = path.join(DOCS_DIR, 'README.md')
const content = readFileSync(README_PATH, 'utf8')

function markdownLinkTargets(markdown: string): string[] {
  const matches = markdown.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)
  return [...matches].map((m) => m[1])
}

// Every real document under docs/ (adr/ and agents/), excluding docs/README.md
// itself and non-document artifacts like .DS_Store.
function committedDocs(): string[] {
  const output = execFileSync('git', ['ls-files', '--', 'docs'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  return output
    .trim()
    .split('\n')
    .filter((file) => file.endsWith('.md'))
    .filter((file) => file !== 'docs/README.md')
}

describe('docs/README.md — acceptance + adversarial: every link resolves', () => {
  const targets = markdownLinkTargets(content)

  test('has at least one link', () => {
    expect(targets.length).toBeGreaterThan(0)
  })

  test.each(targets)('adversarial: link target %s resolves to a real file', (target) => {
    expect(existsSync(path.join(DOCS_DIR, target))).toBe(true)
  })
})

describe('docs/README.md — acceptance: links every actual document in docs/', () => {
  test.each(committedDocs())('%s is linked from docs/README.md', (doc) => {
    const relativeToDocsDir = path.relative(DOCS_DIR, path.join(REPO_ROOT, doc))
    expect(content).toContain(relativeToDocsDir)
  })
})

describe('docs/README.md — acceptance + adversarial: no stated parameter or policy number is duplicated', () => {
  const adr0008 = readFileSync(path.join(DOCS_DIR, 'adr', '0008-stated-rule-parameters.md'), 'utf8')
  const requirements = readFileSync(path.join(REPO_ROOT, 'REQUIREMENTS.md'), 'utf8')

  // Pulled from the documents of record themselves, not hardcoded twice:
  // ADR-0008's stated-rule parameter table, and CQ-1's coverage threshold.
  function boldedTableValues(markdown: string): string[] {
    return markdown
      .split('\n')
      .filter((line) => line.startsWith('|'))
      .flatMap((line) => [...line.matchAll(/\*\*(.+?)\*\*/g)].map((m) => m[1]))
  }

  const statedParameters = boldedTableValues(adr0008)
  const coverageMatch = requirements.match(/CQ-1[\s\S]{0,60}?≥\s*(\d+)%/)
  if (!coverageMatch) throw new Error('REQUIREMENTS.md CQ-1 coverage threshold not found — test fixture is stale')
  const coverageThreshold = `${coverageMatch[1]}%`

  test('fixture sanity: at least one stated parameter was extracted from ADR-0008', () => {
    expect(statedParameters.length).toBeGreaterThan(0)
  })

  test.each(statedParameters)('adversarial: stated parameter %s from ADR-0008 is not duplicated', (value) => {
    expect(content).not.toContain(value)
  })

  test('adversarial: the CQ-1 coverage threshold is not duplicated', () => {
    expect(content).not.toContain(coverageThreshold)
  })
})
