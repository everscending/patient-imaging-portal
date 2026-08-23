-- Availability saves 503 for any provider with a cancelled appointment:
-- cancelling reopens the slot to 'open' but the appointment keeps its
-- slot_id (FK, not null), so 002's delete guard — which only spares slots
-- with a live requested/confirmed appointment — tries to delete a slot a
-- cancelled appointment still references, appointments_slot_id_fkey blocks
-- it, and the whole apply_provider_availability transaction aborts.
--
-- Fix: never delete a slot any appointment references, regardless of
-- status. Surviving slots stay bookable; the insert below already skips
-- proposed slots that overlap a survivor, so regeneration still completes.
-- A survivor outside the new hours remains bookable — accept-and-flag
-- (ADR-0006) marks any such booking out_of_hours.
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
                      where a.slot_id = s.id);
  get diagnostics v_removed = row_count;

  -- Skip any proposed slot that OVERLAPS a survivor, not merely one that shares
  -- its start instant (see 002 for the slot-length-change failure this avoids).
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
