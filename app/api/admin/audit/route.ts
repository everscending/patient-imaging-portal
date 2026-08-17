import { guardPhiAccess } from '../../../../lib/access/guard'
import { resolveCallerId } from '../../../../lib/access/identity'
import { readAuditLog } from '../../../../lib/audit/events'
import {
  auditLogQuerySchema,
  createAuditLogCursor,
  parseAuditLogCursor,
  parseQuery,
} from '../../../../lib/validation'
import { errorResponse } from '../../../../lib/validation/envelope'

const PAGE_SIZE = 50

function accessFailure(status: 401 | 403 | 404): Response {
  if (status === 401) return errorResponse(401, 'session_required', 'Sign in to continue.')
  return errorResponse(404, 'not_found', 'Not found.')
}

export async function GET(request: Request): Promise<Response> {
  const parsed = parseQuery(auditLogQuerySchema, request)
  const actor = { kind: 'admin' as const, userId: (await resolveCallerId()) ?? '' }
  const access = await guardPhiAccess(actor, { kind: 'audit_log' }, 'audit.view')
  if (!access.ok) return accessFailure(access.status)
  if (!parsed.ok) return parsed.response

  const cursor = parseAuditLogCursor(parsed.value.cursor, parsed.value)
  if (!cursor) return errorResponse(422, 'validation_failed', 'The request could not be validated.')

  const rows = await readAuditLog(parsed.value)
  const start = cursor.id === '' ? 0 : rows.findIndex((row) => String(row.id) === cursor.id && row.occurred_at === cursor.occurredAt) + 1
  if (cursor.id !== '' && start === 0) return errorResponse(422, 'validation_failed', 'The request could not be validated.')
  const page = rows.slice(start, start + PAGE_SIZE)
  const last = page.at(-1)
  const { cursor: _requestedCursor, ...filters } = parsed.value
  void _requestedCursor
  const nextCursor = last && start + PAGE_SIZE < rows.length
    ? createAuditLogCursor({ id: String(last.id), occurredAt: last.occurred_at, filters })
    : null

  return Response.json({
    events: page.map((event) => ({
      id: String(event.id),
      occurredAt: event.occurred_at,
      actorKind: event.actor_kind,
      actorRef: event.actor_ref,
      action: event.action,
      targetKind: event.target_kind,
      targetId: event.target_id,
      outcome: event.outcome,
    })),
    nextCursor,
  })
}
