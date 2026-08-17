// db/seed/fixtures-out-of-hours.ts — ADR-0009's EC-8 fixture.  The row set
// has already booked the deterministic notice-window appointment when this
// runs.  We narrow its provider's availability through the scheduling RPC;
// this fixture never assigns the derived appointment flag itself.
import type { SeedDbClient } from './index'
import type { RowSet, WorkingHoursRow } from './rows'

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

function narrowHours(hours: WorkingHoursRow[], weekdayToRemove: number): Array<{ weekday: number; startsLocal: string; endsLocal: string }> {
  return hours
    .filter((hour) => hour.weekday !== weekdayToRemove)
    .map((hour) => ({ weekday: hour.weekday, startsLocal: hour.starts_local, endsLocal: hour.ends_local }))
}

/**
 * The seed's database client is intentionally transport-agnostic, so this
 * adapter calls the same transactional scheduling operation that
 * `lib/scheduling/availability.ts` reaches through PostgREST.  Its SQL
 * assertion makes the returned `preserved_out_of_hours` result part of the
 * seed contract rather than an ignored side effect.
 */
async function applyAvailability(input: {
  db: SeedDbClient
  providerId: string
  actorUserId: string
  slotMinutes: number
  workingHours: Array<{ weekday: number; startsLocal: string; endsLocal: string }>
  blocks: Array<{ startsAt: string; endsAt: string; reason: string }>
  startsAt: string
  endsAt: string
  appointmentId: string
  appointmentSlotId: string
  appointmentStatus: string
}): Promise<void> {
  const workingHours = sqlLiteral(JSON.stringify(input.workingHours))
  const blocks = sqlLiteral(JSON.stringify(input.blocks))
  const providerId = sqlLiteral(input.providerId)
  const actorUserId = sqlLiteral(input.actorUserId)
  const startsAt = sqlLiteral(input.startsAt)
  const endsAt = sqlLiteral(input.endsAt)
  const appointmentId = sqlLiteral(input.appointmentId)
  const appointmentSlotId = sqlLiteral(input.appointmentSlotId)
  const appointmentStatus = sqlLiteral(input.appointmentStatus)

  await input.db.execute(`
do $$
declare
  availability_result record;
  preserved jsonb;
  preserved_appointment jsonb;
  appointment_start timestamptz;
  appointment_slot uuid;
  appointment_status appointment_status;
begin
  perform set_config('request.jwt.claim.sub', ${actorUserId}, true);
  select * into availability_result
    from apply_provider_availability(
      ${providerId}::uuid,
      ${actorUserId}::uuid,
      ${input.slotMinutes},
      ${workingHours}::jsonb,
      ${blocks}::jsonb,
      ${startsAt}::timestamptz,
      ${endsAt}::timestamptz,
      array[]::tstzrange[]
    );

  preserved := availability_result.preserved_out_of_hours;
  if jsonb_array_length(preserved) = 0 then
    raise exception 'db/seed/fixtures-out-of-hours: applyAvailability preserved no out-of-hours appointments';
  end if;

  select item into preserved_appointment
    from jsonb_array_elements(preserved) item
   where item->>'appointmentId' = ${appointmentId};
  if preserved_appointment is null then
    raise exception 'db/seed/fixtures-out-of-hours: applyAvailability did not preserve the booked fixture appointment';
  end if;

  select s.starts_at, a.slot_id, a.status
    into appointment_start, appointment_slot, appointment_status
    from appointments a join slots s on s.id = a.slot_id
   where a.id = ${appointmentId}::uuid;
  if appointment_start is distinct from ${startsAt}::timestamptz
     or appointment_slot is distinct from ${appointmentSlotId}::uuid
     or appointment_status is distinct from ${appointmentStatus}::appointment_status then
    raise exception 'db/seed/fixtures-out-of-hours: availability edit replaced or changed the booked fixture appointment';
  end if;

  if not exists (select 1 from appointments where out_of_hours) then
    raise exception 'db/seed/fixtures-out-of-hours: availability edit produced no out-of-hours appointment';
  end if;
end $$;
`)
}

/** Drive the deterministic booked notice-window appointment through EC-8. */
export async function seedOutOfHoursFixture(input: { db: SeedDbClient; rowSet: RowSet; sourceSeed: string }): Promise<void> {
  const appointment = input.rowSet.appointments.find((row) => row.id === input.rowSet.fixtures.noticeWindowOutsideAppointmentId)
  if (!appointment) throw new Error(`db/seed/fixtures-out-of-hours: ${input.sourceSeed} selected no booked appointment`)

  const slot = input.rowSet.slots.find((row) => row.id === appointment.slot_id)
  const provider = input.rowSet.providers.find((row) => row.id === appointment.provider_id)
  if (!slot || !provider || !provider.user_id) {
    throw new Error(`db/seed/fixtures-out-of-hours: ${input.sourceSeed} selected an appointment without its provider, slot, or actor`)
  }

  const weekday = new Date(slot.starts_at).getUTCDay()
  const workingHours = narrowHours(input.rowSet.workingHours.filter((row) => row.provider_id === provider.id), weekday)
  if (workingHours.length === 0) throw new Error('db/seed/fixtures-out-of-hours: narrowed provider hours must remain usable')

  await applyAvailability({
    db: input.db,
    providerId: provider.id,
    actorUserId: provider.user_id,
    slotMinutes: provider.slot_minutes,
    workingHours,
    blocks: input.rowSet.availabilityBlocks
      .filter((row) => row.provider_id === provider.id)
      .map((row) => ({ startsAt: row.starts_at, endsAt: row.ends_at, reason: row.reason })),
    startsAt: slot.starts_at,
    endsAt: slot.ends_at,
    appointmentId: appointment.id,
    appointmentSlotId: appointment.slot_id,
    appointmentStatus: appointment.status,
  })
}
