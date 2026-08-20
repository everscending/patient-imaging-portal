import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { ensureContainer, startRun, stopRun, type Container, type Run } from '../setup/postgres'

const CONTAINER_NAME = 'pip-testpg'
const PG_USER = 'postgres'
const MINIMUM_NOTICE = "interval '24 hours'"
const execFileAsync = promisify(execFile)

let container: Container
let run: Run

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql],
    { encoding: 'utf8' },
  ).trim()
}

async function psqlAsync(sql: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'docker',
    ['exec', CONTAINER_NAME, 'psql', '-U', PG_USER, '-d', run.dbName, '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql],
    { encoding: 'utf8' },
  )
  return stdout.trim()
}

function expectSqlState(sql: string, sqlState: string): void {
  try {
    psql(sql)
  } catch (error) {
    expect(String((error as { stderr?: Buffer | string }).stderr ?? '')).toContain(sqlState)
    return
  }
  throw new Error(`expected SQLSTATE ${sqlState}`)
}

type Fixture = {
  providerId: string
  serviceId: string
  patientId: string
  actorUserId: string
  slotIds: string[]
}

function fixture(options: { startsInHours?: number; slots?: number } = {}): Fixture {
  const providerId = randomUUID()
  const serviceId = randomUUID()
  const patientId = randomUUID()
  const actorUserId = randomUUID()
  const slotIds = Array.from({ length: options.slots ?? 2 }, () => randomUUID())
  const suffix = randomUUID().replaceAll('-', '')
  const startsInHours = options.startsInHours ?? 72
  psql(`
    insert into auth.users (id) values ('${actorUserId}');
    insert into patients (id, user_id, patient_ref, date_of_birth, full_name, email)
      values ('${patientId}', '${actorUserId}', 'PT-${suffix.slice(0, 8)}', '1990-01-01', 'RPC Patient', '${suffix}@example.test');
    insert into providers (id, full_name, time_zone) values ('${providerId}', 'Dr. RPC', 'America/Chicago');
    insert into services (id, slug, name) values ('${serviceId}', 'svc-${suffix}', 'RPC Service');
    insert into provider_services (provider_id, service_id) values ('${providerId}', '${serviceId}');
    ${slotIds.map((id, index) => `insert into slots (id, provider_id, starts_at, ends_at)
      values ('${id}', '${providerId}', now() + interval '${startsInHours + index * 2} hours', now() + interval '${startsInHours + index * 2 + 1} hours');`).join('\n')}
  `)
  return { providerId, serviceId, patientId, actorUserId, slotIds }
}

function appointment(input: Fixture, slotIndex = 0, status = 'requested'): string {
  return psql(`insert into appointments (slot_id, patient_id, provider_id, service_id, status, idempotency_key)
    values ('${input.slotIds[slotIndex]}', '${input.patientId}', '${input.providerId}', '${input.serviceId}', '${status}', '${randomUUID()}')
    returning id;`)
}

function appSql(actorUserId: string, call: string): string {
  return `set role app_user; set request.jwt.claims = ${literal(JSON.stringify({ sub: actorUserId }))}; ${call}`
}

function rescheduleCall(f: Fixture, appointmentId: string, slotId: string, minimumNotice = MINIMUM_NOTICE): string {
  return appSql(f.actorUserId, `select row_to_json(result) from reschedule_appointment(
    '${appointmentId}'::uuid, '${slotId}'::uuid, '${f.actorUserId}'::uuid, ${minimumNotice}
  ) result;`)
}

function cancelCall(f: Fixture, appointmentId: string, minimumNotice = MINIMUM_NOTICE): string {
  return appSql(f.actorUserId, `select row_to_json(result) from cancel_appointment(
    '${appointmentId}'::uuid, '${f.actorUserId}'::uuid, ${minimumNotice}
  ) result;`)
}

function transitionCall(f: Fixture, appointmentId: string, status: 'confirmed' | 'completed' | 'no_show'): string {
  return appSql(f.actorUserId, `select row_to_json(result) from transition_appointment(
    '${appointmentId}'::uuid, '${status}'::appointment_status, '${f.actorUserId}'::uuid
  ) result;`)
}

