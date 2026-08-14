# ADR-0007 — Reports are structured rows in Postgres, rendered by a React component

- **Status:** Accepted
- **Date:** 2026-08-14
- **Requirements touched:** FR-7, FR-8, FR-9, SEC-2, SEC-4, CQ-4, CQ-5, CQ-7, DEL-4

## Context

Priority 2 — report viewing and secure sharing — is 15 rubric points. FR-7 needs
three things at once: only **signed** reports reach a patient, a Preliminary
report is *never* shown, and the report "renders in-browser with correct
formatting". CQ-4 and CQ-5 add that it must be usable at phone width and
keyboard-accessible with sufficient contrast.

The storage shape decides the seed, the viewer, the share-link resolution, and
whether accessibility is free or expensive.

## Decision

**Report content lives as structured columns in Postgres. A React component
renders it. No report binary is stored.**

```
reports
  id
  study_id        → studies
  patient_id      → patients          denormalised for RLS and for the
                                      FR-9 ownership check
  status          'preliminary' | 'signed'
  findings        text
  impression      text
  signed_by       → providers          null unless signed
  signed_at       timestamptz          null unless signed
  created_at
```

- The patient-facing query filters `status = 'signed'`, and an RLS policy
  enforces the same predicate at the database — so a forgotten `WHERE` clause in
  application code cannot leak a Preliminary report.
- The viewer is one `<ReportView>` component rendering semantic HTML, with print
  styles for a paper copy.
- A share link (FR-8) resolves to the **same component** behind a token-gated
  route, so there is one rendering path and one place where formatting can be
  wrong.
- Reading a report writes one audit event, through the same `lib/access` guard
  every PHI route uses (ADR-0003).

## Consequences

**The FR-7 signed-only rule becomes a predicate, not a convention.** It is
expressible in SQL and in an RLS policy, and testable directly. The alternatives
could only enforce it in application code.

**CQ-5 and CQ-4 come nearly free.** Semantic headings, real text, and normal
document flow are keyboard-navigable, screen-reader-legible, contrast-styleable
and responsive without extra work.

**CQ-7's attack surface does not grow.** There is no HTML blob and no
`dangerouslySetInnerHTML`, so reports introduce no XSS path.

**The seed writes rows, not binaries** (DEL-4). Report content costs no blob
storage at all, which matters because GAP-2's 1 GB ceiling is already tight for
imaging frames (ADR-0009).

**"Correct formatting" is now the component's job.** A structured report is only
as convincing as its layout. `<ReportView>` must look like a real diagnostic
report — a header block with patient reference, study reference, provider and
signing timestamp, then Findings and Impression sections — not a bare list of
fields. This is an acceptance criterion for FR-7, not styling polish.

**No PDF download.** Nothing in FR-7 or FR-8 requires one; the print stylesheet
covers the paper case. If a download is ever wanted, it is generated from the
structured rows, not stored.

## Alternatives considered

**Pre-rendered PDF in Supabase Storage.** The most realistic artifact, and it
reuses the signed-URL path already built for images. Rejected on CQ-4 and CQ-5: a
PDF in an iframe at phone width is exactly the experience the PRD's edge cases
penalise, and it is the worst option for keyboard navigation and contrast. It
also needs a PDF generator in the seed and consumes the scarce storage budget.

**Sanitized HTML blob in Postgres.** Rich formatting with no PDF pipeline.
Rejected because every render becomes a `dangerouslySetInnerHTML`, so CQ-7 must
now defend an XSS path that the structured option simply does not have — and the
signed-only rule stays a convention rather than a column predicate.
