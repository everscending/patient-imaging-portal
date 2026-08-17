import 'server-only'

import { cookies } from 'next/headers'

import { recordAuditEvent } from '../audit/events'
import { config } from '../config'
import { anonClient } from '../db/client'
import { SESSION_COOKIE_NAME } from '../session-cookie'
import { toRfc3339 } from '../time/zones'
import { timed } from '../observability/timing'
import { allowedTransitions, canChange, type AppointmentStatus, type ClinicianTransitionStatus, type SchedulingRole } from './lifecycle'

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

type ChangeError = Extract<ChangeResult, { ok: false }>['error']

export type TransitionResult =
  | { ok: true; appointment: AppointmentDto }
  | { ok: false; error: 'invalid_transition' }

type AppointmentRpcRow = {
  appointment_id: string | null
  starts_at: string | null
  ends_at: string | null
  appointment_status: AppointmentStatus | null
  provider_name: string | null
  provider_time_zone: string | null
  service_name: string | null
  out_of_hours: boolean | null
}

type BookRpcRow = AppointmentRpcRow & {
  result_error: BookError | null
  result_reused: boolean | null
}

type ChangeRpcRow = AppointmentRpcRow & {
  result_error: string | null
  appointment_slot_id: string | null
}

type CallerClient = ReturnType<typeof anonClient>

type AppointmentSelectRow = {
  id: string
  status: AppointmentStatus
  out_of_hours: boolean
  slots: { starts_at: string; ends_at: string } | Array<{ starts_at: string; ends_at: string }> | null
  providers: { full_name: string; time_zone: string } | Array<{ full_name: string; time_zone: string }> | null
  services: { name: string } | Array<{ name: string }> | null
}

const CHANGE_ERRORS = new Set<ChangeError>(['slot_unavailable', 'minimum_notice', 'not_reschedulable'])

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
  // Keep persisted transition authority aligned with the route guard: a dual-role
  // clinician acts as a provider/admin without widening patient-only transitions.
  if (provider.data) return 'provider'
  if (admin.data) return 'admin'
  if (patient.data) return 'patient'
  throw new Error('booking: actor has no scheduling role')
}

