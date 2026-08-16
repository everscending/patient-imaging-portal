// lib/reports/reports.ts — report reads stay behind the PHI guard and RLS.
import 'server-only'

import type { Actor, GuardResult } from '../access/guard'
import { guardPhiAccess } from '../access/guard'
import { anonClient } from '../db/client'

export type ReportListItem = {
  id: string
  studyId: string
  studyDescription: string
  signedAt: string
}

export type ReportDetail = {
  id: string
  studyId: string
  studyDescription: string
  patientRef: string
  findings: string
  impression: string
  signedByName: string | null
  signedAt: string | null
}

export type ReportReadResult<T> = { ok: true; value: T } | { ok: false; status: 401 | 403 | 404 }

type ListRow = {
  id: string
  study_id: string
  signed_at: string
  studies: { description: string } | { description: string }[] | null
}

type DetailRow = {
  id: string
  study_id: string
  findings: string
  impression: string
  signed_at: string | null
  studies: { description: string } | { description: string }[] | null
  patients: { patient_ref: string } | { patient_ref: string }[] | null
  providers: { full_name: string } | { full_name: string }[] | null
}

function relatedOne<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value
}

function denied<T>(decision: GuardResult): ReportReadResult<T> {
  if (decision.ok) throw new Error('reports: expected a denied guard result')
  return { ok: false, status: decision.status }
}

/**
 * Lists signed reports only. The collection guard writes the single request
 * audit row; RLS remains the second layer that scopes the returned rows.
 */
export async function listReports(actor: Actor, accessToken: string): Promise<ReportReadResult<ReportListItem[]>> {
  const decision = await guardPhiAccess(actor, { kind: 'collection', of: 'report' }, 'report.view')
  if (!decision.ok) return denied(decision)

  const { data, error } = await anonClient(accessToken)
    .from('reports')
    .select('id, study_id, signed_at, studies!inner(description)')
    .eq('status', 'signed')
    .order('signed_at', { ascending: false })

  // RLS or a dependency failure must not reveal whether a hidden report
  // exists. A collection still has a valid empty result when no rows match.
  if (error || !data) return { ok: true, value: [] }

  return {
    ok: true,
    value: (data as unknown as ListRow[]).flatMap((row) => {
      const study = relatedOne(row.studies)
      return study
        ? [
            {
              id: row.id,
              studyId: row.study_id,
              studyDescription: study.description,
              signedAt: row.signed_at,
            },
          ]
        : []
    }),
  }
}

/** Reads one report after its specific target has been authorised and audited. */
export async function getReport(actor: Actor, accessToken: string, reportId: string): Promise<ReportReadResult<ReportDetail>> {
  const decision = await guardPhiAccess(actor, { kind: 'report', id: reportId }, 'report.view')
  if (!decision.ok) return denied(decision)

  const { data, error } = await anonClient(accessToken)
    .from('reports')
    .select(
      'id, study_id, findings, impression, signed_at, studies!inner(description), patients!inner(patient_ref), providers!reports_signed_by_fkey(full_name)',
    )
    .eq('id', reportId)
    .maybeSingle()

  const row = data as unknown as DetailRow | null
  const study = row ? relatedOne(row.studies) : null
  const patient = row ? relatedOne(row.patients) : null
  const provider = row ? relatedOne(row.providers) : null
  if (error || !row || !study || !patient) return { ok: false, status: 404 }

  return {
    ok: true,
    value: {
      id: row.id,
      studyId: row.study_id,
      studyDescription: study.description,
      patientRef: patient.patient_ref,
      findings: row.findings,
      impression: row.impression,
      signedByName: provider?.full_name ?? null,
      signedAt: row.signed_at,
    },
  }
}