function makeActorClinician(f: Fixture, role: 'provider' | 'admin', retainPatientLink = false): void {
  psql(`${retainPatientLink ? '' : `update patients set user_id = null where id = '${f.patientId}';`}
    ${role === 'provider'
      ? `update providers set user_id = '${f.actorUserId}' where id = '${f.providerId}';`
      : `insert into staff_admins (user_id) values ('${f.actorUserId}');`}`)
}

beforeAll(async () => {
  container = await ensureContainer()
  run = await startRun(container)
}, 120_000)

afterAll(async () => {
  if (run) await stopRun(run)
})

describe('reschedule/cancel RPC — atomic database transaction contract', () => {
  test('authenticated patient cannot bypass lifecycle authority with a direct appointment update', () => {
    const f = fixture()
    const id = appointment(f)

    expectSqlState(
      appSql(f.actorUserId, `update appointments set status = 'confirmed' where id = '${id}';`),
      'permission denied for table appointments',
    )
    expect(psql(`select status::text from appointments where id = '${id}';`)).toBe('requested')
    expect(psql(`select count(*) from appointment_transitions where appointment_id = '${id}';`)).toBe('0')
  })

  test.each(['provider', 'admin'] as const)('%sWithPatientLink_canUseTransactionalClinicianTransition', (role) => {
    const f = fixture()
    const id = appointment(f)
    makeActorClinician(f, role, true)

    expect(JSON.parse(psql(transitionCall(f, id, 'confirmed'))).result_error).toBeNull()
    expect(psql(`select status::text from appointments where id = '${id}';`)).toBe('confirmed')
    expect(psql(`select from_status::text || '|' || to_status::text || '|' || actor_user_id
      from appointment_transitions where appointment_id = '${id}';`)).toBe(`requested|confirmed|${f.actorUserId}`)
    expect(psql(`select action || '|' || actor_ref || '|' || outcome
      from audit_events where target_id = '${id}';`)).toBe(`appointment.transition|${f.actorUserId}|granted`)
  })

  test('patientOnly_transactionalClinicianTransition_isDeniedWithoutSideEffects', () => {
    const f = fixture()
    const id = appointment(f)

    expect(JSON.parse(psql(transitionCall(f, id, 'confirmed'))).result_error).toBe('invalid_transition')
    expect(psql(`select status::text from appointments where id = '${id}';`)).toBe('requested')
    expect(psql(`select count(*) from appointment_transitions where appointment_id = '${id}';`)).toBe('0')
    expect(psql(`select count(*) from audit_events where target_id = '${id}';`)).toBe('0')
  })

  test('clinicianCannotCompleteBeforeAppointmentStartsThroughDirectRpc', () => {
    const f = fixture()
    const id = appointment(f, 0, 'confirmed')
    makeActorClinician(f, 'provider', true)

    expect(JSON.parse(psql(transitionCall(f, id, 'completed'))).result_error).toBe('invalid_transition')
    expect(psql(`select status::text from appointments where id = '${id}';`)).toBe('confirmed')
    expect(psql(`select count(*) from appointment_transitions where appointment_id = '${id}';`)).toBe('0')
    expect(psql(`select count(*) from audit_events where target_id = '${id}';`)).toBe('0')
  })

  test('clinicianCanCompleteAfterAppointmentStartsThroughTransactionalRpc', () => {
    const f = fixture({ startsInHours: -2 })
    const id = appointment(f, 0, 'confirmed')
    makeActorClinician(f, 'provider', true)

    expect(JSON.parse(psql(transitionCall(f, id, 'completed'))).result_error).toBeNull()
    expect(psql(`select status::text from appointments where id = '${id}';`)).toBe('completed')
    expect(psql(`select from_status::text || '|' || to_status::text
      from appointment_transitions where appointment_id = '${id}';`)).toBe('confirmed|completed')
  })

  test('transition_auditFailure_rollsBackStatusAndHistory', () => {
    const f = fixture()
    const id = appointment(f)
    makeActorClinician(f, 'provider', true)
    psql(`create function transition_audit_rollback_probe() returns trigger language plpgsql as $$
            begin raise exception 'transition audit rejected' using errcode = 'check_violation'; end $$;
          create trigger transition_audit_rollback_probe before insert on audit_events
            for each row when (new.target_id = '${id}' and new.action = 'appointment.transition')
            execute function transition_audit_rollback_probe();`)
    try {
      expectSqlState(transitionCall(f, id, 'confirmed'), 'transition audit rejected')
    } finally {
      psql('drop trigger transition_audit_rollback_probe on audit_events; drop function transition_audit_rollback_probe();')
    }
    expect(psql(`select status::text from appointments where id = '${id}';`)).toBe('requested')
    expect(psql(`select count(*) from appointment_transitions where appointment_id = '${id}';`)).toBe('0')
    expect(psql(`select count(*) from audit_events where target_id = '${id}';`)).toBe('0')
  })

  test('reschedule_atomicallyMovesAppointmentAndLetsTriggerDeriveBothSlotStates', () => {
    const f = fixture()
    const id = appointment(f)
    const raw = psql(rescheduleCall(f, id, f.slotIds[1]!))

    expect(JSON.parse(raw)).toMatchObject({ result_error: null, appointment_id: id, appointment_slot_id: f.slotIds[1], out_of_hours: false })
    expect(psql(`select slot_id from appointments where id = '${id}';`)).toBe(f.slotIds[1])
    expect(psql(`select status::text from slots where id = '${f.slotIds[0]}';`)).toBe('open')
    expect(psql(`select status::text from slots where id = '${f.slotIds[1]}';`)).toBe('booked')
    expect(psql(`select count(*) from appointment_transitions where appointment_id = '${id}';`)).toBe('0')
    expect(psql(`select actor_kind::text || '|' || actor_ref || '|' || action || '|' || target_kind || '|' || target_id || '|' || outcome
      from audit_events where target_id = '${id}';`)).toBe(
      `account|${f.actorUserId}|booking.reschedule|appointment|${id}|granted`,
    )
  })

  test('concurrentReschedulesToOneOpenSlot_serializeToOneWinnerAndOneSlotUnavailable', async () => {
    const first = fixture({ slots: 2 })
    const second = fixture({ slots: 1, startsInHours: 80 })
    const target = first.slotIds[1]!
    // Make the second appointment provider-compatible with the target while
    // retaining a different patient/old slot.
    psql(`update slots set provider_id = '${first.providerId}' where id = '${second.slotIds[0]}';
          update appointments set provider_id = '${first.providerId}' where id = '${appointment(second)}';`)
    const firstAppointment = appointment(first)
    const secondAppointment = psql(`select id from appointments where patient_id = '${second.patientId}';`)
    const contenders = [
      { appointmentId: firstAppointment, originalSlotId: first.slotIds[0]! },
      { appointmentId: secondAppointment, originalSlotId: second.slotIds[0]! },
    ]

    const results = await Promise.all([
      psqlAsync(rescheduleCall(first, firstAppointment, target)),
      psqlAsync(rescheduleCall(second, secondAppointment, target)),
    ])
    const decoded = results.map((result) => JSON.parse(result) as { result_error: string | null })
    expect(decoded.filter((result) => result.result_error === null)).toHaveLength(1)
    expect(decoded.filter((result) => result.result_error === 'slot_unavailable')).toHaveLength(1)
    const loser = contenders[decoded.findIndex((result) => result.result_error === 'slot_unavailable')]!
    expect(psql(`select slot_id || '|' || status::text from appointments where id = '${loser.appointmentId}';`)).toBe(
      `${loser.originalSlotId}|requested`,
    )
    expect(psql(`select status::text from slots where id = '${loser.originalSlotId}';`)).toBe('booked')
    expect(psql(`select count(*) from appointments where slot_id = '${target}' and status in ('requested', 'confirmed');`)).toBe('1')
    expect(psql(`select count(*) from appointment_transitions
      where appointment_id in ('${firstAppointment}', '${secondAppointment}');`)).toBe('0')
    expect(psql(`select count(*) from audit_events
      where target_id in ('${firstAppointment}', '${secondAppointment}') and action = 'booking.reschedule';`)).toBe('1')
  })

  test('reschedule_minimumNoticeAndInvalidState_leaveAppointmentSlotsAndHistoryUnchanged', () => {
    const near = fixture({ startsInHours: 23 })
    const nearId = appointment(near)
    expect(JSON.parse(psql(rescheduleCall(near, nearId, near.slotIds[1]!))).result_error).toBe('minimum_notice')
    expect(psql(`select slot_id || '|' || status::text from appointments where id = '${nearId}';`)).toBe(`${near.slotIds[0]}|requested`)
    expect(psql(`select status::text from slots where id = '${near.slotIds[0]}';`)).toBe('booked')
    expect(psql(`select status::text from slots where id = '${near.slotIds[1]}';`)).toBe('open')
    expect(psql(`select count(*) from appointment_transitions where appointment_id = '${nearId}';`)).toBe('0')
    expect(psql(`select count(*) from audit_events where target_id = '${nearId}';`)).toBe('0')

    psql(`update appointments set status = 'cancelled' where id = '${nearId}';`)
    expect(JSON.parse(psql(rescheduleCall(near, nearId, near.slotIds[1]!))).result_error).toBe('not_reschedulable')
    expect(psql(`select slot_id || '|' || status::text from appointments where id = '${nearId}';`)).toBe(`${near.slotIds[0]}|cancelled`)
    expect(psql(`select count(*) from appointment_transitions where appointment_id = '${nearId}';`)).toBe('0')
    expect(psql(`select count(*) from audit_events where target_id = '${nearId}';`)).toBe('0')
    expect(psql(`select status::text from slots where id = '${near.slotIds[0]}';`)).toBe('open')
    expect(psql(`select status::text from slots where id = '${near.slotIds[1]}';`)).toBe('open')
  })

  test('authenticatedCaller_cannotWeakenMinimumNoticeForRescheduleOrCancel', () => {
    const f = fixture({ startsInHours: 1 })
    const id = appointment(f)
    const weakenedNotice = "interval '0 hours'"

    expect(JSON.parse(psql(rescheduleCall(f, id, f.slotIds[1]!, weakenedNotice))).result_error).toBe('minimum_notice')
    expect(JSON.parse(psql(cancelCall(f, id, weakenedNotice))).result_error).toBe('minimum_notice')
    expect(psql(`select slot_id || '|' || status::text from appointments where id = '${id}';`)).toBe(`${f.slotIds[0]}|requested`)
    expect(psql(`select count(*) from appointment_transitions where appointment_id = '${id}';`)).toBe('0')
    expect(psql(`select count(*) from audit_events where target_id = '${id}';`)).toBe('0')
  })

  test.each(['provider', 'admin'] as const)('%sCancellation_insidePatientNoticeWindow_isAllowedAndAtomic', (role) => {
    const f = fixture({ startsInHours: 1 })
    const id = appointment(f)
    makeActorClinician(f, role)

    expect(JSON.parse(psql(cancelCall(f, id))).result_error).toBeNull()
    expect(psql(`select status::text from appointments where id = '${id}';`)).toBe('cancelled')
    expect(psql(`select status::text from slots where id = '${f.slotIds[0]}';`)).toBe('open')
    expect(psql(`select from_status::text || '|' || to_status::text || '|' || actor_user_id
      from appointment_transitions where appointment_id = '${id}';`)).toBe(`requested|cancelled|${f.actorUserId}`)
    expect(psql(`select action || '|' || actor_ref || '|' || outcome
      from audit_events where target_id = '${id}';`)).toBe(`booking.cancel|${f.actorUserId}|granted`)
  })

  test.each(['provider', 'admin'] as const)('%sWithPatientLink_cancellationUsesClinicianNoticeRules', (role) => {
    const f = fixture({ startsInHours: 1 })
    const id = appointment(f)
    makeActorClinician(f, role, true)

    expect(JSON.parse(psql(cancelCall(f, id))).result_error).toBeNull()
    expect(psql(`select status::text from appointments where id = '${id}';`)).toBe('cancelled')
    expect(psql(`select count(*) from appointment_transitions where appointment_id = '${id}';`)).toBe('1')
    expect(psql(`select count(*) from audit_events where target_id = '${id}' and action = 'booking.cancel';`)).toBe('1')
  })

  test('patientWithUnrelatedProviderRole_cannotUseThatRoleToWeakenNoticeFloor', () => {
    const f = fixture({ startsInHours: 1 })
    const id = appointment(f)
    const unrelatedProviderId = randomUUID()
    psql(`insert into providers (id, user_id, full_name, time_zone)
      values ('${unrelatedProviderId}', '${f.actorUserId}', 'Dr. Unrelated', 'America/Chicago');`)

    expectSqlState(cancelCall(f, id, "interval '0 hours'"), 'appointment is not available to caller')
    expect(psql(`select status::text from appointments where id = '${id}';`)).toBe('requested')
    expect(psql(`select count(*) from appointment_transitions where appointment_id = '${id}';`)).toBe('0')
    expect(psql(`select count(*) from audit_events where target_id = '${id}';`)).toBe('0')
  })

  test('reschedule_auditFailure_rollsBackAppointmentBothSlotsTransitionAndAudit', () => {
    const f = fixture()
    const id = appointment(f)
    psql(`create function reschedule_rpc_rollback_probe() returns trigger language plpgsql as $$
            begin raise exception 'reschedule audit rejected' using errcode = 'check_violation'; end $$;
          create trigger reschedule_rpc_rollback_probe before insert on audit_events
            for each row when (new.target_id = '${id}' and new.action = 'booking.reschedule')
            execute function reschedule_rpc_rollback_probe();`)
    try {
      expectSqlState(rescheduleCall(f, id, f.slotIds[1]!), 'reschedule audit rejected')
    } finally {
      psql('drop trigger reschedule_rpc_rollback_probe on audit_events; drop function reschedule_rpc_rollback_probe();')
    }
    expect(psql(`select slot_id || '|' || status::text from appointments where id = '${id}';`)).toBe(`${f.slotIds[0]}|requested`)
    expect(psql(`select status::text from slots where id = '${f.slotIds[0]}';`)).toBe('booked')
    expect(psql(`select status::text from slots where id = '${f.slotIds[1]}';`)).toBe('open')
    expect(psql(`select count(*) from appointment_transitions where appointment_id = '${id}';`)).toBe('0')
    expect(psql(`select count(*) from audit_events where target_id = '${id}';`)).toBe('0')
  })

  test('rescheduleRpc_defersConstraintToAllowTwoAppointmentSwapAndKeepsSlotStatesConsistent', () => {
    const f = fixture()
    const a = appointment(f, 0)
    const b = psql(`insert into appointments (slot_id, patient_id, provider_id, service_id, idempotency_key)
      values ('${f.slotIds[1]}', '${f.patientId}', '${f.providerId}', '${f.serviceId}', '${randomUUID()}') returning id;`)

    // The public reschedule contract accepts only an open target. Planting a
    // stale open marker lets this transaction reach the constraint collision;
    // the appointment triggers restore both derived states before commit.
    psql(`update slots set status = 'open' where id = '${f.slotIds[1]}';
          begin;
            set local role app_user;
            set local request.jwt.claims = ${literal(JSON.stringify({ sub: f.actorUserId }))};
            select * from reschedule_appointment(
              '${a}', '${f.slotIds[1]}', '${f.actorUserId}', ${MINIMUM_NOTICE}
            );
            reset role;
            update appointments set slot_id = '${f.slotIds[0]}' where id = '${b}';
          commit;`)
    expect(psql(`select slot_id from appointments where id = '${a}';`)).toBe(f.slotIds[1])
    expect(psql(`select slot_id from appointments where id = '${b}';`)).toBe(f.slotIds[0])
    expect(psql(`select count(*) from slots where id in ('${f.slotIds.join("','")}') and status = 'booked';`)).toBe('2')
    expect(psql(`select count(*) from appointment_transitions where appointment_id = '${a}';`)).toBe('0')
    expect(psql(`select count(*) from audit_events where target_id = '${a}' and action = 'booking.reschedule';`)).toBe('1')
  })

  test('cancel_atomicallyWritesTransitionAndOpensSlotForAnotherAppointment', () => {
    const f = fixture()
    const id = appointment(f)
    expect(JSON.parse(psql(cancelCall(f, id))).result_error).toBeNull()
    expect(psql(`select status::text from appointments where id = '${id}';`)).toBe('cancelled')
    expect(psql(`select from_status::text || '|' || to_status::text from appointment_transitions where appointment_id = '${id}';`)).toBe('requested|cancelled')
    expect(psql(`select actor_kind::text || '|' || actor_ref || '|' || action || '|' || target_kind || '|' || target_id || '|' || outcome
      from audit_events where target_id = '${id}';`)).toBe(
      `account|${f.actorUserId}|booking.cancel|appointment|${id}|granted`,
    )
    expect(psql(`select status::text from slots where id = '${f.slotIds[0]}';`)).toBe('open')
    expect(psql(`insert into appointments (slot_id, patient_id, provider_id, service_id, idempotency_key)
      values ('${f.slotIds[0]}', '${f.patientId}', '${f.providerId}', '${f.serviceId}', '${randomUUID()}') returning id;`)).toMatch(/[0-9a-f-]{36}/)
  })

  test('cancel_minimumNoticeAndTransitionFailure_rollBackEveryChange', () => {
    const f = fixture({ startsInHours: 23 })
    const nearId = appointment(f)
    expect(JSON.parse(psql(cancelCall(f, nearId))).result_error).toBe('minimum_notice')
    expect(psql(`select status::text from appointments where id = '${nearId}';`)).toBe('requested')
    expect(psql(`select status::text from slots where id = '${f.slotIds[0]}';`)).toBe('booked')
    expect(psql(`select count(*) from appointment_transitions where appointment_id = '${nearId}';`)).toBe('0')
    expect(psql(`select count(*) from audit_events where target_id = '${nearId}';`)).toBe('0')

    const far = fixture()
    const farId = appointment(far)
    psql(`create function cancel_rpc_rollback_probe() returns trigger language plpgsql as $$
            begin raise exception 'transition rejected' using errcode = 'check_violation'; end $$;
          create trigger cancel_rpc_rollback_probe before insert on appointment_transitions
            for each row execute function cancel_rpc_rollback_probe();`)
    try {
      expectSqlState(cancelCall(far, farId), 'transition rejected')
    } finally {
      psql('drop trigger cancel_rpc_rollback_probe on appointment_transitions; drop function cancel_rpc_rollback_probe();')
    }
    expect(psql(`select status::text from appointments where id = '${farId}';`)).toBe('requested')
    expect(psql(`select status::text from slots where id = '${far.slotIds[0]}';`)).toBe('booked')
    expect(psql(`select count(*) from appointment_transitions where appointment_id = '${farId}';`)).toBe('0')
    expect(psql(`select count(*) from audit_events where target_id = '${farId}';`)).toBe('0')
  })

  test('cancel_auditFailure_rollsBackAppointmentSlotTransitionAndAudit', () => {
    const f = fixture()
    const id = appointment(f)
    psql(`create function cancel_audit_rollback_probe() returns trigger language plpgsql as $$
            begin raise exception 'cancel audit rejected' using errcode = 'check_violation'; end $$;
          create trigger cancel_audit_rollback_probe before insert on audit_events
            for each row when (new.target_id = '${id}' and new.action = 'booking.cancel')
            execute function cancel_audit_rollback_probe();`)
    try {
      expectSqlState(cancelCall(f, id), 'cancel audit rejected')
    } finally {
      psql('drop trigger cancel_audit_rollback_probe on audit_events; drop function cancel_audit_rollback_probe();')
    }
    expect(psql(`select status::text from appointments where id = '${id}';`)).toBe('requested')
    expect(psql(`select status::text from slots where id = '${f.slotIds[0]}';`)).toBe('booked')
    expect(psql(`select count(*) from appointment_transitions where appointment_id = '${id}';`)).toBe('0')
    expect(psql(`select count(*) from audit_events where target_id = '${id}';`)).toBe('0')
  })

  test('appUser_canExecuteRpcWithoutReceivingNewDirectSlotPrivileges', () => {
    const f = fixture()
    const id = appointment(f)
    expect(JSON.parse(psql(cancelCall(f, id))).result_error).toBeNull()
    expectSqlState(appSql(f.actorUserId, `update slots set status = 'booked' where id = '${f.slotIds[0]}';`), 'permission denied for table slots')
    expect(psql(`select has_table_privilege('app_user', 'appointments', 'UPDATE')::text || '|' ||
      has_table_privilege('app_user', 'appointment_transitions', 'INSERT')::text;`)).toBe('false|false')
    expect(psql(`select has_table_privilege('booking_executor', 'audit_events', 'INSERT')::text || '|' ||
      has_table_privilege('booking_executor', 'audit_events', 'SELECT')::text || '|' ||
      has_table_privilege('booking_executor', 'audit_events', 'UPDATE')::text || '|' ||
      has_table_privilege('booking_executor', 'audit_events', 'DELETE')::text;`)).toBe('true|false|false|false')
    expect(psql(`select has_sequence_privilege('booking_executor', 'audit_events_id_seq', 'USAGE')::text || '|' ||
      has_sequence_privilege('booking_executor', 'audit_events_id_seq', 'SELECT')::text || '|' ||
      has_sequence_privilege('booking_executor', 'audit_events_id_seq', 'UPDATE')::text;`)).toBe('true|false|false')
  })
})
