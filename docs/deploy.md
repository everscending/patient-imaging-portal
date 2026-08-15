# Deployment settings that live outside this repo

Values the app depends on but does not itself read or store — set once in the
hosting platform's dashboard, not in `.env` or `lib/config.ts`.

## Session lifetime — 60 minutes of inactivity

`/login` and `/register` both state: "You'll be signed out after 60 minutes of
inactivity." (ADR-0012 #6, `UX_SPEC.md` §4.1).

That number is a **Supabase Auth project setting**, not an application
variable — `lib/config.ts` reads no session TTL (`ARCHITECTURE.md` §8). It is
set in the Supabase dashboard for this project:

**Project Settings → Authentication → Sessions → Inactivity timeout → 60
minutes.**

Supabase Auth issues, refreshes and expires the session JWT accordingly
(ADR-0004); this app only reads the `expiresAt` that `POST /api/auth/login`
returns and states the number in the two screens' copy. Changing the number
means changing the dashboard setting and this file and the two screens'
copy together — none of the three can drift from the others silently, because
none of them is computed from another.
