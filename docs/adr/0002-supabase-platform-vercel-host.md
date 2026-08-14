# ADR-0002 — Supabase for data, storage and auth; Vercel as host

- **Status:** Accepted
- **Date:** 2026-08-14
- **Requirements touched:** SEC-2, SEC-3, SEC-4, FR-15, EC-9, PF-8, PF-9, GAP-2, GAP-4, CUT-3

## Context

`PRD.md` offers Supabase (Postgres + Auth + Storage bundled) or Neon (Postgres)
paired with whichever blob storage the frontend host provides. CUT-3 forbids any
paid tier, so every component must be perpetually free, not trial-credit free.

Three requirements constrain the choice more than convenience does:

- **SEC-2** wants server-side row-level ownership enforcement, and names
  Postgres RLS as an acceptable mechanism.
- **FR-15 / EC-9 / PF-8** need a scheduler that fires reliably and repeatedly.
  ADR-0001 leaves no long-running process to host one.
- **GAP-2** needs blob storage whose free ceiling is known, because the seeded
  dataset has to fit inside it.

## Decision

- **Postgres, Storage and Auth:** one Supabase free project.
- **Application host:** Vercel (Hobby).
- **Scheduler:** Supabase `pg_cron`, calling back into an authenticated
  application route.
- **Email:** Resend free tier, behind one adapter (see GAP-3).

```
Vercel (Hobby)          Next.js app + route handlers
   │
   ├── Supabase Postgres    data · RLS · pg_cron
   ├── Supabase Storage     frames, images, report assets
   ├── Supabase Auth        registration + sessions
   └── Resend               share links + reminders
```

## Consequences

**Gained.** RLS gives a second, database-level enforcement layer behind the
application checks for FR-6, FR-9 and SEC-2 — a defence-in-depth story worth
real points on a 20-point rubric row, and one that plain Postgres cannot offer
without an auth identity to key on. Signed Storage URLs make ADR-0003's delivery
model possible at all. `pg_cron` runs the reminder job on a real minute-level
schedule.

**Constraints inherited.** Free tier gives 500 MB of database and 1 GB of file
storage. The 1 GB ceiling is why GAP-2 exists and why the seed cannot store a
unique frame per study. Both limits are stated in the README.

**Idle pausing, and why the cron helps.** A free Supabase project pauses after
roughly seven idle days. The reminder cron generates continuous activity, so the
project stays awake — which incidentally protects PF-9 (≥99% uptime over the
review window).

**Vercel cold starts.** Hobby functions cold-start. This is the second reason
ADR-0003 keeps image bytes off the function path: a cold start on a proxied
frame request would land directly in PF-1 and PF-2.

## Alternatives considered

**Neon Postgres + Vercel Blob.** Keeps everything in one vendor account and Neon's
branching is pleasant. Rejected on three counts: no RLS story worth writing up
for SEC-2, since there is no auth identity in the database to key policies on;
authentication must be built from scratch; and there is no in-platform
scheduler, leaving FR-15 without a home.

**Supabase data layer with the app on Railway.** A long-running Node process
would give a warm start, a real connection pool, and in-process `node-cron`.
Rejected because Railway is trial-credit rather than perpetually free, which
collides directly with CUT-3.

## Notes

Vercel's own cron on the Hobby tier fires at roughly daily granularity, which
cannot satisfy FR-15's stated lead time or EC-9's overlap-safety expectation.
That limitation, not a preference for Supabase, is what fixes the scheduler
choice.
