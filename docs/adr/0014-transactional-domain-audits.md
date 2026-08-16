# ADR-0014 — Transactional domain writes own their audit rows

- **Status:** Accepted
- **Date:** 2026-08-16
- **Requirements touched:** EC-8, SEC-4

When a requirement says a domain mutation and its audit rows must commit or
roll back together, the same narrow `SECURITY DEFINER` database function writes
both. `lib/audit/events.ts` remains the only application-level writer; a
transactional function is the sole exception because PostgREST cannot span its
RPC and a later TypeScript audit call with one transaction. JOR-198's
`apply_provider_availability` is the first use: it writes exactly one
`availability.update` row and one `availability.collision` row per preserved
appointment in the transaction that replaces availability and recomputes
`out_of_hours`.

The alternative—calling `recordAuditEvent` after the RPC—was rejected because
that writer deliberately swallows persistence failures. The endpoint could
return success after the availability edit committed while its required audit
rows were absent, contradicting EC-8 and SEC-4.
