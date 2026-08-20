// tests/seed/rows.test.ts — db/seed/rows.ts and db/seed/index.ts (JOR-250 /
// T13). Generation and validation run fully offline (pure functions of
// pool + sourceSeed + now). A handful of tests exercise a real local
// pip_run_<random> Postgres (ADR-0013, ensureContainer/startRun) — that is
// local infrastructure, not a live provider, exactly like
// tests/db/rls.test.ts and tests/deploy/bucket-sql.test.ts already do; a
// fake storage/auth-admin client stands in for the real network calls. The
// one live provider contact — the real `phi` bucket — happened once in the
// implementation lane; its run record is committed at
// tests/seed/artifacts/rows-run.json and the "Live check" section below
// re-derives it offline, never re-contacting a provider from the gate
// (loom's Live-check convention, same as tests/seed/assets.test.ts).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { runSeed, type AuthAdminClient, type SeedDbClient } from '../../db/seed/index'
import { generateAssetPool, type AssetPool } from '../../db/seed/assets'
import {
  assertAppointmentServiceOffered,
  assertAtLeastOneUnlinkedPatient,
  assertDemoAccountAddress,
  assertFrameKeyResolvesToPool,
  assertNoticeWindowFixtureConfirmed,
  assertOutOfHoursNeverSeededTrue,
  assertPatientRefFormat,
  assertPatientRefSequence,
  assertServicesPopulatedBeforeAppointments,
  buildRowSet,
  DEMO_ADMIN_EMAIL,
  DEMO_MAIL_DOMAIN,
  DEMO_PATIENT_EMAIL,
  DEMO_PROVIDER_EMAIL,
  PATIENT_COUNT,
  PROVIDER_COUNT,
  toInsertPlan,
  type RowSet,
} from '../../db/seed/rows'
import type { PhiStorageClient } from '../../db/seed/storage'
import { ensureContainer, startRun, stopRun, type Container, type Run } from '../setup/postgres'

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel']).toString().trim()
const ARTIFACT_PATH = path.join(REPO_ROOT, 'tests', 'seed', 'artifacts', 'rows-run.json')

const DEFAULT_SEED = 'patient-imaging-portal'
const TEST_NOW = new Date('2026-08-15T12:00:00.000Z')
const MIN_CHANGE_NOTICE_HOURS = 24

const GENERATE_TIMEOUT_MS = 30_000
const DB_TIMEOUT_MS = 90_000

let pool: AssetPool
let rowSet: RowSet

beforeAll(() => {
  pool = generateAssetPool(DEFAULT_SEED)
  rowSet = buildRowSet({ pool, sourceSeed: DEFAULT_SEED, now: TEST_NOW, minChangeNoticeHours: MIN_CHANGE_NOTICE_HOURS })
}, GENERATE_TIMEOUT_MS)

// ── offline fakes (no live provider, no Docker) ────────────────────────
function createFakeStorageClient(): PhiStorageClient {
  return {
    storage: {
      from() {
        return {
          async list() {
            return { data: [], error: null }
          },
          async upload() {
            return { data: {}, error: null }
          },
        }
      },
    },
  }
}

