import { execFileSync } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'

import { describe, expect, test } from 'vitest'

import {
  dateVariants,
  REQUIRED_STEPS,
  scanArtifact,
  seededRows,
  type PhiRows,
} from './log-scan-engine'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
const ARTIFACT_PATH = path.join(REPO_ROOT, 'tests', 'artifacts', 'demo-run.log')
const PHI_STATE_PATH = path.join(REPO_ROOT, '.local', 'demo-run-phi.json')
const SCRIPT_PATH = path.join(REPO_ROOT, 'scripts', 'demo-run.sh')

function drivenRows(): PhiRows {
  return JSON.parse(readFileSync(PHI_STATE_PATH, 'utf8')) as PhiRows
}

function completeArtifact(...extraLines: string[]): string {
  return [
    ...REQUIRED_STEPS.map((step) => `DEMO_STEP_COMPLETE ${step}`),
    'DEMO_PORT_RELEASED',
    'DEMO_AUDIT_DETAIL {"action":"study.view","targetId":"99669966-9966-4966-8966-996699669966","outcome":"granted","detail":{}}',
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
    const variants = dateVariants(seededRows().patients[0]!.date_of_birth)
    expect(variants[1]).toMatch(/^\d{2}\/\d{2}\/\d{4}$/)
    expect(variants[2]).toMatch(/^\d{1,2} [A-Z][a-z]+ \d{4}$/)
    expectRejected(completeArtifact(variants[1]!), 'patient-date-of-birth')
    expectRejected(completeArtifact(variants[2]!), 'patient-date-of-birth')
  })

  test('wrappedPatientName_fails', () => {
    const [first, ...rest] = seededRows().patients[0]!.full_name.split(' ')
    expectRejected(completeArtifact(`server: ${first}\n${rest.join(' ')}`), 'patient-name')
  })

  test('patientNameSplitAcrossThreePhysicalLines_fails', () => {
    const name = seededRows().providers[0]!.full_name.split(' ').join('\n')
    expectRejected(completeArtifact(`server: ${name}`), 'provider-name')
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
    expect(result.integrityErrors).toContain('timing line does not have the exact approved fields')
  })

  test('invalidTargetTimingLine_failsEvenWhenAnotherRecordIsValid', () => {
    const result = scanArtifact(completeArtifact('{"op":"share.create","ms":"12","outcome":"ok","requestId":"invalid"}'))
    expect(result.integrityErrors).toContain('timing line is invalid')
  })

  test('truncatedTargetTimingLine_failsEvenWhenAnotherRecordIsValid', () => {
    const result = scanArtifact(completeArtifact('{"op":"share.create","ms":12'))
    expect(result.integrityErrors).toContain('timing line is malformed')
  })

  test('timingCandidateTruncatedAfterOperation_failsEvenWhenAnotherRecordIsValid', () => {
    const result = scanArtifact(completeArtifact('{"op":"share.create'))
    expect(result.integrityErrors).toContain('timing line is malformed')
  })

  test('unrelatedTimingProse_passes', () => {
    const result = scanArtifact(completeArtifact('documentation mentions "op":"share.create" as an example'))
    expect(result).toEqual({ hits: [], integrityErrors: [] })
  })

  test('completeTimingJsonWithNestedFieldBeforeTarget_failsExactShape', () => {
    const result = scanArtifact(
      completeArtifact('{"context":{},"op":"share.create","ms":12,"outcome":"ok","requestId":"valid","recipient":"safe@example.test"}'),
    )
    expect(result.integrityErrors).toContain('timing line does not have the exact approved fields')
  })

  test('everyOperationWithTheExactTimingShape_passes', () => {
    const result = scanArtifact(completeArtifact('{"op":"study.fetch","ms":4,"outcome":"ok","requestId":"request-id"}'))
    expect(result).toEqual({ hits: [], integrityErrors: [] })
  })

  test('everyOperationWithAnExtraTimingField_fails', () => {
    const result = scanArtifact(completeArtifact('{"op":"study.fetch","ms":4,"outcome":"ok","requestId":"request-id","recipient":"safe@example.test"}'))
    expect(result.integrityErrors).toContain('timing line does not have the exact approved fields')
  })

  test('arbitraryOperationWithMissingTimingEvidence_failsClosed', () => {
    const result = scanArtifact(completeArtifact('{"op":"study.fetch","outcome":"ok"}'))
    expect(result.integrityErrors).toContain('timing line does not have the exact approved fields')
  })

  test('truncatedArbitraryOperation_failsWhileBenignProsePasses', () => {
    expect(scanArtifact(completeArtifact('{"op":"study.fetch')).integrityErrors).toContain('timing line is malformed')
    expect(scanArtifact(completeArtifact('documentation mentions "op":"study.fetch" as an example')))
      .toEqual({ hits: [], integrityErrors: [] })
  })

  test('nonTimingOperationJson_passes', () => {
    const result = scanArtifact(completeArtifact('{"op":"health.probe","dependency":"database","outcome":"down"}'))
    expect(result).toEqual({ hits: [], integrityErrors: [] })
  })

  test('unrelatedTimingProseWithBrace_passes', () => {
    const result = scanArtifact(completeArtifact('documentation { mentions "op":"share.create" as an example'))
    expect(result).toEqual({ hits: [], integrityErrors: [] })
  })

  test('emptyOrTruncatedArtifact_failsClosed', () => {
    expect(scanArtifact('').integrityErrors.length).toBeGreaterThan(0)
    expect(scanArtifact(completeArtifact().replace('DEMO_STEP_COMPLETE reminder\n', '')).integrityErrors).toContain(
      'missing, duplicate, or out-of-order step: reminder',
    )
  })
})

