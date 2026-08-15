import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const AI_USAGE_PATH = path.join(REPO_ROOT, 'AI_USAGE.md')
const content = readFileSync(AI_USAGE_PATH, 'utf8')

function extractSection(markdown: string, heading: string): string {
  const lines = markdown.split('\n')
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start === -1) throw new Error(`AI_USAGE.md has no "${heading}" heading`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^#{1,2} /.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n')
}

describe('AI_USAGE.md — acceptance + adversarial: the no-runtime-AI statement is a sentence, not an omission', () => {
  test('states, in a Runtime AI section, that no runtime AI is used', () => {
    const section = extractSection(content, '## Runtime AI')
    expect(section).toMatch(/no runtime ai is used/i)
  })

  test('adversarial: states no model is called on any request path, not just a bare denial', () => {
    const section = extractSection(content, '## Runtime AI')
    expect(section.replace(/\s+/g, ' ')).toMatch(/no model[^.]*is called on any request path/i)
  })
})

describe('AI_USAGE.md — acceptance + adversarial: no claimed runtime model, engine, or version', () => {
  const RUNTIME_MODEL_NAMES =
    /\b(gpt|claude|llama|gemini|mistral|palm|bert|davinci|curie|claude-sonnet|sonnet|opus|haiku)\b/i

  test('adversarial: the Runtime AI section names no model, engine, or version', () => {
    const section = extractSection(content, '## Runtime AI')
    expect(section).not.toMatch(RUNTIME_MODEL_NAMES)
    expect(section).not.toMatch(/\bv?\d+(\.\d+)+\b/)
  })
})

describe('AI_USAGE.md — acceptance: which AI tools were used and for what, across every phase', () => {
  test.each(['Planning', 'Design records', 'Requirement extraction', 'Ticket authoring', 'Implementation', 'Review'])(
    'names the %s phase',
    (phase) => {
      expect(content).toContain(phase)
    },
  )

  test('names the tool used: Claude, via Claude Code', () => {
    expect(content).toMatch(/Claude \(Sonnet 5\),\s+via\s+Claude Code/)
  })
})

describe('AI_USAGE.md — acceptance + adversarial: AI-1 does not apply', () => {
  test('states EL-5 is cut and AI-1 does not apply', () => {
    expect(content).toMatch(/EL-5[^.\n]*is cut/i)
    expect(content).toMatch(/AI-1[\s\S]{0,40}(does not apply|not apply)/i)
  })

  test('adversarial: no golden set, threshold, or scorecard is described as present in the build', () => {
    expect(content).toMatch(/no golden set, no accuracy threshold, and no scorecard harness/i)
  })
})

describe('AI-1 apparatus — adversarial: no golden set, threshold, or scorecard harness anywhere in the build', () => {
  test('no source file under app/, lib/, scripts/, or db/ names a booking eval harness', () => {
    const output = execFileSync(
      'git',
      ['ls-files', '--', 'app', 'lib', 'scripts', 'db'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )
    const files = output.trim().length > 0 ? output.trim().split('\n') : []
    const suspect = files.filter((file) => /golden-?set|scorecard|nl-?booking|ai-1/i.test(file))
    expect(suspect).toEqual([])
  })

  test('package.json has no eval/scorecard script', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const scriptNames = Object.keys(pkg.scripts ?? {})
    const suspect = scriptNames.filter((name) => /golden-?set|scorecard|nl-?booking|ai-1|eval/i.test(name))
    expect(suspect).toEqual([])
  })
})

describe('AI_USAGE.md — acceptance + adversarial: no PHI, credential, or API key in any recorded prompt', () => {
  test('adversarial: no API-key-shaped or credential-shaped token appears', () => {
    expect(content).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}\b/)
    expect(content).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/)
    expect(content).not.toMatch(/password\s*[:=]\s*\S/i)
    expect(content).not.toMatch(/api[_-]?key\s*[:=]\s*\S/i)
    expect(content).not.toMatch(/\bBearer\s+[A-Za-z0-9._-]{10,}\b/)
  })

  test('adversarial: no patient reference (PT-####) or a labeled date of birth appears', () => {
    expect(content).not.toMatch(/\bPT-\d{4}\b/)
    expect(content).not.toMatch(/date of birth\s*[:=]/i)
  })
})
