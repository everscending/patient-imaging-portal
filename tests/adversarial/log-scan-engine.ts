// The demo-run PHI-needle scanning engine behind tests/adversarial/log-scan.test.ts
// (JOR-212). Pulled into its own plain module (not a .test.ts) so it can be
// imported from a non-vitest runner — e2e/e9-wiring.spec.ts (JOR-230) reuses
// scanArtifact/SEED_ROWS to re-verify the artifact log-scan.test.ts already
// produced, without pulling vitest's describe/test registrations into
// Playwright's runtime.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { generateAssetPool } from '../../db/seed/assets'
import { buildRowSet, type RowSet } from '../../db/seed/rows'

// git rev-parse, not import.meta.dirname: this module loads under both vitest
// (ESM) and Playwright's own loader, which treats it as CommonJS and errors
// on import.meta — the same reason e2e/e9-wiring.spec.ts resolves REPO_ROOT
// this way.
const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
const SEED_RUN_PATH = path.join(REPO_ROOT, 'tests', 'seed', 'artifacts', 'rows-run.json')

export const REQUIRED_STEPS = [
  'identity-verification',
  'image-and-cine-viewing',
  'image-sharing',
  'report-sharing',
  'report',
  'availability-setup',
  'booking',
  'no-double-book',
  'reschedule-and-cancel',
  'reminder',
] as const

type Needle = { className: string; normalized: string }
type ScanHit = { file: string; line: number; needleClass: string }
export type ScanResult = { hits: ScanHit[]; integrityErrors: string[] }
export type PhiRows = {
  patients: Array<Pick<RowSet['patients'][number], 'date_of_birth' | 'email' | 'full_name' | 'phone'>>
  providers: Array<Pick<RowSet['providers'][number], 'full_name'>>
  reports: Array<Pick<RowSet['reports'][number], 'findings' | 'impression'>>
  studies: Array<Pick<RowSet['studies'][number], 'description'>>
}

const seedRun = JSON.parse(readFileSync(SEED_RUN_PATH, 'utf8')) as {
  seed: string
  now: string
  minChangeNoticeHours: number
}
export const SEED_ROWS = buildRowSet({
  pool: generateAssetPool(seedRun.seed),
  sourceSeed: seedRun.seed,
  now: new Date(seedRun.now),
  minChangeNoticeHours: seedRun.minChangeNoticeHours,
})

export function seededRows(): RowSet {
  return SEED_ROWS
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim()
}

export function dateVariants(isoDate: string): string[] {
  const [year, month, day] = isoDate.split('-').map(Number)
  const date = new Date(Date.UTC(year!, month! - 1, day))
  const monthName = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'long' }).format(date)
  return [
    isoDate,
    `${String(month).padStart(2, '0')}/${String(day).padStart(2, '0')}/${year}`,
    `${day} ${monthName} ${year}`,
  ]
}

function needlesFor(rowSets: PhiRows[]): Needle[] {
  const raw: Array<[string, string]> = []
  for (const rows of rowSets) {
    for (const patient of rows.patients) {
      raw.push(['patient-name', patient.full_name], ['patient-email', patient.email])
      if (patient.phone) raw.push(['patient-phone', patient.phone])
      for (const value of dateVariants(patient.date_of_birth)) raw.push(['patient-date-of-birth', value])
    }
    for (const provider of rows.providers) raw.push(['provider-name', provider.full_name])
    for (const report of rows.reports) {
      raw.push(['report-findings', report.findings], ['report-impression', report.impression])
    }
    for (const study of rows.studies) raw.push(['study-description', study.description])
  }

  const seen = new Set<string>()
  return raw.flatMap(([className, value]) => {
    const normalized = normalize(value)
    const key = `${className}\0${normalized}`
    if (!normalized || seen.has(key)) return []
    seen.add(key)
    return [{ className, normalized }]
  })
}

function containsNeedle(line: string, needle: string): boolean {
  return needleStart(line, needle) >= 0
}

function needleStart(line: string, needle: string): number {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').exec(line)
  return match ? match.index + match[1]!.length : -1
}

function validAuditRecord(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value).sort()
  const detail = value.detail
  return JSON.stringify(keys) === JSON.stringify(['action', 'detail', 'outcome', 'targetId']) &&
    typeof value.action === 'string' &&
    (typeof value.targetId === 'string' || value.targetId === null) &&
    (value.outcome === 'granted' || value.outcome === 'denied') &&
    (detail === null || (
      typeof detail === 'object' &&
      !Array.isArray(detail) &&
      Object.values(detail).every((item) => ['string', 'number', 'boolean'].includes(typeof item))
    ))
}