function appointmentDto(row: AppointmentRpcRow, role: SchedulingRole): AppointmentDto {
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

function selectedAppointmentDto(row: AppointmentSelectRow, role: SchedulingRole): AppointmentDto {
  const slot = Array.isArray(row.slots) ? row.slots[0] : row.slots
  const provider = Array.isArray(row.providers) ? row.providers[0] : row.providers
  const service = Array.isArray(row.services) ? row.services[0] : row.services
  return appointmentDto({
    appointment_id: row.id,
    starts_at: slot?.starts_at ?? null,
    ends_at: slot?.ends_at ?? null,
    appointment_status: row.status,
    provider_name: provider?.full_name ?? null,
    provider_time_zone: provider?.time_zone ?? null,
    service_name: service?.name ?? null,
    out_of_hours: row.out_of_hours,
  }, role)
}

const APPOINTMENT_SELECT = 'id,status,out_of_hours,slots!inner(starts_at,ends_at),providers!inner(full_name,time_zone),services!inner(name)'

export async function bookForActor(input: {
  slotId: string
  serviceId: string
  idempotencyKey: string
  actorUserId: string
}): Promise<BookResult> {
  const client = await callerClient()
  const { data, error } = await client.from('patients').select('id').eq('user_id', input.actorUserId).maybeSingle()
  if (error) throw new Error('booking: caller patient could not be resolved')
  const patient = data as { id: string } | null
  if (!patient) throw new Error('booking: caller is not a patient')
  return book({ ...input, patientId: patient.id })
}

/** RLS scopes the collection; this module only shapes it into the public DTO. */
export async function listAppointments(actorUserId: string): Promise<AppointmentDto[]> {
  const client = await callerClient()
  const role = await resolveActorRole(client, actorUserId)
  const { data, error } = await client.from('appointments').select(APPOINTMENT_SELECT).order('created_at', { ascending: false })
  if (error) throw new Error('booking: appointment list failed')
  return ((data ?? []) as unknown as AppointmentSelectRow[]).map((row) => selectedAppointmentDto(row, role))
}

/** Persists a lifecycle edge after consulting lifecycle.ts's sole matrix. */
export async function transition(input: {
  appointmentId: string
  status: ClinicianTransitionStatus
  actorUserId: string
}): Promise<TransitionResult> {
  const client = await callerClient()
  const role = await resolveActorRole(client, input.actorUserId)
  const { data: currentData, error: currentError } = await client
    .from('appointments')
    .select(APPOINTMENT_SELECT)
    .eq('id', input.appointmentId)
    .maybeSingle()
  if (currentError) throw new Error('booking: appointment transition read failed')
  const current = currentData as AppointmentSelectRow | null
  if (!current) return { ok: false, error: 'invalid_transition' }
  const currentDto = selectedAppointmentDto(current, role)
  if (!currentDto.allowedTransitions.includes(input.status)) return { ok: false, error: 'invalid_transition' }

  const { data, error } = await client.rpc('transition_appointment', {
    p_appointment_id: input.appointmentId,
    p_status: input.status,
    p_actor_user_id: input.actorUserId,
  })
  if (error) throw new Error('booking: appointment transition write failed')
  const row = (Array.isArray(data) ? data[0] : data) as ChangeRpcRow | null
  if (!row) throw new Error('booking: appointment transition returned no result')
  if (row.result_error === 'invalid_transition') return { ok: false, error: 'invalid_transition' }
  if (row.result_error !== null) throw new Error('booking: appointment transition returned an invalid result')
  return { ok: true, appointment: appointmentDto(row, role) }
}

function isChangeError(error: string): error is ChangeError {
  return CHANGE_ERRORS.has(error as ChangeError)
}

function minimumNoticeInterval(): string {
  return `${config.minChangeNoticeHours} hours`
}

async function changeAppointment(
  rpcName: 'reschedule_appointment' | 'cancel_appointment',
  input: { appointmentId: string; actorUserId: string; slotId?: string },
): Promise<ChangeResult> {
  const client = await callerClient()
  const role = await resolveActorRole(client, input.actorUserId)
  const rpcInput = {
    p_appointment_id: input.appointmentId,
    p_actor_user_id: input.actorUserId,
    p_minimum_notice: minimumNoticeInterval(),
    ...(input.slotId === undefined ? {} : { p_slot_id: input.slotId }),
  }
  const { data, error } = await client.rpc(rpcName, rpcInput)

  if (error) throw new Error('booking: transactional write failed')
  const row = (Array.isArray(data) ? data[0] : data) as ChangeRpcRow | null
  if (!row) throw new Error('booking: transactional write returned no result')
  if (row.result_error !== null) {
    if (!isChangeError(row.result_error)) {
      throw new Error('booking: transactional write returned an invalid result')
    }
    return { ok: false, error: row.result_error }
  }

  return { ok: true, appointment: appointmentDto(row, role) }
}

export async function book(input: {
  patientId: string
  slotId: string
  serviceId: string
  idempotencyKey: string
  actorUserId: string
}): Promise<BookResult> {
  return timed('booking.create', async () => {
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
  }, (result) => {
    if (result.ok) return 'ok'
    return result.error === 'slot_unavailable' || result.error === 'idempotency_key_reused' ? 'conflict' : 'error'
  })
}

export async function reschedule(input: {
  appointmentId: string
  slotId: string
  actorUserId: string
}): Promise<ChangeResult> {
  return changeAppointment('reschedule_appointment', input)
}

export async function cancel(input: { appointmentId: string; actorUserId: string }): Promise<ChangeResult> {
  return changeAppointment('cancel_appointment', input)
}
