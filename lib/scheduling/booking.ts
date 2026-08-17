import 'server-only'

import { cookies } from 'next/headers'

import { recordAuditEvent } from '../audit/events'
import { config } from '../config'
import { anonClient } from '../db/client'
import { SESSION_COOKIE_NAME } from '../session-cookie'
import { toRfc3339 } from '../time/zones'
import { allowedTransitions, canChange, type AppointmentStatus, type SchedulingRole } from './lifecycle'

type Transition = 'confirmed' | 'completed' | 'cancelled' | 'no_show'

export type AppointmentDto = {
  id: string
  startsAt: string
  endsAt: string
  status: AppointmentStatus
  providerName: string
  serviceName: string
  outOfHours: boolean
  canChange: boolean
  changeDeadline: string
  allowedTransitions: Transition[]
}

export type BookResult =
  | { ok: true; appointment: AppointmentDto; reused: boolean }
  | { ok: false; error: 'slot_unavailable' | 'idempotency_key_reused' | 'service_not_offered' }

type BookError = Extract<BookResult, { ok: false }>['error']

export type ChangeResult =
  | { ok: true; appointment: AppointmentDto }
  | { ok: false; error: 'slot_unavailable' | 'minimum_notice' | 'not_reschedulable' }

type BookRpcRow = {
  result_error: BookError | null
  result_reused: boolean | null
  appointment_id: string | null
  starts_at: string | null
  ends_at: string | null
  appointment_status: AppointmentStatus | null
  provider_name: string | null
  provider_time_zone: string | null
  service_name: string | null
  out_of_hours: boolean | null
}

type CallerClient = ReturnType<typeof anonClient>

async function callerClient() {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value
  if (!token) throw new Error('booking: authenticated session is unavailable')
  return anonClient(token)
}

function required<T>(value: T | null, field: string): T {
  if (value === null) throw new Error(`booking: transactional write omitted ${field}`)
  return value
}

async function resolveActorRole(client: CallerClient, actorUserId: string): Promise<SchedulingRole> {
  const [patient, provider, admin] = await Promise.all([
    client.from('patients').select('id').eq('user_id', actorUserId).maybeSingle(),
    client.from('providers').select('id').eq('user_id', actorUserId).maybeSingle(),
    client.from('staff_admins').select('id').eq('user_id', actorUserId).maybeSingle(),
  ])
  if (patient.error || provider.error || admin.error) throw new Error('booking: actor role could not be resolved')
  if (patient.data) return 'patient'
  if (provider.data) return 'provider'
  if (admin.data) return 'admin'
  throw new Error('booking: actor has no scheduling role')
}

function appointmentDto(row: BookRpcRow, role: SchedulingRole): AppointmentDto {
  const startsAt = new Date(required(row.starts_at, 'starts_at'))
  const endsAt = new Date(required(row.ends_at, 'ends_at'))
  if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
    throw new Error('booking: transactional write returned an invalid appointment instant')
  }

  const status = required(row.appointment_status, 'appointment_status')
  const providerTimeZone = required(row.provider_time_zone, 'provider_time_zone')
  const now = new Date()
  const changeDeadline = new Date(startsAt.getTime() - config.minChangeNoticeHours * 60 * 60 * 1_000)
  const transitions = allowedTransitions({ status, role, startsAt, changeDeadline, now }).filter(
    (next): next is Transition => next !== 'requested',
  )

  return {
    id: required(row.appointment_id, 'appointment_id'),
    startsAt: toRfc3339(providerTimeZone, startsAt),
    endsAt: toRfc3339(providerTimeZone, endsAt),
    status,
    providerName: required(row.provider_name, 'provider_name'),
    serviceName: required(row.service_name, 'service_name'),
    outOfHours: required(row.out_of_hours, 'out_of_hours'),
    canChange: canChange({ status, changeDeadline, now }),
    changeDeadline: toRfc3339(providerTimeZone, changeDeadline),
    allowedTransitions: transitions,
  }
}

export async function book(input: {
  patientId: string
  slotId: string
  serviceId: string
  idempotencyKey: string
  actorUserId: string
}): Promise<BookResult> {
  const client = await callerClient()
  const role = await resolveActorRole(client, input.actorUserId)
  const { data, error } = await client.rpc('book_appointment', {
    p_patient_id: input.patientId,
    p_slot_id: input.slotId,
    p_service_id: input.serviceId,
    p_idempotency_key: input.idempotencyKey,
    p_actor_user_id: input.actorUserId,
  })

  if (error) throw new Error('booking: transactional write failed')
  const row = (Array.isArray(data) ? data[0] : data) as BookRpcRow | null
  if (!row) throw new Error('booking: transactional write returned no result')
  if (row.result_error) return { ok: false, error: row.result_error }

  const appointment = appointmentDto(row, role)
  const reused = required(row.result_reused, 'result_reused')
  if (!reused) {
    await recordAuditEvent({
      actorKind: 'account',
      actorRef: input.actorUserId,
      action: 'booking.create',
      targetKind: 'appointment',
      targetId: appointment.id,
      outcome: 'granted',
    })
  }

  return { ok: true, appointment, reused }
}