function createFakeAuthAdminClient(created: string[]): AuthAdminClient {
  return {
    auth: {
      admin: {
        async createUser(attrs) {
          created.push(attrs.email)
          return { data: { user: { id: attrs.id } }, error: null }
        },
      },
    },
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Offline: AC + adversarial tests against buildRowSet's pure output
// ═══════════════════════════════════════════════════════════════════════

describe('AC: row counts match ADR-0009 at DEL-4 scale', () => {
  test('fiftyPatientsTenProviders', function fiftyPatientsTenProviders() {
    expect(rowSet.patients).toHaveLength(PATIENT_COUNT)
    expect(rowSet.providers).toHaveLength(PROVIDER_COUNT)
  })

  test('approximatelyOneHundredFiftyStudiesTwoHundredFiftyClipsSevenHundredImages', function approximatelyOneHundredFiftyStudiesTwoHundredFiftyClipsSevenHundredImages() {
    expect(rowSet.studies.length).toBe(150)
    expect(rowSet.cineClips.length).toBe(250)
    expect(rowSet.images.length).toBe(700)
  })

  test('approximatelySixteenThousandSlots', function approximatelySixteenThousandSlots() {
    expect(rowSet.slots.length).toBeGreaterThan(14_000)
    expect(rowSet.slots.length).toBeLessThan(18_000)
  })

  test('reproducesIdenticalRowSetAcrossRuns', function reproducesIdenticalRowSetAcrossRuns() {
    const again = buildRowSet({ pool, sourceSeed: DEFAULT_SEED, now: TEST_NOW, minChangeNoticeHours: MIN_CHANGE_NOTICE_HOURS })
    expect(again.patients).toEqual(rowSet.patients)
    expect(again.slots).toEqual(rowSet.slots)
    expect(again.fixtures).toEqual(rowSet.fixtures)
  })
})

describe('AC: services and provider_services are non-empty before the first appointment, every provider offers a service its appointments use', () => {
  test('servicesAndProviderServicesPopulated', function servicesAndProviderServicesPopulated() {
    expect(rowSet.services.length).toBeGreaterThan(0)
    expect(rowSet.providerServices.length).toBeGreaterThan(0)
  })

  test('everyProviderOffersAtLeastOneService', function everyProviderOffersAtLeastOneService() {
    for (const provider of rowSet.providers) {
      expect(rowSet.providerServices.some((ps) => ps.provider_id === provider.id)).toBe(true)
    }
  })

  test('everyAppointmentsServiceIsOneItsProviderOffers', function everyAppointmentsServiceIsOneItsProviderOffers() {
    for (const appointment of rowSet.appointments) {
      expect(() => assertAppointmentServiceOffered(appointment.provider_id, appointment.service_id, rowSet.providerServices)).not.toThrow()
    }
  })
})

describe('AC: exactly one appointment inside MIN_CHANGE_NOTICE_HOURS, at least one outside, both confirmed', () => {
  test('noticeWindowFixturesPresentAndConfirmed', function noticeWindowFixturesPresentAndConfirmed() {
    const inside = rowSet.appointments.find((a) => a.id === rowSet.fixtures.noticeWindowInsideAppointmentId)
    const outside = rowSet.appointments.find((a) => a.id === rowSet.fixtures.noticeWindowOutsideAppointmentId)
    expect(inside).toBeDefined()
    expect(outside).toBeDefined()

    const insideSlot = rowSet.slots.find((s) => s.id === inside?.slot_id)
    const outsideSlot = rowSet.slots.find((s) => s.id === outside?.slot_id)
    const insideHours = (new Date(insideSlot!.starts_at).getTime() - TEST_NOW.getTime()) / 3_600_000
    const outsideHours = (new Date(outsideSlot!.starts_at).getTime() - TEST_NOW.getTime()) / 3_600_000

    expect(insideHours).toBeGreaterThan(0)
    expect(insideHours).toBeLessThan(MIN_CHANGE_NOTICE_HOURS)
    expect(outsideHours).toBeGreaterThan(MIN_CHANGE_NOTICE_HOURS)

    expect(inside!.status).toBe('confirmed')
    expect(outside!.status).toBe('confirmed')
  })
})

describe('AC: at least one preliminary report and at least one signed report with signed_by/signed_at', () => {
  test('reportsCoverBothStatuses', function reportsCoverBothStatuses() {
    const preliminary = rowSet.reports.filter((r) => r.status === 'preliminary')
    const signed = rowSet.reports.filter((r) => r.status === 'signed')
    expect(preliminary.length).toBeGreaterThan(0)
    expect(signed.length).toBeGreaterThan(0)
    for (const report of preliminary) {
      expect(report.signed_by).toBeNull()
      expect(report.signed_at).toBeNull()
    }
    for (const report of signed) {
      expect(report.signed_by).not.toBeNull()
      expect(report.signed_at).not.toBeNull()
    }
  })
})

describe('AC: at least one appointment in each of the five FR-14 statuses', () => {
  test('allFiveStatusesRepresented', function allFiveStatusesRepresented() {
    const statuses = ['requested', 'confirmed', 'completed', 'cancelled', 'no_show'] as const
    for (const status of statuses) {
      expect(rowSet.fixtures.statusAppointmentIds[status]).toBeTruthy()
      expect(rowSet.appointments.some((a) => a.id === rowSet.fixtures.statusAppointmentIds[status] && a.status === status)).toBe(true)
    }
  })

  test('terminalStatusFixturesCarryMatchingTransitionHistory', function terminalStatusFixturesCarryMatchingTransitionHistory() {
    for (const status of ['completed', 'cancelled', 'no_show'] as const) {
      const appointmentId = rowSet.fixtures.statusAppointmentIds[status]
      const transitions = rowSet.appointmentTransitions.filter((t) => t.appointment_id === appointmentId)
      expect(transitions.length).toBeGreaterThan(0)
      expect(transitions[transitions.length - 1].to_status).toBe(status)
    }
  })
})

describe('AC: demo patient, provider and admin accounts exist and are linked', () => {
  test('demoAccountsAtPinnedAddressesAndLinked', function demoAccountsAtPinnedAddressesAndLinked() {
    expect([DEMO_PATIENT_EMAIL, DEMO_PROVIDER_EMAIL, DEMO_ADMIN_EMAIL]).toEqual([
      'patient@demo.pip.test',
      'provider@demo.pip.test',
      'admin@demo.pip.test',
    ])
    const demoPatient = rowSet.patients.find((p) => p.id === rowSet.fixtures.demoPatientId)
    const demoProvider = rowSet.providers.find((p) => p.id === rowSet.fixtures.demoProviderId)
    expect(demoPatient?.user_id).toBe(rowSet.fixtures.demoPatientAuthId)
    expect(demoProvider?.user_id).toBe(rowSet.fixtures.demoProviderAuthId)
    expect(rowSet.staffAdmins[0].user_id).toBe(rowSet.fixtures.demoAdminAuthId)
  })
})

describe('AC + mandatory adversarial: no seeded email is outside a domain that cannot receive mail', () => {
  test('everySeededPatientEmailIsOnTheReservedDomain', function everySeededPatientEmailIsOnTheReservedDomain() {
    for (const patient of rowSet.patients) expect(patient.email.endsWith(`@${DEMO_MAIL_DOMAIN}`)).toBe(true)
  })

  test('adversarial: a demo account seeded at a deliverable domain', function adversarialDemoAccountAtDeliverableDomainRejected() {
    expect(() => assertDemoAccountAddress('patient@gmail.com')).toThrow()
  })

  test('adversarial: a demo account at an address the README does not list', function adversarialDemoAccountAtUnlistedAddressRejected() {
    expect(() => assertDemoAccountAddress(`nurse@${DEMO_MAIL_DOMAIN}`)).toThrow()
  })

  test('the three pinned addresses pass', function pinnedDemoAddressesPass() {
    expect(() => assertDemoAccountAddress(DEMO_PATIENT_EMAIL)).not.toThrow()
    expect(() => assertDemoAccountAddress(DEMO_PROVIDER_EMAIL)).not.toThrow()
    expect(() => assertDemoAccountAddress(DEMO_ADMIN_EMAIL)).not.toThrow()
  })
})

describe('AC + mandatory adversarial: patient_ref is PT- plus four digits, sequential from PT-0001, no gaps or duplicates', () => {
  test('patientRefsAreSequentialFromPt0001', function patientRefsAreSequentialFromPt0001() {
    const refs = rowSet.patients.map((p) => p.patient_ref)
    expect(refs[0]).toBe('PT-0001')
    expect(refs[refs.length - 1]).toBe(`PT-${String(PATIENT_COUNT).padStart(4, '0')}`)
    expect(() => assertPatientRefSequence(refs)).not.toThrow()
  })

  test('adversarial: a ref that is not PT- plus exactly four digits', function adversarialMalformedPatientRefRejected() {
    expect(() => assertPatientRefFormat('PT-42')).toThrow()
    expect(() => assertPatientRefFormat('PATIENT-0001')).toThrow()
    expect(() => assertPatientRefFormat('PT-00001')).toThrow()
  })

  test('adversarial: two patients sharing one ref', function adversarialDuplicatePatientRefRejected() {
    expect(() => assertPatientRefSequence(['PT-0001', 'PT-0001'])).toThrow()
  })

  test('adversarial: a sequence starting anywhere but PT-0001', function adversarialSequenceNotStartingAtPt0001Rejected() {
    expect(() => assertPatientRefSequence(['PT-0002', 'PT-0003'])).toThrow()
  })
})

describe('AC + mandatory adversarial: at least one seeded patient has user_id null and no account', () => {
  test('atLeastOneUnlinkedPatient', function atLeastOneUnlinkedPatient() {
    expect(rowSet.patients.some((p) => p.user_id === null)).toBe(true)
    const unlinked = rowSet.patients.find((p) => p.id === rowSet.fixtures.unlinkedPatientId)
    expect(unlinked?.user_id).toBeNull()
  })

  test('adversarial: a dataset where every patient is linked', function adversarialEveryPatientLinkedRejected() {
    expect(() => assertAtLeastOneUnlinkedPatient([{ user_id: 'a' }, { user_id: 'b' }])).toThrow()
    expect(() => assertAtLeastOneUnlinkedPatient([{ user_id: 'a' }, { user_id: null }])).not.toThrow()
  })
})

describe('AC + mandatory adversarial: exactly one cine clip references the broken pool set', () => {
  test('exactlyOneBrokenCineClip', function exactlyOneBrokenCineClip() {
    const brokenClip = rowSet.cineClips.find((c) => c.id === rowSet.fixtures.brokenCineClipId)
    expect(brokenClip).toBeDefined()
    const framesForClip = rowSet.cineFrames.filter((f) => f.clip_id === brokenClip!.id)
    const missingFrames = framesForClip.filter((f) => f.storage_key === pool.missingKey)
    expect(missingFrames).toHaveLength(1)

    const clipsReferencingMissingKey = rowSet.cineClips.filter((c) =>
      rowSet.cineFrames.some((f) => f.clip_id === c.id && f.storage_key === pool.missingKey),
    )
    expect(clipsReferencingMissingKey).toHaveLength(1)
    expect(clipsReferencingMissingKey[0].id).toBe(rowSet.fixtures.brokenCineClipId)
  })
})

describe('JOR-297: one healthy cine clip has all 100 uploaded frames', () => {
  test('healthyClipIsContiguousAndBrokenClipKeepsItsGap', function healthyClipIsContiguousAndBrokenClipKeepsItsGap() {
    const assetsByKey = new Map(pool.assets.map((asset) => [asset.key, asset]))
    const healthyClips = rowSet.cineClips.filter(
      (clip) => clip.id !== rowSet.fixtures.brokenCineClipId && clip.frame_count === 100,
    )

    expect(healthyClips).toHaveLength(1)
    expect(healthyClips[0].id).toBe(rowSet.fixtures.performanceCineClipId)
    const healthyFrames = rowSet.cineFrames
      .filter((frame) => frame.clip_id === healthyClips[0].id)
      .sort((a, b) => a.frame_index - b.frame_index)
    expect(healthyFrames.map((frame) => frame.frame_index)).toEqual(Array.from({ length: 100 }, (_, index) => index))
    expect(healthyFrames.every((frame) => assetsByKey.get(frame.storage_key)?.upload === true)).toBe(true)

    const brokenFrames = rowSet.cineFrames.filter((frame) => frame.clip_id === rowSet.fixtures.brokenCineClipId)
    expect(brokenFrames).toHaveLength(100)
    expect(brokenFrames.filter((frame) => assetsByKey.get(frame.storage_key)?.upload === false)).toHaveLength(1)
  })
})

describe('AC + mandatory adversarial: no seeded appointment has out_of_hours set to true', () => {
  test('outOfHoursColumnNeverAppearsInTheAppointmentsInsert', function outOfHoursColumnNeverAppearsInTheAppointmentsInsert() {
    const plan = toInsertPlan(rowSet)
    const appointmentsBatch = plan.find((b) => b.table === 'appointments')
    expect(appointmentsBatch?.sql).not.toContain('out_of_hours')
  })

  test('adversarial: out_of_hours written directly to true', function adversarialOutOfHoursWrittenTrueRejected() {
    expect(() => assertOutOfHoursNeverSeededTrue(true)).toThrow()
    expect(() => assertOutOfHoursNeverSeededTrue(false)).not.toThrow()
  })
})

describe('AC + mandatory adversarial: every images/cine_frames storage_key resolves to a pool object, except the one missing frame', () => {
  test('everyStorageKeyResolvesToThePoolExceptTheOneMissingFrame', function everyStorageKeyResolvesToThePoolExceptTheOneMissingFrame() {
    const poolKeys = new Set(pool.assets.map((a) => a.key))
    for (const image of rowSet.images) expect(poolKeys.has(image.storage_key)).toBe(true)
    for (const frame of rowSet.cineFrames) expect(poolKeys.has(frame.storage_key)).toBe(true)
  })

  test('adversarial: a storage_key pointing at an object T12 never generated', function adversarialUnknownStorageKeyRejected() {
    const poolKeys = new Set(pool.assets.map((a) => a.key))
    expect(() => assertFrameKeyResolvesToPool('11111111-1111-4111-8111-111111111111', poolKeys)).toThrow()
    expect(() => assertFrameKeyResolvesToPool([...poolKeys][0], poolKeys)).not.toThrow()
  })
})

describe('mandatory adversarial: a seed run reaching the first appointment insert with services empty', () => {
  test('adversarialServicesEmptyBeforeAppointmentsRejected', function adversarialServicesEmptyBeforeAppointmentsRejected() {
    expect(() => assertServicesPopulatedBeforeAppointments(0, 5)).toThrow()
    expect(() => assertServicesPopulatedBeforeAppointments(0, 0)).not.toThrow()
    expect(() => assertServicesPopulatedBeforeAppointments(3, 5)).not.toThrow()
  })
})

describe('mandatory adversarial: an appointment whose service its provider does not offer', () => {
  test('adversarialUnofferedServiceRejected', function adversarialUnofferedServiceRejected() {
    const providerServices = [{ provider_id: 'provider-a', service_id: 'service-x' }]
    expect(() => assertAppointmentServiceOffered('provider-a', 'service-y', providerServices)).toThrow()
    expect(() => assertAppointmentServiceOffered('provider-a', 'service-x', providerServices)).not.toThrow()
  })
})

describe('mandatory adversarial: a notice-window fixture seeded as cancelled or completed', () => {
  test('adversarialNoticeWindowFixtureWrongStatusRejected', function adversarialNoticeWindowFixtureWrongStatusRejected() {
    expect(() => assertNoticeWindowFixtureConfirmed('cancelled')).toThrow()
    expect(() => assertNoticeWindowFixtureConfirmed('completed')).toThrow()
    expect(() => assertNoticeWindowFixtureConfirmed('confirmed')).not.toThrow()
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Local Postgres (ADR-0013's pip_run_<random>, not a live provider): proves
// the generated rows actually satisfy the real, migrated schema.
// ═══════════════════════════════════════════════════════════════════════

const CONTAINER_NAME = 'pip-testpg'
const PG_USER = 'postgres'

function psql(dbName: string, sql: string): string {
  return execFileSync('docker', ['exec', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql], {
    encoding: 'utf8',
  }).trim()
}

function psqlScript(dbName: string, sql: string): void {
  execFileSync('docker', ['exec', '-i', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', dbName, '-v', 'ON_ERROR_STOP=1', '-f', '-'], {
    encoding: 'utf8',
    input: sql,
    maxBuffer: 32 * 1024 * 1024,
  })
}

function expectPsqlToFail(dbName: string, sql: string): void {
  expect(() => psql(dbName, sql)).toThrow()
}

function createDbClient(dbName: string): SeedDbClient {
  return {
    async countRows(table) {
      return Number(psql(dbName, `select count(*) from ${table};`))
    },
    async execute(sql) {
      psqlScript(dbName, sql)
    },
  }
}

function createDockerAuthAdminClient(dbName: string): AuthAdminClient {
  return {
    auth: {
      admin: {
        async createUser(attrs) {
          psql(dbName, `insert into auth.users (id) values ('${attrs.id}') on conflict do nothing;`)
          return { data: { user: { id: attrs.id } }, error: null }
        },
      },
    },
  }
}

describe('AC: clean database → 001, 002, 003 → db/seed/index.ts completes and produces the stated counts', () => {
  let container: Container
  let run: Run

  beforeAll(async () => {
    container = await ensureContainer()
    run = await startRun(container)
  }, DB_TIMEOUT_MS)

  afterAll(async () => {
    if (run) await stopRun(run)
  })

  test(
    'fullSeedRunAgainstAMigratedDatabaseSucceedsAndReportsCounts',
    async function fullSeedRunAgainstAMigratedDatabaseSucceedsAndReportsCounts() {
      const record = await runSeed({
        storage: createFakeStorageClient(),
        authAdmin: createDockerAuthAdminClient(run.dbName),
        db: createDbClient(run.dbName),
        sourceSeed: DEFAULT_SEED,
        now: TEST_NOW,
        minChangeNoticeHours: MIN_CHANGE_NOTICE_HOURS,
      })

      expect(record.rowCounts.patients).toBe(PATIENT_COUNT)
      expect(record.rowCounts.providers).toBe(PROVIDER_COUNT)
      expect(record.rowCounts.slots).toBeGreaterThan(14_000)
      expect(record.rowCounts.appointments).toBe(rowSet.appointments.length)
      expect(record.rowCounts.cine_frames).toBe(rowSet.cineFrames.length)
      expect(record.performanceCineClipId).toBe(rowSet.fixtures.performanceCineClipId)
      expect(Number(psql(run.dbName, 'select count(*) from patients;'))).toBe(PATIENT_COUNT)
      expect(Number(psql(run.dbName, 'select count(*) from slots;'))).toBe(record.rowCounts.slots)
      expect(Number(psql(run.dbName, 'select count(*) from appointments;'))).toBe(record.rowCounts.appointments)
      expect(Number(psql(run.dbName, 'select count(*) from appointments where out_of_hours;'))).toBeGreaterThan(0)
    },
    DB_TIMEOUT_MS,
  )

  test('adversarial: a second seed run against the already-seeded database is refused', async function adversarialSecondSeedRunAgainstSeededDatabaseRefused() {
    const authAdminCalls: string[] = []
    let storageCalled = false
    const storage = createFakeStorageClient()
    const guardedStorage: PhiStorageClient = {
      storage: {
        from(bucket) {
          storageCalled = true
          return storage.storage.from(bucket)
        },
      },
    }

    await expect(
      runSeed({
        storage: guardedStorage,
        authAdmin: createFakeAuthAdminClient(authAdminCalls),
        db: createDbClient(run.dbName),
        sourceSeed: DEFAULT_SEED,
        now: TEST_NOW,
        minChangeNoticeHours: MIN_CHANGE_NOTICE_HOURS,
      }),
    ).rejects.toThrow(/non-empty/)

    expect(storageCalled).toBe(false)
    expect(authAdminCalls).toHaveLength(0)
  })
})

describe('mandatory adversarial: the schema itself refuses an appointment insert while services is empty', () => {
  let container: Container
  let run: Run

  beforeAll(async () => {
    container = await ensureContainer()
    run = await startRun(container)
  }, DB_TIMEOUT_MS)

  afterAll(async () => {
    if (run) await stopRun(run)
  })

  test('appointmentInsertFailsWithNoServiceRowToReference', function appointmentInsertFailsWithNoServiceRowToReference() {
    expect(Number(psql(run.dbName, 'select count(*) from services;'))).toBe(0)
    psql(run.dbName, `insert into patients (patient_ref, date_of_birth, full_name, email) values ('PT-0001','1990-01-01','A','a@${DEMO_MAIL_DOMAIN}');`)
    psql(run.dbName, `insert into providers (full_name, time_zone) values ('Dr A','UTC');`)
    const providerId = psql(run.dbName, `select id from providers limit 1;`)
    const patientId = psql(run.dbName, `select id from patients limit 1;`)
    psql(run.dbName, `insert into slots (provider_id, starts_at, ends_at) values ('${providerId}', now() + interval '1 day', now() + interval '1 day 30 minutes');`)
    const slotId = psql(run.dbName, `select id from slots limit 1;`)

    expectPsqlToFail(
      run.dbName,
      `insert into appointments (slot_id, patient_id, provider_id, service_id) values ('${slotId}','${patientId}','${providerId}', gen_random_uuid());`,
    )
  })
})

describe('mandatory adversarial: two live appointments on one slot', () => {
  let container: Container
  let run: Run

  beforeAll(async () => {
    container = await ensureContainer()
    run = await startRun(container)
    psql(run.dbName, `insert into services (slug, name) values ('obstetric','Obstetric ultrasound');`)
    psql(run.dbName, `insert into providers (full_name, time_zone) values ('Dr A','UTC');`)
    const providerId = psql(run.dbName, `select id from providers limit 1;`)
    psql(run.dbName, `insert into provider_services (provider_id, service_id) select '${providerId}', id from services;`)
    psql(run.dbName, `insert into patients (patient_ref, date_of_birth, full_name, email) values ('PT-0001','1990-01-01','A','a@${DEMO_MAIL_DOMAIN}'), ('PT-0002','1990-01-01','B','b@${DEMO_MAIL_DOMAIN}');`)
    psql(run.dbName, `insert into slots (provider_id, starts_at, ends_at) values ('${providerId}', now() + interval '1 day', now() + interval '1 day 30 minutes');`)
  }, DB_TIMEOUT_MS)

  afterAll(async () => {
    if (run) await stopRun(run)
  })

  test('secondLiveAppointmentOnTheSameSlotIsRejected', function secondLiveAppointmentOnTheSameSlotIsRejected() {
    const providerId = psql(run.dbName, `select id from providers limit 1;`)
    const serviceId = psql(run.dbName, `select id from services limit 1;`)
    const slotId = psql(run.dbName, `select id from slots limit 1;`)
    const patientA = psql(run.dbName, `select id from patients where patient_ref = 'PT-0001';`)
    const patientB = psql(run.dbName, `select id from patients where patient_ref = 'PT-0002';`)

    psql(run.dbName, `insert into appointments (slot_id, patient_id, provider_id, service_id) values ('${slotId}','${patientA}','${providerId}','${serviceId}');`)
    expectPsqlToFail(
      run.dbName,
      `insert into appointments (slot_id, patient_id, provider_id, service_id) values ('${slotId}','${patientB}','${providerId}','${serviceId}');`,
    )
  })
})

describe('mandatory adversarial: patients.user_id written for a patient with no account', () => {
  let container: Container
  let run: Run

  beforeAll(async () => {
    container = await ensureContainer()
    run = await startRun(container)
  }, DB_TIMEOUT_MS)

  afterAll(async () => {
    if (run) await stopRun(run)
  })

  test('patientUserIdReferencingANonexistentAccountIsRejected', function patientUserIdReferencingANonexistentAccountIsRejected() {
    expectPsqlToFail(
      run.dbName,
      `insert into patients (user_id, patient_ref, date_of_birth, full_name, email) values ('11111111-1111-4111-8111-111111111111','PT-0001','1990-01-01','A','a@${DEMO_MAIL_DOMAIN}');`,
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Live check — running-app claim, checked once in the implementation lane
// against the real `phi` bucket; re-derived offline here so the gate never
// calls a live provider (loom's Live-check convention).
// ═══════════════════════════════════════════════════════════════════════

describe('Live check: the committed run record still matches the current deterministic generation', () => {
  test('liveCheckArtifactRowCountsAndFixturesMatchCurrentGeneration', function liveCheckArtifactRowCountsAndFixturesMatchCurrentGeneration() {
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, 'utf8')) as {
      seed: string
      now: string
      minChangeNoticeHours: number
      rowCounts: Record<string, number>
      demoAccounts: { patient: string; provider: string; admin: string }
      patientRefRange: { first: string; last: string }
      unlinkedPatientId: string
      brokenCineClipId: string
      performanceCineClipId: string
    }

    const currentPool = generateAssetPool(artifact.seed)
    const current = buildRowSet({
      pool: currentPool,
      sourceSeed: artifact.seed,
      now: new Date(artifact.now),
      minChangeNoticeHours: artifact.minChangeNoticeHours,
    })

    expect(current.patients).toHaveLength(artifact.rowCounts.patients)
    expect(current.providers).toHaveLength(artifact.rowCounts.providers)
    expect(current.slots).toHaveLength(artifact.rowCounts.slots)
    expect(current.appointments).toHaveLength(artifact.rowCounts.appointments)
    expect(current.cineFrames).toHaveLength(artifact.rowCounts.cine_frames)
    expect(current.fixtures.patientRefFirst).toBe(artifact.patientRefRange.first)
    expect(current.fixtures.patientRefLast).toBe(artifact.patientRefRange.last)
    expect(current.fixtures.unlinkedPatientId).toBe(artifact.unlinkedPatientId)
    expect(current.fixtures.brokenCineClipId).toBe(artifact.brokenCineClipId)
    expect(current.fixtures.performanceCineClipId).toBe(artifact.performanceCineClipId)
    expect(artifact.demoAccounts).toEqual({ patient: DEMO_PATIENT_EMAIL, provider: DEMO_PROVIDER_EMAIL, admin: DEMO_ADMIN_EMAIL })
  }, GENERATE_TIMEOUT_MS)
})

describe('mandatory adversarial: db/seed/rows.ts and index.ts reach no wall clock and no non-seeded randomness', () => {
  test('adversarialNoDateNowMathRandomOrRandomUuid', function adversarialNoDateNowMathRandomOrRandomUuid() {
    for (const file of ['db/seed/rows.ts', 'db/seed/index.ts']) {
      const content = readFileSync(path.join(REPO_ROOT, file), 'utf8')
      expect(content).not.toContain('Date.now(')
      expect(content).not.toContain('Math.random(')
      expect(content).not.toContain('randomUUID(')
    }
  })
})
