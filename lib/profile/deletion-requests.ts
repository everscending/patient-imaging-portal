import 'server-only'

import {
  guardAuthenticatedPhiAccess,
  type GuardResult,
  type PhiRequestAuthentication,
} from '../access/guard'
import { anonClient } from '../db/client'

type RpcRow = {
  result_error: string | null
  request_status: string | null
  requested_at: string | null
}

export type DeletionRequestResult =
  | { ok: true; status: 'received'; requestedAt: string }
  | { ok: false; error: 'request_already_open' | 'identity_verification_required' }

export async function authorizeDeletionRequest(authentication: PhiRequestAuthentication): Promise<GuardResult> {
  const userId = authentication.status === 'authenticated' ? authentication.session.userId : ''
  return guardAuthenticatedPhiAccess(
    { kind: 'patient', userId },
    { kind: 'patient', id: null },
    'profile.deletion_request',
    authentication,
    { grantedAudit: 'transactional-rpc' },
  )
}

async function callRpc(accessToken: string, requestValid: boolean): Promise<RpcRow> {
  const { data, error } = await anonClient(accessToken).rpc('request_profile_deletion', {
    p_request_valid: requestValid,
  })
  const row = (Array.isArray(data) ? data[0] : data) as RpcRow | null
  if (error || !row) throw new Error('deletion request transaction failed')
  return row
}

export async function recordInvalidDeletionRequest(accessToken: string): Promise<void> {
  const row = await callRpc(accessToken, false)
  if (row.result_error !== 'validation_failed') throw new Error('deletion request transaction failed')
}

export async function submitDeletionRequest(accessToken: string): Promise<DeletionRequestResult> {
  const row = await callRpc(accessToken, true)
  if (row.result_error === 'request_already_open' || row.result_error === 'identity_verification_required') {
    return { ok: false, error: row.result_error }
  }
  if (
    row.result_error !== null ||
    row.request_status !== 'received' ||
    row.requested_at === null ||
    !Number.isFinite(Date.parse(row.requested_at))
  ) {
    throw new Error('deletion request transaction failed')
  }
  return { ok: true, status: 'received', requestedAt: row.requested_at }
}
