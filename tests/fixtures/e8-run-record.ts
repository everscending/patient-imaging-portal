import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export const E8_RUN_RECORD_PATH = path.resolve(process.cwd(), 'tests', 'artifacts', 'e8-run.json')

type ReminderTotals = { due: number; sent: number; skipped: number; failed: number }

export type E8RunRecord = {
  schemaVersion: 1
  ticket: 'JOR-207'
  sourceHead: string
  measuredWindow: { startedAt: string; endedAt: string }
  requests: number
  uniqueDue: number
  responseTotals: ReminderTotals
  durableRowCount: number
  dispatchCount: number
  duplicateCount: number
  deliveryRate: number
  phiScan: { passed: boolean; termCount: number }
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function assertE8RunRecord(value: unknown): asserts value is E8RunRecord {
  if (value === null || typeof value !== 'object') throw new Error('E8 run record must be an object')
  const record = value as Partial<E8RunRecord>
  const totals = record.responseTotals as Partial<ReminderTotals> | undefined
  if (record.schemaVersion !== 1 || record.ticket !== 'JOR-207') throw new Error('E8 run record identity is invalid')
  if (typeof record.sourceHead !== 'string' || !/^[0-9a-f]{40}$/.test(record.sourceHead)) {
    throw new Error('E8 run record source HEAD is invalid')
  }
  if (
    !record.measuredWindow ||
    !Number.isFinite(Date.parse(record.measuredWindow.startedAt)) ||
    !Number.isFinite(Date.parse(record.measuredWindow.endedAt)) ||
    Date.parse(record.measuredWindow.endedAt) < Date.parse(record.measuredWindow.startedAt)
  ) {
    throw new Error('E8 run record measured window is invalid')
  }
  if (
    !isCount(record.requests) ||
    !isCount(record.uniqueDue) ||
    !totals ||
    !isCount(totals.due) ||
    !isCount(totals.sent) ||
    !isCount(totals.skipped) ||
    !isCount(totals.failed) ||
    !isCount(record.durableRowCount) ||
    !isCount(record.dispatchCount) ||
    !isCount(record.duplicateCount)
  ) {
    throw new Error('E8 run record counts are invalid')
  }
  if (typeof record.deliveryRate !== 'number' || record.deliveryRate < 0 || record.deliveryRate > 1) {
    throw new Error('E8 run record delivery rate is invalid')
  }
  if (!record.phiScan || record.phiScan.passed !== true || !isCount(record.phiScan.termCount)) {
    throw new Error('E8 run record PHI scan did not pass')
  }
}

export async function writeE8RunRecord(record: E8RunRecord): Promise<void> {
  assertE8RunRecord(record)
  await mkdir(path.dirname(E8_RUN_RECORD_PATH), { recursive: true })
  await writeFile(E8_RUN_RECORD_PATH, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
}

export async function readE8RunRecord(): Promise<E8RunRecord> {
  const record: unknown = JSON.parse(await readFile(E8_RUN_RECORD_PATH, 'utf8'))
  assertE8RunRecord(record)
  return record
}
