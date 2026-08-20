import { resolveAuthenticatedSession } from '../../../../lib/access/identity'
import { recordAuditEvent } from '../../../../lib/audit/events'
import { anonClient } from '../../../../lib/db/client'
import { deletionRequestSchema, parseBody } from '../../../../lib/validation'
import { errorResponse } from '../../../../lib/validation/envelope'

export async function POST(request: Request): Promise<Response> {
  const session = await resolveAuthenticatedSession()
  if (!session) return errorResponse(401, 'session_required', 'Sign in to continue.')

  const parsed = await parseBody(deletionRequestSchema, request)
  if (!parsed.ok) return parsed.response

  const client = anonClient(session.accessToken)
  const { data: patientData, error: patientError } = await client
    .from('patients')
    .select('id')
    .eq('user_id', session.userId)
    .maybeSingle()
  const patient = patientData as { id: string } | null
  if (patientError) return errorResponse(503, 'deletion_request_unavailable', 'The request could not be recorded. Try again.')
  if (!patient) return errorResponse(403, 'identity_verification_required', 'Verify your identity to continue.')

  const { data, error } = await client
    .from('deletion_requests')
    .insert({ patient_id: patient.id, requested_by: session.userId })
    .select('requested_at')
    .single()

  await recordAuditEvent({
    actorKind: 'account',
    actorRef: session.userId,
    action: 'profile.deletion_request',
    targetKind: 'patient',
    targetId: patient.id,
    outcome: error ? 'denied' : 'granted',
  })

  if (error?.code === '23505') {
    return errorResponse(409, 'request_already_open', 'A deletion request is already open.')
  }
  if (error) return errorResponse(503, 'deletion_request_unavailable', 'The request could not be recorded. Try again.')

  return Response.json(
    { status: 'received', requestedAt: (data as { requested_at: string }).requested_at },
    { status: 202 },
  )
}
