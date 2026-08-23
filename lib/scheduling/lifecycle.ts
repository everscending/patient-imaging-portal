export type AppointmentStatus = 'requested' | 'confirmed' | 'completed' | 'cancelled' | 'no_show'
export type SchedulingRole = 'patient' | 'provider' | 'admin'
export const clinicianTransitionStatuses = ['confirmed', 'completed', 'no_show'] as const satisfies readonly AppointmentStatus[]
export type ClinicianTransitionStatus = (typeof clinicianTransitionStatuses)[number]

// Canonical action verb for each transition a clinician can take. Lives here
// (not in the schedule page) because any per-status mapping outside this file
// trips the single-authority guard in tests/scheduling/lifecycle.test.ts.
const ACTION_LABELS: Partial<Record<AppointmentStatus, string>> = {
  confirmed: 'Confirm',
  completed: 'Complete',
  cancelled: 'Cancel',
  no_show: 'Mark no-show',
}

export function actionLabel(status: AppointmentStatus): string {
  return ACTION_LABELS[status] ?? status
}

export type LifecycleInput = {
  status: AppointmentStatus
  role: SchedulingRole
  startsAt: Date
  changeDeadline: Date
  now: Date
}

type TransitionMatrix = {
  readonly [Role in SchedulingRole]: {
    readonly [Status in AppointmentStatus]: readonly AppointmentStatus[]
  }
}

const clinicianTransitions = {
  requested: ['confirmed', 'cancelled'],
  confirmed: ['completed', 'no_show', 'cancelled'],
  completed: [],
  cancelled: [],
  no_show: [],
} as const

/** The single declaration of every role-by-status transition edge. */
const transitionMatrix = {
  patient: {
    requested: ['cancelled'],
    confirmed: ['cancelled'],
    completed: [],
    cancelled: [],
    no_show: [],
  },
  provider: clinicianTransitions,
  admin: clinicianTransitions,
} as const satisfies TransitionMatrix

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
  return transitionMatrix[role][status].filter((next) => {
    if (role === 'patient' && next === 'cancelled') {
      return canChange({ status, changeDeadline, now })
    }
    if (next === 'completed' || next === 'no_show') return now > startsAt
    return true
  })
}
