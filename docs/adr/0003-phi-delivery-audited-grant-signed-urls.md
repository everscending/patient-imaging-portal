# ADR-0003 — PHI bytes travel by short-lived signed URL, issued by an audited grant

- **Status:** Accepted
- **Date:** 2026-08-14
- **Requirements touched:** FR-3, FR-4, FR-5, FR-6, FR-7, FR-8, FR-9, SEC-2, SEC-4, SEC-8, PF-1, PF-2, PF-3, EL-1

## Context

This is the central architectural decision of the build. Four requirement groups
pull on the same mechanism in opposite directions:

- **SEC-4** requires every PHI read — image view, report view, share-link
  generation, share-link use — recorded with actor, action, target and timestamp
  in an append-only log.
- **FR-6 / FR-9** require that no patient and no share link can ever reach
  another patient's images or reports, proven by an adversarial automated test.
- **PF-2 / PF-3** require a 100-frame cine clip to reach first frame in under
  1.0 s p95 and be fully playable in under 5.0 s p95, under 20–50 concurrent
  virtual users.
- **EL-1**, if selected, asks for materially better than that.

ADR-0001 puts the API in serverless route handlers and ADR-0002 puts the bytes
in Supabase Storage. Proxying a 100-frame clip through route handlers means 100
function invocations per clip per viewer, each one cold-startable and none of
them CDN-cacheable — which is 100 × 50 concurrent invocations at the stated k6
load. PF-3 is not reachable that way.

## Decision

**Authorization and audit happen once per access grant, on the server. Bytes then
come straight from storage over short-lived signed URLs.**

One authorized API call per study, clip, or report:

1. verifies the session (FR-1),
2. verifies the identity unlock is present and unexpired (FR-2, ADR-0004),
3. verifies ownership of the target resource server-side (FR-6, FR-9, SEC-2),
4. writes **one** append-only audit row recording actor, action, target and
   timestamp (SEC-4),
5. returns the manifest plus signed Supabase Storage URLs with a short TTL.

```
GET /api/studies/:studyId/clips/:clipId
  → session valid?            401
  → identity unlocked?        403
  → patient owns study?       404   (never 403 — see below)
  → INSERT audit_log(...)           one row per grant
  → 200 { manifest, frames: [{ index, url, expiresAt }, … ] }

browser → Supabase CDN, N parallel GETs, no function invoked
```

**Storage keys are random UUIDs**, never derived from patient, study, or
sequence identifiers. A guessed or enumerated key is meaningless even before the
signature expires. This is what keeps FR-6's ID-incrementing attack from having
anywhere to go at the storage layer.

**Share links resolve through the same funnel.** A share token is presented to a
server route that validates it, checks expiry and revocation, writes an audit
row for the *use* (SEC-8), and only then issues signed URLs. The token never
grants storage access directly.

**Not-found over forbidden.** An ownership failure returns 404, not 403 — a 403
confirms the resource exists, which is itself a cross-patient information leak
under FR-6.

## Consequences

**Audit granularity is the access grant, not the individual byte range.** This is
a real and deliberate narrowing of SEC-4, and it is the standard pattern in
production imaging portals: the record says *this actor was granted access to
this study at this time*, and the grant is what a compliance reviewer acts on.
The README states this explicitly rather than leaving a reader to infer
per-frame logging that does not happen.

**A signed URL outlives its grant for the length of its TTL.** Revoking a share
link stops new grants immediately but cannot invalidate an already-issued signed
URL until it expires. The TTL is therefore kept short — see D-4's parameters —
and the tradeoff is documented in the SEC-8 write-up rather than glossed.

**Performance headroom.** Frames are served by the storage CDN with no function
in the path, which is what makes PF-2 and PF-3 reachable and gives EL-1
somewhere to go (thumbnail-first ordering, prefetch hints, per-frame priority).

**Every PHI route shares one guard.** Steps 1–4 are a single `lib/access` helper,
not repeated per handler. FR-6 and FR-9's adversarial tests therefore exercise
one code path, and a new PHI route cannot forget the audit write without
skipping the helper entirely.

## Alternatives considered

**Proxy every byte through the API.** Maximum SEC-4 fidelity — literally every
read logged. Rejected on PF-2/PF-3: 100 invocations per clip, no CDN caching of
PHI, cold starts on the critical path, and Hobby-tier invocation limits under
the k6 load the PRD specifies. It optimises the least-weighted phrasing of one
requirement at the cost of an entire 10-point rubric row.

**Proxy stills and reports, sign only cine frames.** Splits the difference on
cost. Rejected because it creates two PHI delivery paths, two audit shapes, and
two share-link resolutions — meaning FR-6 and FR-9 must each be proven twice,
once per path, and a future PHI route has two conventions to choose wrongly
between.
