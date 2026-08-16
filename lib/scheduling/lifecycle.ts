export type AppointmentStatus = 'requested' | 'confirmed' | 'completed' | 'cancelled' | 'no_show'
export type SchedulingRole = 'patient' | 'provider' | 'admin'

export type LifecycleInput = {
  status: AppointmentStatus
  role: SchedulingRole
  startsAt: Date
  changeDeadline: Date
  now: Date
}

/** Whether a patient still has time to cancel or reschedule. */
export function canChange({ status, changeDeadline, now }: Pick<LifecycleInput, 'status' | 'changeDeadline' | 'now'>): boolean {
  return (status === 'requested' || status === 'confirmed') && now < changeDeadline
}

/**
 * The sole role-by-transition matrix for appointment status changes.
 * Rescheduling moves an appointment to another slot; it is not a status
 * transition and is deliberately absent here.
 */
export function allowedTransitions({ status, role, startsAt, changeDeadline, now }: LifecycleInput): AppointmentStatus[] {
  if (status === 'completed' || status === 'cancelled' || status === 'no_show') return []

  if (status === 'requested') {
    if (role === 'patient') return canChange({ status, changeDeadline, now }) ? ['cancelled'] : []
    return ['confirmed', 'cancelled']
  }

  if (role === 'patient') return canChange({ status, changeDeadline, now }) ? ['cancelled'] : []
  return now > startsAt ? ['completed', 'no_show', 'cancelled'] : ['cancelled']
}