export function scanArtifact(
  text: string,
  rowSets: PhiRows[] = [seededRows()],
): ScanResult {
  const lines = text.split(/\r?\n/)
  const hits: ScanHit[] = []
  const needles = needlesFor(rowSets)
  const longestNeedle = Math.max(...needles.map((needle) => needle.normalized.length))
  for (const [index, rawLine] of lines.entries()) {
    const line = normalize(rawLine)
    const tail = line.slice(-(longestNeedle + 1))
    let continuation = ''
    for (let next = index + 1; next < lines.length && continuation.length < longestNeedle; next += 1) {
      continuation = normalize(`${continuation}\n${lines[next]}`).slice(0, longestNeedle)
    }
    const window = normalize(`${tail}\n${continuation}`)
    for (const needle of needles) {
      if (containsNeedle(line, needle.normalized)) {
        hits.push({ file: 'tests/artifacts/demo-run.log', line: index + 1, needleClass: needle.className })
      } else {
        const start = needleStart(window, needle.normalized)
        if (start < 0 || start >= tail.length || start + needle.normalized.length <= tail.length) continue
        hits.push({ file: 'tests/artifacts/demo-run.log', line: index + 1, needleClass: needle.className })
      }
    }
  }

  const integrityErrors: string[] = []
  let previous = -1
  for (const step of REQUIRED_STEPS) {
    const marker = `DEMO_STEP_COMPLETE ${step}`
    const index = lines.indexOf(marker)
    if (index <= previous || lines.lastIndexOf(marker) !== index) integrityErrors.push(`missing, duplicate, or out-of-order step: ${step}`)
    previous = index
  }
  let hasAuditDetail = false
  const auditActions = new Set<string>()
  let hasReminderServerLog = false

  const timingOperations = new Set<string>()
  for (const line of lines) {
    const auditTarget = line.startsWith('DEMO_AUDIT_DETAIL')
    const malformedTimingTarget = !auditTarget && line.trimStart().startsWith('{') && /"op"\s*:\s*"/.test(line)
    const json = auditTarget && line.startsWith('DEMO_AUDIT_DETAIL ')
      ? line.slice('DEMO_AUDIT_DETAIL '.length)
      : auditTarget ? undefined : line
    if (!json) {
      if (auditTarget) integrityErrors.push('audit detail line is malformed')
      continue
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      if (auditTarget) integrityErrors.push('audit detail line is malformed')
      if (malformedTimingTarget) integrityErrors.push('timing line is malformed')
      continue
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      if (auditTarget) integrityErrors.push('audit detail line is invalid')
      continue
    }
    const value = parsed as Record<string, unknown>
    const timingTarget = !auditTarget && (
      Object.hasOwn(value, 'ms') ||
      Object.hasOwn(value, 'requestId') ||
      (typeof value.op === 'string' && (value.outcome === 'ok' || value.outcome === 'conflict' || value.outcome === 'error'))
    )
    if (auditTarget) {
      if (!Object.hasOwn(value, 'detail')) {
        integrityErrors.push('audit detail field is missing')
      } else if (!validAuditRecord(value)) {
        integrityErrors.push('audit detail line is invalid')
      } else {
        if (value.detail !== null) hasAuditDetail = true
        auditActions.add(value.action as string)
      }
    }
    if (value.event === 'email.sent') {
      const keys = Object.keys(value).sort()
      if (
        JSON.stringify(keys) !== JSON.stringify(['domain', 'event', 'id', 'transport']) ||
        typeof value.id !== 'string' ||
        typeof value.domain !== 'string' ||
        value.transport !== 'log'
      ) {
        integrityErrors.push('reminder server log is invalid')
      } else {
        hasReminderServerLog = true
      }
    }
    if (timingTarget) {
      const keys = Object.keys(value).sort()
      if (JSON.stringify(keys) !== JSON.stringify(['ms', 'op', 'outcome', 'requestId'])) {
        integrityErrors.push('timing line does not have the exact approved fields')
      } else if (
        typeof value.op !== 'string' ||
        typeof value.ms !== 'number' ||
        !Number.isFinite(value.ms) ||
        (value.outcome !== 'ok' && value.outcome !== 'conflict' && value.outcome !== 'error') ||
        typeof value.requestId !== 'string'
      ) {
        integrityErrors.push('timing line is invalid')
      } else {
        timingOperations.add(value.op)
      }
    }
  }
  if (!hasAuditDetail) integrityErrors.push('audit detail is missing')
  for (const action of ['booking.reschedule', 'booking.cancel', 'reminder.dispatch']) {
    if (!auditActions.has(action)) integrityErrors.push(`audit detail is missing: ${action}`)
  }
  if (!hasReminderServerLog) integrityErrors.push('reminder server log is missing')
  for (const operation of ['share.create', 'booking.create']) {
    if (!timingOperations.has(operation)) integrityErrors.push(`timing line is missing: ${operation}`)
  }
  if (!lines.includes('DEMO_PORT_RELEASED')) integrityErrors.push('configured application port was not released')
  if (lines.at(-2) !== 'DEMO_RUN_COMPLETE') integrityErrors.push('final completion marker is missing')

  return { hits, integrityErrors }
}
