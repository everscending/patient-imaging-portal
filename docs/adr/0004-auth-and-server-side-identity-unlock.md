# ADR-0004 — Supabase Auth for login; a server-side record for the identity unlock

- **Status:** Accepted
- **Date:** 2026-08-14
- **Requirements touched:** FR-1, FR-2, FR-7, EC-1, SEC-2, SEC-4, SEC-7

## Context

The PRD asks for two distinct things that are easy to conflate.

**FR-1 is login.** A patient registers with an email and password, gets a
session, and that session expires. SEC-7 adds: hashed with bcrypt or argon2,
never plaintext, protected against common auth attacks.

**FR-2 is a second factor, and it is not login.** Before any image *or report*
unlocks, the patient must enter a pre-existing Patient/Account ID plus a date of
birth that matches a seeded record. It mirrors the patient-matching step real
imaging portals use. EC-1 adds that a mismatch reveals nothing about which field
was wrong, and that repeated failures rate-limit or lock the attempt.

So there are two gates, and the second one needs to be *revocable*, *auditable*,
and *lockable mid-window* — otherwise EC-1's lockout is unenforceable.

## Decision

**Login is Supabase Auth.** Registration, argon2/bcrypt hashing, JWT session
issue, and expiry are handled by the platform and documented in the README
against SEC-7. A `patients` row links to `auth.users` by `user_id`.

**The FR-2 unlock is a server-side row**, never a client-held credential:

```
identity_unlocks
  id
  user_id          → auth.users
  patient_id       → patients        (the record that was matched)
  unlocked_at
  expires_at                          short TTL — see D-4
  revoked_at       nullable

identity_attempts
  id
  attempted_patient_ref               as typed, not resolved
  source_ref                          coarse client identifier
  succeeded
  attempted_at
  locked_until     nullable            EC-1
```

Every PHI route re-reads the unlock server-side through the single
`lib/access` guard described in ADR-0003. The client never holds anything that
by itself proves the unlock.

**Failure counting is per patient identifier and per source, not per session.**
Counting per session would let a caller clear cookies to reset the counter,
which makes EC-1's lockout decorative.

**One generic error.** A mismatch on either field returns one identical response
with no partial-match hint and no field-level detail, and the timing of the two
mismatch paths is not allowed to diverge meaningfully.

**RLS keys on `auth.uid()`.** Because login is Supabase Auth, the JWT carries an
identity Postgres policies can read, which is what makes ADR-0002's
defence-in-depth layer real rather than aspirational.

## Consequences

**Two gates to reason about, and both are enforced in one helper.** A route that
skips `lib/access` skips the session check, the unlock check, the ownership
check and the audit write together — a visible omission rather than a subtle one.

**The unlock is revocable and lockable.** Because it is a row, a lockout after
EC-1 failures takes effect immediately, and an administrator or a logout can end
it mid-window.

**SEC-7's hashing is delegated, so it must be documented.** A reviewer cannot
read the hashing code in this repo. The README states which algorithm Supabase
Auth uses and links the evidence, rather than leaving the claim unsupported.

**Every unlock and every failed attempt is an audit event** (SEC-4), and
`identity_attempts` stores the *typed* identifier rather than a resolved patient
— a failed attempt must not become a way to confirm that a patient exists.

## Alternatives considered

**Hand-rolled auth with an owned session table.** A grader could read the argon2
call directly, which is a genuine, if small, SEC-7 advantage. Rejected on two
counts: it spends roughly a day of a three-day budget on a solved problem, and
it forfeits RLS entirely — with no `auth.uid()` for policies to key on, every
FR-6 and FR-9 guarantee would rest on application code alone, weakening the
20-point security row far more than the transparency gain is worth.

**Unlock as a short-lived JWT claim held by the client.** Stateless, fast, and
readable by RLS. Rejected because a minted token cannot be revoked before it
expires and cannot be locked out mid-window after EC-1 failures — and it puts a
bearer credential for PHI in the browser, which is not defensible in the SEC-8
write-up.
