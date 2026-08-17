import { createHash, timingSafeEqual } from 'node:crypto'

import type { PhiTarget } from '../../../../lib/access/guard'
import { config } from '../../../../lib/config'
import { dispatchReminders } from '../../../../lib/notify/reminders'
import { errorResponse } from '../../../../lib/validation/envelope'

// This system callback has no caller-scoped PHI target; its authorization
// boundary is the cron secret. Keeping that absence in the request type makes
// the route's relationship to the central PHI guard explicit.
type CronRequest = Request & { readonly phiTarget?: never & PhiTarget }

function authorized(candidate: string | null): boolean {
  if (!candidate || !config.cronSecret) return false
  // Hash both values first so candidates of every length reach the same
  // fixed-width constant-time comparison. The configured secret and supplied
  // value are never included in an error or log.
  const left = createHash('sha256').update(candidate).digest()
  const right = createHash('sha256').update(config.cronSecret).digest()
  return timingSafeEqual(left, right)
}

export async function POST(request: CronRequest): Promise<Response> {
  if (!authorized(request.headers.get('x-cron-secret'))) {
    return errorResponse(401, 'unauthorized', 'Unauthorized.')
  }
  try {
    return Response.json(await dispatchReminders(), { status: 200 })
  } catch {
    return errorResponse(503, 'reminders_unavailable', 'Reminders are temporarily unavailable.')
  }
}
