import { timingSafeEqual } from 'node:crypto'

import { config } from '../../../../lib/config'
import { dispatchReminders } from '../../../../lib/notify/reminders'
import { errorResponse } from '../../../../lib/validation/envelope'

function authorized(candidate: string | null): boolean {
  if (!candidate || !config.cronSecret) return false
  const left = Buffer.from(candidate)
  const right = Buffer.from(config.cronSecret)
  return left.length === right.length && timingSafeEqual(left, right)
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request.headers.get('x-cron-secret'))) {
    return errorResponse(401, 'unauthorized', 'Unauthorized.')
  }
  try {
    return Response.json(await dispatchReminders(), { status: 200 })
  } catch {
    return errorResponse(503, 'reminders_unavailable', 'Reminders are temporarily unavailable.')
  }
}
