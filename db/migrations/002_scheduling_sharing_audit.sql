-- Several windows per weekday, because one row per weekday cannot express a
-- lunch break — 09:00-12:00 plus 13:00-17:00 is the ordinary case and the
-- old `unique (provider_id, weekday)` rejected it outright.
create table working_hours (
  id              uuid primary key default gen_random_uuid(),
  provider_id     uuid not null references providers(id) on delete cascade,
  weekday         int  not null check (weekday between 0 and 6),  -- 0 = Sunday
  starts_local    time not null,
  ends_local      time not null,
  check (ends_local > starts_local),
  -- windows on the same weekday may not overlap each other.
  -- Postgres has no `timerange`, so this ranges over seconds-from-midnight;
  -- `extract(epoch from time)` is immutable, which an EXCLUDE requires.
  exclude using gist (
    provider_id with =,
    weekday with =,
    numrange(extract(epoch from starts_local)::numeric,
             extract(epoch from ends_local)::numeric) with &&)
);

create table availability_blocks (
  id              uuid primary key default gen_random_uuid(),
  provider_id     uuid not null references providers(id) on delete cascade,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  reason          text,
  check (ends_at > starts_at)
);

create table slots (
  id              uuid primary key default gen_random_uuid(),
  provider_id     uuid not null references providers(id) on delete cascade,
  starts_at       timestamptz not null,
  ends_at         timestamptz not null,
  status          slot_status not null default 'open',
  check (ends_at > starts_at),
  unique (provider_id, starts_at),
  -- identical starts were already refused; OVERLAPPING ones were not, which
  -- bites the moment a provider changes slot_minutes under ADR-0006.
  exclude using gist (provider_id with =, tstzrange(starts_at, ends_at) with &&)
);
create index on slots (provider_id, starts_at) where status = 'open';

