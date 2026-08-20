import { readFileSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import { generateAssetPool } from '../../db/seed/assets'
import { buildRowSet, type RowSet } from '../../db/seed/rows'
import { E2_DEMO_PHI_ROWS } from '../../e2e/fixtures/fake-auth-server'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const ARTIFACT_PATH = path.join(REPO_ROOT, 'tests', 'artifacts', 'demo-run.log')
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'demo-run.sh')
const SEED_RUN_PATH = path.join(REPO_ROOT, 'tests', 'seed', 'artifacts', 'rows-run.json')
const REQUIRED_STEPS = [
  'identity-verification',
  'image-and-cine-viewing',
  'sharing',
  'report',
  'availability',
  'booking',
  'no-double-book',
  'reschedule-and-cancel',
  'reminder',
] as const

type Needle = { className: string; normalized: string }
type ScanHit = { file: string; line: number; needleClass: string }
type ScanResult = { hits: ScanHit[]; integrityErrors: string[] }
type PhiRows = Pick<RowSet, 'patients' | 'providers' | 'reports' | 'studies'>

const seedRun = JSON.parse(readFileSync(SEED_RUN_PATH, 'utf8')) as {
  seed: string
  now: string
  minChangeNoticeHours: number
}
const SEED_ROWS = buildRowSet({
  pool: generateAssetPool(seedRun.seed),
  sourceSeed: seedRun.seed,
  now: new Date(seedRun.now),
  minChangeNoticeHours: seedRun.minChangeNoticeHours,
})

function seededRows(): RowSet {
  return SEED_ROWS
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim()
}

function dateVariants(isoDate: string): string[] {
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
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'u').test(line)
}

