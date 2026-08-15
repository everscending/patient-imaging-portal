# ADR-0011 — Identity verification is a one-time account link, with no expiring unlock

- **Status:** Accepted
- **Date:** 2026-08-14
- **Supersedes:** the expiring-unlock half of ADR-0004, and ADR-0008's
  identity-unlock lifetime parameter
- **Requirements touched:** FR-2, FR-3, FR-7, EC-1, SEC-2, SEC-4

## Context

ADR-0004 made FR-2's verification produce a **server-side unlock row with a
45-minute expiry**, re-read by the access guard on every PHI request. ADR-0008
then fixed the lifetime at 45 minutes and marked it, correctly, as *our design
decision, not a PRD requirement*.

The PRD's actual sentence is:

> before any images **or reports** unlock, the patient enters a pre-existing
> Patient/Account ID plus date of birth that must match a seeded record.

That is a gate in front of the **first** unlock. The PRD never asks the unlock
to expire, never asks a returning patient to re-enter anything, and states no
lifetime. FR-2's acceptance criterion — *"a correct ID+DOB match unlocks that
patient's own studies and reports only"* — is satisfied by a match that unlocks
them once.

So the build was carrying a recurring gate the brief does not ask for, at the
cost of a parameter, a table, a policy pair, a shell indicator, a redirect path,
and a branch in the one function every PHI route calls.

## Decision

**A successful identity verification links the account to the patient record,
permanently. There is no unlock, and nothing expires.**

- `patients.user_id` is the whole of verification's persistent effect. It is
  written once, in the transaction that records the successful attempt, and
  only when the column is currently null (unchanged from `ARCHITECTURE.md` §4).
- The **`identity_unlocks` table is removed**, with its policies, its indexes
  and its `IDENTITY_UNLOCK_TTL_MINUTES` setting.
- The access guard checks that the caller's account **is linked to a patient
  record**, not that a live unlock exists. An unlinked patient account gets
  `403 identity_verification_required`; the UI sends it to `/verify`.
- `/verify` is reached when the account is not yet linked. Once linked, a
  patient signs in and reaches their images directly.
- **Everything EC-1 asks for is unchanged**: one generic error for a wrong
  reference, a wrong date of birth, or an active lockout; three failed attempts
  inside five minutes locks further attempts, counted per patient reference and
  per source; every attempt and every link is audited.

## Consequences

**One fewer stated parameter, and one fewer moving part on every PHI request.**
The guard drops a table read and a branch; the shell drops the countdown; the
middleware drops the re-verification redirect for linked accounts.

**The check is demonstrable exactly once per account.** The seed deliberately
leaves at least one patient unlinked with no account (ADR-0009), so the DEL-6
demo registers, verifies and links on camera. A grader signing in as the linked
demo patient will *not* be asked — which is the intended behaviour, and the
README says so rather than letting it read as a missing requirement.

**ADR-0004's "revocable and lockable mid-window" property is gone.** That
property protected an unlock that no longer exists. Ending a patient's access
now means disabling or unlinking the account, which is an administrative action
rather than a timer. Stated in the README's known-residues section.

**The lockout still bites where it matters.** Linking is the only moment
verification runs, and it is exactly the moment an attacker would attack, so
EC-1's three-attempts rule guards the same door it always did.

## Alternatives considered

**Keep the 45-minute unlock (ADR-0004 as written).** Closest to a production
imaging portal, and the strongest reading of "second-factor patient matching".
Rejected: the PRD does not ask for it, and it is the most expensive
not-asked-for feature in the build.

**Re-verify once per sign-in session, with no timer.** Keeps the screen in every
demo run and costs little, since `/verify` exists for linking anyway. Rejected
on the same ground — the PRD asks for a gate before the first unlock, not a gate
per session — and noted here because it is the natural middle option if the
one-time link ever reads as too thin.
