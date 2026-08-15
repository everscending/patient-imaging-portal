// db/seed/index.ts — the one seed entry point (ADR-0009): the asset pool
// (T12, db/seed/assets.ts + db/seed/storage.ts) uploads first, then the
// ADR-0009 row set (db/seed/rows.ts) is written. Transport-agnostic by
// design (ARCHITECTURE.md §2 reserves the Supabase SDK import to
// lib/db/client.ts alone) — every dependency here is the minimal structural
// shape this module actually calls, supplied by the caller. Pure inputs
// only: `now` and `sourceSeed` are parameters, never the wall clock or the
// raw environment (tests/seed/assets.test.ts's
// adversarialDbSeedSourceNeverReachesWallClockOrRandom scans this file too).
import { generateAssetPool } from './assets'
import { buildRowSet, DEMO_ACCOUNT_PASSWORD, DEMO_ADMIN_EMAIL, DEMO_PATIENT_EMAIL, DEMO_PROVIDER_EMAIL, toInsertPlan, type RowSet } from './rows'
import { uploadPool, type PhiStorageClient, type UploadPoolSummary } from './storage'

export type SeedDbClient = {
  /** Row count for `table` — used only for the empty-database guard. */
  countRows(table: string): Promise<number>
  /** Runs a script of one or more statements; no result rows expected. */
  execute(sql: string): Promise<void>
}

export type AuthAdminClient = {
  auth: {
    admin: {
      createUser(attrs: {
        id: string
        email: string
        password: string
        email_confirm: boolean
      }): Promise<{ data: { user: { id: string } | null }; error: { message: string } | null }>
    }
  }
}

export type RunSeedDeps = {
  storage: PhiStorageClient
  authAdmin: AuthAdminClient
  db: SeedDbClient
  sourceSeed: string
  now: Date
  minChangeNoticeHours: number
}

export type SeedRunRecord = {
  seed: string
  ranAt: string
  rowCounts: Record<string, number>
  statusFixtures: RowSet['fixtures']['statusAppointmentIds']
  noticeWindow: {
    insideAppointmentId: string
    outsideAppointmentId: string
    insideStatus: 'confirmed'
    outsideStatus: 'confirmed'
  }
  demoAccounts: { patient: string; provider: string; admin: string }
  patientRefRange: { first: string; last: string }
  unlinkedPatientId: string
  brokenCineClipId: string
  pool: Pick<UploadPoolSummary, 'uploadedCount' | 'skippedCount' | 'missingKey'>
}

const DEMO_ACCOUNTS = [
  { email: DEMO_PATIENT_EMAIL, role: 'patient' as const },
  { email: DEMO_PROVIDER_EMAIL, role: 'provider' as const },
  { email: DEMO_ADMIN_EMAIL, role: 'admin' as const },
]

async function createDemoAuthUsers(authAdmin: AuthAdminClient, rowSet: RowSet): Promise<void> {
  const idByRole: Record<'patient' | 'provider' | 'admin', string> = {
    patient: rowSet.fixtures.demoPatientAuthId,
    provider: rowSet.fixtures.demoProviderAuthId,
    admin: rowSet.fixtures.demoAdminAuthId,
  }

  for (const account of DEMO_ACCOUNTS) {
    const { error } = await authAdmin.auth.admin.createUser({
      id: idByRole[account.role],
      email: account.email,
      password: DEMO_ACCOUNT_PASSWORD,
      email_confirm: true,
    })
    if (error) {
      throw new Error(`db/seed/index: creating demo ${account.role} account failed: ${error.message}`)
    }
  }
}

async function executeInsertPlan(db: SeedDbClient, rowSet: RowSet): Promise<Record<string, number>> {
  const plan = toInsertPlan(rowSet)
  for (const batch of plan) {
    if (batch.sql) await db.execute(batch.sql)
  }
  return {
    services: rowSet.services.length,
    providers: rowSet.providers.length,
    provider_services: rowSet.providerServices.length,
    patients: rowSet.patients.length,
    staff_admins: rowSet.staffAdmins.length,
    visits: rowSet.visits.length,
    studies: rowSet.studies.length,
    images: rowSet.images.length,
    cine_clips: rowSet.cineClips.length,
    cine_frames: rowSet.cineFrames.length,
    reports: rowSet.reports.length,
    working_hours: rowSet.workingHours.length,
    availability_blocks: rowSet.availabilityBlocks.length,
    slots: rowSet.slots.length,
    appointments: rowSet.appointments.length,
    appointment_transitions: rowSet.appointmentTransitions.length,
  }
}

/** Runs the full seed once: refuses a non-empty database, uploads the
 * ADR-0009 asset pool, writes every ADR-0009 row, links the three demo
 * accounts, and returns the run record the gate reads. */
export async function runSeed(deps: RunSeedDeps): Promise<SeedRunRecord> {
  const existingPatients = await deps.db.countRows('patients')
  if (existingPatients > 0) {
    throw new Error('db/seed/index: refusing to seed a non-empty database — reset it first')
  }

  const pool = generateAssetPool(deps.sourceSeed)
  const uploadSummary = await uploadPool(deps.storage, pool)

  const rowSet = buildRowSet({
    pool,
    sourceSeed: deps.sourceSeed,
    now: deps.now,
    minChangeNoticeHours: deps.minChangeNoticeHours,
  })

  await createDemoAuthUsers(deps.authAdmin, rowSet)
  const rowCounts = await executeInsertPlan(deps.db, rowSet)

  return {
    seed: deps.sourceSeed,
    ranAt: deps.now.toISOString(),
    rowCounts,
    statusFixtures: rowSet.fixtures.statusAppointmentIds,
    noticeWindow: {
      insideAppointmentId: rowSet.fixtures.noticeWindowInsideAppointmentId,
      outsideAppointmentId: rowSet.fixtures.noticeWindowOutsideAppointmentId,
      insideStatus: 'confirmed',
      outsideStatus: 'confirmed',
    },
    demoAccounts: { patient: DEMO_PATIENT_EMAIL, provider: DEMO_PROVIDER_EMAIL, admin: DEMO_ADMIN_EMAIL },
    patientRefRange: { first: rowSet.fixtures.patientRefFirst, last: rowSet.fixtures.patientRefLast },
    unlinkedPatientId: rowSet.fixtures.unlinkedPatientId,
    brokenCineClipId: rowSet.fixtures.brokenCineClipId,
    pool: {
      uploadedCount: uploadSummary.uploadedCount,
      skippedCount: uploadSummary.skippedCount,
      missingKey: uploadSummary.missingKey,
    },
  }
}