describe('JOR-212 public demo-run evidence', () => {
  test('malformedAuditDetailLine_failsEvenWhenRequiredRecordsAreValid', () => {
    const result = scanArtifact(completeArtifact('DEMO_AUDIT_DETAIL {"action":"study.view"'))
    expect(result.integrityErrors).toContain('audit detail line is malformed')
  })

  test('auditDetailWithoutDelimiter_failsEvenWhenRequiredRecordsAreValid', () => {
    const result = scanArtifact(completeArtifact('DEMO_AUDIT_DETAIL{"action":"study.view"}'))
    expect(result.integrityErrors).toContain('audit detail line is malformed')
  })

  test('auditDetailWithColonDelimiter_failsEvenWhenRequiredRecordsAreValid', () => {
    const result = scanArtifact(
      completeArtifact('DEMO_AUDIT_DETAIL:{"action":"study.view","targetId":"valid","outcome":"granted","detail":null}'),
    )
    expect(result.integrityErrors).toContain('audit detail line is malformed')
  })

  test('structurallyInvalidAuditDetailLine_fails', () => {
    const result = scanArtifact(
      completeArtifact('DEMO_AUDIT_DETAIL {"action":"study.view","targetId":7,"outcome":"granted","detail":[]}'),
    )
    expect(result.integrityErrors).toContain('audit detail line is invalid')
  })

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

  test('producerPublishesOneCompleteArtifactAndScansEveryDrivenRow', () => {
    execFileSync(SCRIPT_PATH, { cwd: REPO_ROOT, stdio: 'pipe', timeout: 300_000 })
    const artifact = readFileSync(ARTIFACT_PATH, 'utf8')
    const rows = drivenRows()
    try {
      expect(scanArtifact(artifact, [rows])).toEqual({ hits: [], integrityErrors: [] })
      expect(artifact.match(/▲ Next\.js/g)).toHaveLength(2)
      expect(artifact).toContain('POST /api/jobs/reminders 200')

      for (const patient of rows.patients) {
        expectRejected(completeArtifact(patient.full_name), 'patient-name', rows)
        expectRejected(completeArtifact(patient.email), 'patient-email', rows)
        expectRejected(completeArtifact(patient.date_of_birth), 'patient-date-of-birth', rows)
        if (patient.phone) expectRejected(completeArtifact(patient.phone), 'patient-phone', rows)
      }
      for (const provider of rows.providers) expectRejected(completeArtifact(provider.full_name), 'provider-name', rows)
      for (const report of rows.reports) {
        expectRejected(completeArtifact(report.findings), 'report-findings', rows)
        expectRejected(completeArtifact(report.impression), 'report-impression', rows)
      }
      for (const study of rows.studies) expectRejected(completeArtifact(study.description), 'study-description', rows)
    } finally {
      unlinkSync(PHI_STATE_PATH)
    }
  }, 300_000)

  test('producerUsesConfiguredPortsAndTheLocalDatabaseFixture', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8')
    expect(script).toContain('config.port')
    expect(script).toContain('pip-testpg')
    expect(script).not.toMatch(/\b(?:3000|5432)\b/)
  })

  test('producerCapturesRawRpcAuditLinesWithoutVitestInterception', () => {
    const script = readFileSync(SCRIPT_PATH, 'utf8')
    expect(script).toContain("from audit_events where target_id")
    expect(script).toContain('console.log(`DEMO_AUDIT_DETAIL')
    expect(script).not.toContain('npx vitest')
  })
})
