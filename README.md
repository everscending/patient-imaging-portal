# Patient Imaging Portal

A patient-facing portal for viewing ultrasound imaging studies, cine clips and
reports, sharing them with a recipient's email, and booking appointments. See
`PRD.md`, `REQUIREMENTS.md` and `ARCHITECTURE.md` for the full specification,
and `docs/README.md` for the rest of the documentation set.

## Getting started

```
npm install
cp .env.example .env   # fill in a Supabase project's real values
npm run dev
```

The app listens on `PORT`, default **4310** — see `ARCHITECTURE.md` §9 for why
a bare `3000` never appears anywhere in this repo.

## Authentication

Registration and sign-in are Supabase Auth (`ADR-0004`): the two screens
(`/register`, `/login`) never call Supabase directly, posting instead to this
app's own `POST /api/auth/register` and `POST /api/auth/login`, which validate
the request through `lib/validation` before Supabase Auth ever sees it
(`ADR-0012` #15).

**Sessions expire after 60 minutes of inactivity.** That is a Supabase Auth
project setting, not a variable this app reads — see `docs/deploy.md` for
where it is configured.

Passwords are hashed by Supabase Auth (bcrypt/argon2), never by this repo's own
code, and are never logged, rendered, or placed in a URL (SEC-7).
