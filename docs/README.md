# Documentation index

An index of the documentation actually committed under `docs/` in this
worktree. It links to each document; it does not restate a policy, a
parameter, or a number that document already states — see that document for
the fact itself.

The coverage report, EL-1 benchmark, and recorded demo each belong here once
their own ticket lands and creates the file. None exists in this worktree yet,
so none is linked below — a link with nothing behind it is worse than no link.

## Policies

- [Retention and deletion](retention-and-deletion.md)

## Architecture Decision Records (`docs/adr/`)

- [ADR-0001 — One Next.js TypeScript codebase, route handlers as the API](adr/0001-single-nextjs-typescript-codebase.md)
- [ADR-0002 — Supabase for data, storage and auth; Vercel as host](adr/0002-supabase-platform-vercel-host.md)
- [ADR-0003 — PHI bytes travel by short-lived signed URL, issued by an audited grant](adr/0003-phi-delivery-audited-grant-signed-urls.md)
- [ADR-0004 — Supabase Auth for login; a server-side record for the identity unlock](adr/0004-auth-and-server-side-identity-unlock.md)
- [ADR-0005 — Build EL-1 only; cut every other elective](adr/0005-elective-scope-el1-only.md)
- [ADR-0006 — An availability edit is accepted; a colliding appointment is preserved and flagged](adr/0006-availability-edit-accepts-and-flags-booked-slots.md)
- [ADR-0007 — Reports are structured rows in Postgres, rendered by a React component](adr/0007-reports-structured-in-postgres.md)
- [ADR-0008 — The five stated-rule parameters](adr/0008-stated-rule-parameters.md)
- [ADR-0009 — The seed uses a shared synthetic asset pool at full row counts](adr/0009-seed-shared-synthetic-asset-pool.md)
- [ADR-0010 — Design system: AS Software brand, muted](adr/0010-design-system.md)
- [ADR-0011 — Identity verification is a one-time account link, with no expiring unlock](adr/0011-identity-verification-is-a-one-time-account-link.md)
- [ADR-0012 — The twenty-two closures that writing the tickets forced](adr/0012-phase-4-closures.md)
- [ADR-0013 — One test Postgres on an ephemeral port, with a database per run](adr/0013-one-test-postgres-ephemeral-port-database-per-run.md)
- [ADR-0014 — Transactional domain writes own their audit rows](adr/0014-transactional-domain-audits.md)

## Deployment

- [Deploy record](deploy.md) — the Supabase and Vercel projects, where §8's
  variables and the `phi` bucket are set, and the run record for every
  deploy.
- [Credential-free DEL-4 runtime](local-del4-runtime.md)

## Agent operating docs (`docs/agents/`)

- [Domain Docs](agents/domain.md)
- [Issue tracker: Linear](agents/issue-tracker.md)
- [Triage Labels](agents/triage-labels.md)

## Operational notes

- **Session timeout.** The inactivity timeout ADR-0012 #6 states is a
  Supabase Auth project setting (Supabase dashboard → Authentication →
  Sessions), not an application variable — `lib/config.ts` carries no such
  key, and `/login` and `/register` only state the number, never read it.
