-- Required by every EXCLUDE constraint below that ranges over a uuid or an
-- int alongside a range type. Must come first: an EXCLUDE on `slots` fails
-- with "uuid has no default operator class for gist" without it.
create extension if not exists btree_gist;

create type slot_status         as enum ('open', 'booked');
create type appointment_status  as enum ('requested','confirmed','completed','cancelled','no_show');
create type report_status       as enum ('preliminary','signed');
create type visit_status        as enum ('scheduled','completed','cancelled');
create type actor_kind          as enum ('account','share_recipient','system');

-- The role is created here, in the first migration that references it. §4's
-- grant block runs later and assumes it exists — declared in the wrong order,
-- migration 001 dies on `role "app_user" does not exist`. Idempotent via a
-- duplicate_object rescue rather than an `if not exists (select ... from
-- pg_roles)` check, because a pre-check would itself name `app_user` before
-- this statement does, and tests/db/migration-001.test.ts's
-- appUserRoleCreatedFirst pins this as the first reference. The role is
-- cluster-global and shared across concurrent runs (see
-- tests/setup/postgres.ts) — it must survive a repeat CREATE, never be
-- dropped and recreated.
do $$
begin
  create role app_user nologin;                -- on Supabase this is `authenticated`
exception when duplicate_object then
  null;
end
$$;

-- ── people ──────────────────────────────────────────────────────────────
create table patients (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid unique references auth.users(id) on delete set null,
  patient_ref     text not null unique,          -- typed at FR-2; 'PT-' + 4 digits (CONTEXT.md)
  date_of_birth   date not null,
  full_name       text not null,
  email           text not null,
  phone           text,                          -- FR-1 profile; optional
  created_at      timestamptz not null default now()
);

create table providers (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid unique references auth.users(id) on delete set null,
  full_name       text not null,
  time_zone       text not null,                 -- IANA, e.g. 'America/Chicago'
  slot_minutes    int  not null default 30 check (slot_minutes between 5 and 240),
  created_at      timestamptz not null default now()
);

create or replace function providers_validate_time_zone() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from pg_timezone_names where name = new.time_zone) then
    raise exception 'unknown time zone: %', new.time_zone
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger providers_time_zone_valid
  before insert or update of time_zone on providers
  for each row execute function providers_validate_time_zone();

create table staff_admins (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid unique references auth.users(id) on delete cascade,
  created_at      timestamptz not null default now()
);

-- ── services (FR-11: "open slots for the chosen provider/service") ───────
create table services (
  id              uuid primary key default gen_random_uuid(),
  slug            text not null unique,          -- 'obstetric', 'renal', …
  name            text not null,
  created_at      timestamptz not null default now()
);

create table provider_services (
  provider_id     uuid not null references providers(id) on delete cascade,
  service_id      uuid not null references services(id) on delete cascade,
  primary key (provider_id, service_id)
);

-- ── FR-2 identity verification ──────────────────────────────────────────
-- There is no `identity_unlocks` table. ADR-0011 removed the expiring unlock:
-- FR-2's whole persistent effect is `patients.user_id`, written once by a
-- successful verification. Attempts are still recorded — EC-1's lockout is
-- derived from them.
create table identity_attempts (
  id                    uuid primary key default gen_random_uuid(),
  attempted_patient_ref text not null,           -- as typed; never resolved
  source_ref            text not null,           -- coarse client identifier
  user_id               uuid references auth.users(id) on delete set null,
  succeeded             boolean not null,
  attempted_at          timestamptz not null default now()
);
create index on identity_attempts (attempted_patient_ref, attempted_at desc);
create index on identity_attempts (source_ref, attempted_at desc);

-- ── imaging ─────────────────────────────────────────────────────────────
create table visits (
  id              uuid primary key default gen_random_uuid(),
  patient_id      uuid not null references patients(id) on delete cascade,
  provider_id     uuid not null references providers(id),
  occurred_at     timestamptz not null,
  status          visit_status not null,
  created_at      timestamptz not null default now()
);
create index on visits (patient_id, status);

create table studies (
  id              uuid primary key default gen_random_uuid(),
  visit_id        uuid not null references visits(id) on delete cascade,
  patient_id      uuid not null references patients(id) on delete cascade,
  description     text not null,
  created_at      timestamptz not null default now()
);
create index on studies (patient_id);

create table images (
  id              uuid primary key default gen_random_uuid(),
  study_id        uuid not null references studies(id) on delete cascade,
  patient_id      uuid not null references patients(id) on delete cascade,
  storage_key     text not null,                 -- random UUID path, ADR-0003
  thumb_key       text,                          -- EL-1
  width           int  not null,
  height          int  not null,
  ordinal         int  not null,
  unique (study_id, ordinal),
  -- the target of share_links' composite FK; redundant with the pk on its own,
  -- but a composite FK can only reference a declared unique constraint
  unique (id, patient_id)
);

create table cine_clips (
  id              uuid primary key default gen_random_uuid(),
  study_id        uuid not null references studies(id) on delete cascade,
  patient_id      uuid not null references patients(id) on delete cascade,
  frame_count     int  not null check (frame_count between 1 and 100),
  default_fps     int  not null default 12 check (default_fps between 1 and 60),
  poster_key      text,                          -- EL-1 first-frame thumbnail
  created_at      timestamptz not null default now()
);

create table cine_frames (
  clip_id         uuid not null references cine_clips(id) on delete cascade,
  frame_index     int  not null check (frame_index >= 0),
  storage_key     text not null,
  primary key (clip_id, frame_index)
);

-- ── reports (ADR-0007) ──────────────────────────────────────────────────
create table reports (
  id              uuid primary key default gen_random_uuid(),
  study_id        uuid not null references studies(id) on delete cascade,
  patient_id      uuid not null references patients(id) on delete cascade,
  status          report_status not null,
  findings        text not null,
  impression      text not null,
  signed_by       uuid references providers(id),
  signed_at       timestamptz,
  created_at      timestamptz not null default now(),
  constraint signed_fields_present check (
    (status = 'signed'      and signed_by is not null and signed_at is not null) or
    (status = 'preliminary' and signed_by is null     and signed_at is null)
  ),
  unique (id, patient_id)          -- target of share_links' composite FK
);
create index on reports (patient_id, status);

-- ── indexes on foreign keys (the 001 half of §3's block) ────────────────
create index on cine_clips (study_id);
create index on cine_frames (clip_id);
create index on images (study_id);
create index on reports (study_id);
create index on studies (visit_id);
create index on visits (provider_id);
create index on provider_services (service_id);
