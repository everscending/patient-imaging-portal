-- Creates the one private Storage bucket ADR-0002 and §9 pin: `phi`, public
-- access off, no second bucket. Bucket creation is committed SQL, not a
-- console click (CQ-6) — this file is the reviewable artifact.
--
-- Idempotent: `id` is storage.buckets' primary key, so a rerun never
-- inserts a second row. The `do update` (not `do nothing`) also makes it
-- self-healing — if a console click ever flips `public` to true, rerunning
-- this file puts it back to false rather than leaving the drift in place.
--
-- No policy is created on storage.objects for this bucket. ADR-0003's
-- service role mints short-lived signed URLs for every read; a select
-- policy for `anon` or `authenticated` here would let objects be fetched
-- without one, making the signature decorative.
insert into storage.buckets (id, name, public)
values ('phi', 'phi', false)
on conflict (id) do update set public = false;