create table appointments (
  id               uuid primary key default gen_random_uuid(),
  slot_id          uuid not null references slots(id),
  patient_id       uuid not null references patients(id) on delete cascade,
  provider_id      uuid not null references providers(id),
  service_id       uuid not null references services(id),
  status           appointment_status not null default 'requested',
  out_of_hours     boolean not null default false,   -- ADR-0006
  idempotency_key  text,                             -- EC-10
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- FR-12 backstop: at most one live appointment per slot, whatever the app does.
-- An EXCLUDE constraint rather than a unique index, because it can be DEFERRED —
-- without that, two patients swapping slots is impossible even sequentially:
-- the first UPDATE always collides with the row the second is about to vacate.
-- Verified both ways. (btree_gist is created at the top of this schema.)
alter table appointments add constraint appointments_one_live_per_slot
  exclude using gist (slot_id with =)
  where (status in ('requested','confirmed'))
  deferrable initially immediate;

-- EC-10: a retried submit resolves to the same appointment.
create unique index appointments_idempotency
  on appointments (patient_id, idempotency_key)
  where idempotency_key is not null;

-- `slots.status` is DERIVED, never a second source of truth.
-- SECURITY DEFINER so the app role needs no UPDATE on slots at all (§4).
create or replace function sync_slot_status() returns trigger
language plpgsql security definer set search_path = public as $$
declare touched uuid[];
begin
  touched := array_remove(array[ (case when tg_op <> 'INSERT' then old.slot_id end),
                                 (case when tg_op <> 'DELETE' then new.slot_id end) ], null);
  update slots s set status = case
    when exists (select 1 from appointments a
                  where a.slot_id = s.id and a.status in ('requested','confirmed'))
    then 'booked'::slot_status else 'open'::slot_status end
  where s.id = any(touched);
  return null;
end $$;

create trigger slots_follow_appointments
  after insert or update or delete on appointments
  for each row execute function sync_slot_status();

-- EC-11 backstop. Enforces the ORDERING of §6's matrix — the half that does not
-- depend on who is acting. Role permission stays in lib/scheduling/lifecycle.ts,
-- because the database does not know the actor.
create or replace function appointments_guard_transition() returns trigger
language plpgsql as $$
begin
  if new.status is distinct from old.status then
    if old.status in ('completed','cancelled','no_show') then
      raise exception 'invalid_transition: % is terminal, cannot become %',
        old.status, new.status using errcode = 'check_violation';
    end if;
    if not (
         (old.status = 'requested' and new.status in ('confirmed','cancelled'))
      or (old.status = 'confirmed' and new.status in ('completed','no_show','cancelled'))
    ) then
      raise exception 'invalid_transition: % cannot become %',
        old.status, new.status using errcode = 'check_violation';
    end if;
    -- EC-11: no-show applies only once the start instant has passed. The
    -- instant lives on slots, so it is read through the join.
    if new.status = 'no_show'
       and (select s.starts_at from slots s where s.id = new.slot_id) > now() then
      raise exception 'invalid_transition: no_show before the appointment start'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

create trigger appointments_no_exit_from_terminal
  before update of status on appointments
  for each row execute function appointments_guard_transition();

-- `updated_at` was declared and never maintained.
create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger appointments_touch_updated_at
  before update on appointments
  for each row execute function touch_updated_at();

create table appointment_transitions (
  id              uuid primary key default gen_random_uuid(),
  appointment_id  uuid not null references appointments(id) on delete cascade,
  from_status     appointment_status,
  to_status       appointment_status not null,
  actor_user_id   uuid references auth.users(id),
  occurred_at     timestamptz not null default now()
);

-- ── sharing (FR-5, FR-8) ────────────────────────────────────────────────
-- A single polymorphic `resource_id` cannot carry an FK at all; two typed
-- nullable columns can, and a COMPOSITE FK through (id, patient_id) forces the
-- resource's owner to equal the link's owner.
create table share_links (
  id              uuid primary key default gen_random_uuid(),
  token_hash      text not null unique,          -- sha256; raw token never stored
  patient_id      uuid not null references patients(id) on delete cascade,
  image_id        uuid,
  report_id       uuid,
  created_by      uuid not null references auth.users(id),
  recipient_email text not null,
  expires_at      timestamptz not null,
  revoked_at      timestamptz,
  created_at      timestamptz not null default now(),

  -- exactly one target, never zero and never both
  check (num_nonnulls(image_id, report_id) = 1),

  -- the target must belong to the patient the link claims
  foreign key (image_id,  patient_id) references images  (id, patient_id),
  foreign key (report_id, patient_id) references reports (id, patient_id),

  -- §6 still speaks `resourceKind`; it is derived, not stored twice
  resource_kind text generated always as
    (case when image_id is not null then 'image' else 'report' end) stored
);
create index on share_links (patient_id, created_at desc);

-- ── slot regeneration (ADR-0006, ADR-0012) ──────────────────────────────
-- §4 grants the application role no DELETE anywhere, and that property is what
-- makes the audit log and the appointment history safe. An availability edit
-- still has to remove open slots that no longer fit. So removal is one
-- SECURITY DEFINER function with a narrow, reviewed job: it deletes only slots
-- in range that are still `open` and that no live appointment references, then
-- inserts the new grid. The app role gains no privilege of its own.
create or replace function regenerate_provider_slots(
  p_provider_id uuid,
  p_from        timestamptz,
  p_to          timestamptz,
  p_slots       tstzrange[]
) returns table (removed int, generated int)
language plpgsql security definer set search_path = public as $$
declare v_removed int; v_generated int;
begin
  delete from slots s
   where s.provider_id = p_provider_id
     and s.starts_at >= p_from and s.starts_at < p_to
     and s.status = 'open'
     and not exists (select 1 from appointments a
                      where a.slot_id = s.id
                        and a.status in ('requested','confirmed'));
  get diagnostics v_removed = row_count;

  -- Skip any proposed slot that OVERLAPS a survivor, not merely one that shares
  -- its start instant. Verified by execution: with `on conflict (provider_id,
  -- starts_at) do nothing` alone, a booked 00:30–01:00 slot and a new hourly
  -- 00:00–01:00 slot have different starts, so the exclusion constraint fires
  -- and the whole rebuild aborts — a provider changing their slot length on a
  -- day holding one appointment could not save at all.
  insert into slots (provider_id, starts_at, ends_at)
  select p_provider_id, lower(r), upper(r)
    from unnest(p_slots) r
   where not exists (select 1 from slots s
                      where s.provider_id = p_provider_id
                        and tstzrange(s.starts_at, s.ends_at) && r)
  on conflict (provider_id, starts_at) do nothing;   -- backstop under concurrency
  get diagnostics v_generated = row_count;

  return query select v_removed, v_generated;
end $$;

revoke all on function regenerate_provider_slots(uuid, timestamptz, timestamptz, tstzrange[]) from public;

-- ── indexes on foreign keys (the 002 half of §3's block) ────────────────
create index on appointments (patient_id);
create index on appointments (slot_id);
create index on appointments (provider_id);
create index on appointment_transitions (appointment_id);
create index on availability_blocks (provider_id);
create index on working_hours (provider_id);

-- ── reminders (FR-15, EC-9) ─────────────────────────────────────────────
create table reminder_sends (
  appointment_id  uuid not null references appointments(id) on delete cascade,
  lead_hours      int  not null,
  sent_at         timestamptz,
  attempted_at    timestamptz not null default now(),
  outcome         text not null check (outcome in ('sent','failed','skipped')),
  -- 'sent' with no sent_at would make PF-8's reliability figure unfalsifiable
  check ((outcome = 'sent') = (sent_at is not null)),
  primary key (appointment_id, lead_hours)      -- EC-9: idempotency, structural
);

-- ── outbound email (CQ-3) ───────────────────────────────────────────────
-- A failed send must be retried, not merely reported. The app runs as
-- short-lived functions, so an in-process queue dies with the request that
-- created it: the queue is a table, drained by the same 5-minute job that
-- sends reminders (§12).
create table email_outbox (
  id              uuid primary key default gen_random_uuid(),
  recipient       text not null,
  subject         text not null,
  body            text not null,               -- generic notice + link; no PHI (SEC-9)
  attempts        int  not null default 0,
  last_error      text,                        -- never PHI
  next_attempt_at timestamptz not null default now(),
  sent_at         timestamptz,
  created_at      timestamptz not null default now()
);
create index on email_outbox (next_attempt_at) where sent_at is null;

-- ── deletion requests (SEC-5) ───────────────────────────────────────────
-- The PRD asks that a patient can *request* deletion, not that a button erases
-- records — which would collide with the append-only audit log above.
create table deletion_requests (
  id              uuid primary key default gen_random_uuid(),
  patient_id      uuid not null references patients(id) on delete cascade,
  requested_by    uuid not null references auth.users(id),
  requested_at    timestamptz not null default now(),
  status          text not null default 'received'
                  check (status in ('received','in_review','completed','declined')),
  unique (patient_id, status) deferrable initially deferred
);
create index on deletion_requests (patient_id, requested_at desc);

-- ── audit (SEC-4) ───────────────────────────────────────────────────────
create table audit_events (
  id              bigserial primary key,
  occurred_at     timestamptz not null default now(),
  actor_kind      actor_kind not null,
  actor_ref       text,                          -- user id or share_link id
  action          text not null check (action in (
                    'identity.verify','identity.lockout','identity.link',
                    'study.view','image.view','clip.view','report.view',
                    'share.create','share.use','share.revoke','share.view',
                    'booking.create','booking.reschedule','booking.cancel',
                    'appointment.view','appointment.transition','schedule.view',
                    'availability.update','availability.collision',
                    'reminder.dispatch','audit.view','profile.deletion_request')),
  target_kind     text not null,
  target_id       uuid,
  outcome         text not null check (outcome in ('granted','denied')),
  detail          jsonb                          -- never PHI (SEC-6)
);
create index on audit_events (occurred_at desc);
create index on audit_events (actor_ref, occurred_at desc);

revoke all on audit_events from public;
grant select, insert on audit_events to app_user;
-- deliberately NOT granted: update, delete
grant usage, select on sequence audit_events_id_seq to app_user;
