// JOR-207/T49 — E8's Playwright-visible acceptance record. The cumulative UI
// gate runs the E8 API project first; that project invokes the real running
// application against isolated migrated-and-seeded PostgreSQL and writes the
// validated record consumed here. This spec never replaces a product response
// with page.route or imports the route handler.
import { expect, test } from '@playwright/test'

import { readE8RunRecord } from '../tests/fixtures/e8-run-record'

test('E8 live reminder record proves the measured window, idempotency, reliability, and PHI boundary', async () => {
  const record = await readE8RunRecord()

  expect(record.sourceHead).toMatch(/^[0-9a-f]{40}$/)
  expect(Date.parse(record.measuredWindow.endedAt)).toBeGreaterThanOrEqual(Date.parse(record.measuredWindow.startedAt))
  expect(record.requests).toBe(10)
  expect(record.uniqueDue).toBeGreaterThan(0)
  expect(record.responseTotals).toEqual({
    due: record.requests * record.uniqueDue,
    sent: record.uniqueDue,
    skipped: (record.requests - 1) * record.uniqueDue,
    failed: 0,
  })
  expect(record.durableRowCount).toBe(record.uniqueDue)
  expect(record.dispatchCount).toBe(record.uniqueDue)
  expect(record.duplicateCount).toBe(0)
  expect(record.deliveryRate).toBeGreaterThanOrEqual(0.99)
  expect(record.phiScan).toMatchObject({ passed: true })
  expect(record.phiScan.termCount).toBeGreaterThan(0)
})