function scanArtifact(text: string, rowSets: PhiRows[] = [seededRows(), E2_DEMO_PHI_ROWS]): ScanResult {
  const lines = text.split(/\r?\n/)
  const hits: ScanHit[] = []
  const needles = needlesFor(rowSets)
  for (const [index, rawLine] of lines.entries()) {
    const line = normalize(rawLine)
    for (const needle of needles) {
      if (containsNeedle(line, needle.normalized)) {
        hits.push({ file: 'tests/artifacts/demo-run.log', line: index + 1, needleClass: needle.className })
      } else if (
        lines[index + 1] !== undefined &&
        !containsNeedle(normalize(lines[index + 1]!), needle.normalized) &&
        containsNeedle(normalize(`${rawLine}\n${lines[index + 1]}`), needle.normalized)
      ) {
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
    const json = line.match(/(\{.*\})/)?.[1]
    if (!json) continue
    try {
      const value = JSON.parse(json) as Record<string, unknown>
      if (line.startsWith('DEMO_AUDIT_DETAIL ') && !Object.hasOwn(value, 'detail')) {
        integrityErrors.push('audit detail field is missing')
      }
      if (
        line.startsWith('DEMO_AUDIT_DETAIL ') &&
        value.detail !== null &&
        typeof value.detail === 'object' &&
        !Array.isArray(value.detail)
      ) hasAuditDetail = true
      if (line.startsWith('DEMO_AUDIT_DETAIL ') && Object.hasOwn(value, 'detail') && typeof value.action === 'string') {
        auditActions.add(value.action)
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
      if (value.op === 'share.create' || value.op === 'booking.create') {
        const keys = Object.keys(value).sort()
        if (JSON.stringify(keys) !== JSON.stringify(['ms', 'op', 'outcome', 'requestId'])) {
          integrityErrors.push(`timing line has an unapproved field: ${value.op}`)
        } else if (
          typeof value.ms !== 'number' ||
          !Number.isFinite(value.ms) ||
          (value.outcome !== 'ok' && value.outcome !== 'conflict' && value.outcome !== 'error') ||
          typeof value.requestId !== 'string'
        ) {
          integrityErrors.push(`timing line is invalid: ${value.op}`)
        } else {
          timingOperations.add(value.op)
        }
      }
    } catch {
      // Non-JSON application output is still scanned as text above.
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

function completeArtifact(...extraLines: string[]): string {
  return [
    ...REQUIRED_STEPS.map((step) => `DEMO_STEP_COMPLETE ${step}`),
    'DEMO_PORT_RELEASED',
    'DEMO_AUDIT_DETAIL {"action":"study.view","detail":{}}',
    'DEMO_AUDIT_DETAIL {"action":"booking.reschedule","targetId":"b9aa2bd7-0340-48e5-bda6-d9e15a6a75ed","outcome":"granted","detail":null}',
    'DEMO_AUDIT_DETAIL {"action":"booking.cancel","targetId":"b9aa2bd7-0340-48e5-bda6-d9e15a6a75ed","outcome":"granted","detail":null}',
    'DEMO_AUDIT_DETAIL {"action":"reminder.dispatch","targetId":"b9aa2bd7-0340-48e5-bda6-d9e15a6a75ed","outcome":"granted","detail":{"transport":"log","leadHours":24}}',
    '{"event":"email.sent","id":"c54e0fb0-8431-4e19-ab49-8f1558aa529e","domain":"example.test","transport":"log"}',
    '{"op":"share.create","ms":12,"outcome":"ok","requestId":"86bacc1a-b193-4fc5-bab0-3d8c4f131751"}',
    '{"op":"booking.create","ms":18,"outcome":"ok","requestId":"6f29624d-7644-42dd-b675-b20de3f89a62"}',
    ...extraLines,
    'DEMO_RUN_COMPLETE',
    '',
  ].join('\n')
}

function expectRejected(text: string, needleClass: string, rows?: PhiRows): void {
  const result = scanArtifact(text, rows ? [rows] : undefined)
  expect(result.hits).toEqual(expect.arrayContaining([expect.objectContaining({ needleClass })]))
  expect(result.integrityErrors).toEqual([])
}

describe('JOR-212 mandatory adversarial PHI subjects', () => {
  test('seededPatientName_failsWithoutEchoingValue', () => {
    const value = seededRows().patients[0]!.full_name
    const result = scanArtifact(completeArtifact(`server: ${value}`))
    expect(result.hits).toContainEqual({
      file: 'tests/artifacts/demo-run.log',
      line: REQUIRED_STEPS.length + 9,
      needleClass: 'patient-name',
    })
    expect(JSON.stringify(result)).not.toContain(value)
  })

  test('isoDateOfBirth_fails', () => {
    expectRejected(completeArtifact(seededRows().patients[0]!.date_of_birth), 'patient-date-of-birth')
  })

  test('usAndLongDateOfBirth_fail', () => {
    const variants = dateVariants(E2_DEMO_PHI_ROWS.patients[0]!.date_of_birth)
    expect(variants).toEqual(expect.arrayContaining(['03/14/1988', '14 March 1988']))
    expectRejected(completeArtifact(variants[1]!), 'patient-date-of-birth')
    expectRejected(completeArtifact(variants[2]!), 'patient-date-of-birth')
  })

  test('wrappedPatientName_fails', () => {
    const [first, ...rest] = seededRows().patients[0]!.full_name.split(' ')
    expectRejected(completeArtifact(`server: ${first}\n${rest.join(' ')}`), 'patient-name')
  })

  test('fakeDemoDatasetPatientName_fails', () => {
    expectRejected(completeArtifact(E2_DEMO_PHI_ROWS.patients[0]!.full_name), 'patient-name')
  })

  test('patientEmailAndPhone_fail', () => {
    const phone = '+1 (312) 555-0199'
    const rows = {
      ...seededRows(),
      patients: seededRows().patients.map((patient, index) => index === 0 ? { ...patient, phone } : patient),
    }
    expectRejected(completeArtifact(rows.patients[0]!.email), 'patient-email', rows)
    expectRejected(completeArtifact(phone), 'patient-phone', rows)
  })

  test('reportImpression_fails', () => {
    expectRejected(completeArtifact(seededRows().reports[0]!.impression), 'report-impression')
  })

  test('patientReferenceAndUuid_pass', () => {
    const result = scanArtifact(completeArtifact('PT-0001 86bacc1a-b193-4fc5-bab0-3d8c4f131751'))
    expect(result).toEqual({ hits: [], integrityErrors: [] })
  })

  test('timingLineWithFifthRecipientAddress_fails', () => {
    const email = seededRows().patients[0]!.email
    const result = scanArtifact(
      completeArtifact(`{"op":"share.create","ms":12,"outcome":"ok","requestId":"86bacc1a-b193-4fc5-bab0-3d8c4f131751","recipient":"${email}"}`),
    )
    expect(result.hits).toEqual(expect.arrayContaining([expect.objectContaining({ needleClass: 'patient-email' })]))
    expect(result.integrityErrors).toContain('timing line has an unapproved field: share.create')
  })

  test('invalidTargetTimingLine_failsEvenWhenAnotherRecordIsValid', () => {
    const result = scanArtifact(completeArtifact('{"op":"share.create","ms":"12","outcome":"ok","requestId":"invalid"}'))
    expect(result.integrityErrors).toContain('timing line is invalid: share.create')
  })

  test('emptyOrTruncatedArtifact_failsClosed', () => {
    expect(scanArtifact('').integrityErrors.length).toBeGreaterThan(0)
    expect(scanArtifact(completeArtifact().replace('DEMO_STEP_COMPLETE reminder\n', '')).integrityErrors).toContain(
      'missing, duplicate, or out-of-order step: reminder',
    )
  })
})

describe('JOR-212 public demo-run evidence', () => {
  test('auditRecordWithoutDetail_failsClosed', () => {
    const withoutDetail = completeArtifact().replace(',"detail":{}', '')
    expect(scanArtifact(withoutDetail).integrityErrors).toContain('audit detail field is missing')
  })

  test('requiredAuditDetailsAndReminderServerLog_failClosed', () => {
    const artifact = completeArtifact()
    expect(scanArtifact(artifact.replace(/DEMO_AUDIT_DETAIL \{"action":"booking\.reschedule".*\n/, '')).integrityErrors)
      .toContain('audit detail is missing: booking.reschedule')
    expect(scanArtifact(artifact.replace(/\{"event":"email\.sent".*\n/, '')).integrityErrors)
      .toContain('reminder server log is missing')
  })

  test('committedArtifact_hasAllStepsAndNoSeededPhi', () => {
    const result = scanArtifact(readFileSync(ARTIFACT_PATH, 'utf8'))
    expect(result).toEqual({ hits: [], integrityErrors: [] })
  })

  test('producerUsesConfiguredPortsAndTheLocalDatabaseFixture', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8')
    expect(script).toContain('config.port')
    expect(script).toContain('pip-testpg')
    expect(script).not.toMatch(/\b(?:3000|5432)\b/)
  })
})
