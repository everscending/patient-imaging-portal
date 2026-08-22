// The canonical audit-action list, in its own module (no 'server-only', no
// node built-ins) so client screens — the admin audit filter — can import it.
// The type-only import below is erased at compile time and pulls nothing in.
import type { AuditAction } from './events'

export const auditActions = [
  'identity.verify',
  'identity.lockout',
  'identity.link',
  'study.view',
  'image.view',
  'clip.view',
  'report.view',
  'share.create',
  'share.use',
  'share.revoke',
  'share.view',
  'booking.create',
  'booking.reschedule',
  'booking.cancel',
  'appointment.view',
  'appointment.transition',
  'schedule.view',
  'availability.update',
  'availability.collision',
  'reminder.dispatch',
  'audit.view',
  'profile.deletion_request',
] as const satisfies readonly AuditAction[]
