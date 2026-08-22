// tests/docs/readme-contract.ts — the README's parsers, as pure functions of
// text, extracted from tests/docs/readme-contract.test.ts (JOR-258) so the
// wiring tier can re-assert the same contract against the LIVE state without
// restating a second, drifting copy of the same regexes (JOR-265). The logic
// tier owns whether the README is internally honest; e2e/e14-wiring.spec.ts
// owns whether what it says matches the build a reviewer actually meets.
// Nothing here reads a file or imports a test runner — both callers supply
// the text.
import { DEMO_ACCOUNT_EMAILS, DEMO_ACCOUNT_PASSWORD, DEMO_MAIL_DOMAIN } from '../../db/seed/rows'

/** One `## `-delimited section of a Markdown document, heading line included. */
export function section(markdown: string, heading: string): string {
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

export const STATED_PARAMETER_ENV_KEYS = [
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

export function quickStartCoversConcurrencyAndLeakage(content: string): { concurrency: boolean; leakage: boolean } {
  const quickStart = section(content, '## Grader quick start')
  return {
    concurrency: quickStart.includes('tests/scheduling/booking-concurrency.test.ts'),
    leakage: quickStart.includes('tests/adversarial/cross-patient.test.ts'),
  }
}

export function unseededDemoCredentials(content: string): { emails: string[]; badPassword: boolean } {
  const mentionedEmails = [...content.matchAll(new RegExp(`[a-z0-9._%+-]+@${DEMO_MAIL_DOMAIN}`, 'gi'))].map((m) => m[0])
  const emails = mentionedEmails.filter((email) => !(DEMO_ACCOUNT_EMAILS as readonly string[]).includes(email))
  const badPassword = !content.includes(DEMO_ACCOUNT_PASSWORD)
  return { emails, badPassword }
}
