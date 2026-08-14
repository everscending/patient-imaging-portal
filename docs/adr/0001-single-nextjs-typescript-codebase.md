# ADR-0001 — One Next.js TypeScript codebase, route handlers as the API

- **Status:** Accepted
- **Date:** 2026-08-14
- **Requirements touched:** all of them; most directly CQ-8 (CI), DEL-5 (grader quick-start)

## Context

`PRD.md` offers a choice of backend — C# (ASP.NET Core Web API) or Node/Express —
and separately specifies React/Next.js for the frontend. It also lists backend
hosting (Render/Railway) and frontend hosting (Vercel/Netlify) as separate
concerns, which implies two deployables. Substitution is explicitly allowed
where justified.

The binding constraint is the timebox: three days, with 40 of the 100 rubric
points concentrated in Priority 1 and Priority 2 (imaging and report delivery)
and a further 20 in security and compliance. Anything spent on integration
between two codebases is spent away from those rows.

## Decision

One TypeScript codebase. A Next.js application supplies both the React UI and
the HTTP API, the latter as Next route handlers under `app/api/`. Domain logic
lives in `lib/` as plain TypeScript modules that route handlers call, so the
business rules are testable without an HTTP layer.

```
app/            React UI — patient, provider, admin
app/api/        route handlers — the API surface
lib/            domain services: access, imaging, reports, booking, share, audit
db/             migrations + seed
tests/          Vitest unit/integration
e2e/            Playwright
k6/             load scripts
```

## Consequences

**Gained.** One `package.json`, one lint config, one type system spanning wire
shapes, one test runner for unit and integration work, one CI job, one deploy.
Request and response types are shared by construction rather than duplicated or
published, which removes an entire class of drift between the two halves. DEL-5
("a reviewer can install, seed, run, and test in minutes") becomes a single
install.

**Given up.** No process boundary between UI and API — the discipline that a
separate service enforces structurally must instead be maintained by convention:
route handlers stay thin, and every rule that matters lives in `lib/` where a
test can reach it directly.

**Accepted risk.** Route handlers run as serverless functions on the chosen host
(see ADR-0002), so there is no long-lived process. Two consequences follow and
are handled elsewhere: scheduled work cannot live in-process (ADR-0002 uses
`pg_cron`), and per-request byte streaming is expensive (ADR-0003 avoids it).

## Alternatives considered

**Node/Express API plus a separate Next.js UI.** The PRD's literal split. Buys a
real process boundary, a long-running process with a genuine connection pool,
and in-process scheduling. Costs a second deploy, CORS configuration, a shared
types strategy, and two CI jobs — roughly half a day of the three-day budget on
plumbing, paid before any rubric row moves.

**C# ASP.NET Core API plus a Next.js UI.** The PRD's first-named backend. EF Core
migrations and first-class transactional row locking are a good fit for FR-12,
and xUnit is solid. But it splits the build across two languages and two
toolchains, and carries the largest setup cost of the three options. Justified
only if C# were the strongest available language here; it is not.
