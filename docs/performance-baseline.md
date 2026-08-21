# Performance baseline

This is the reference baseline T67 reads against. PF-1 through PF-3 and PF-5
were measured against the deployed production stack; PF-4 and PF-6 were
measured against a local production build pointed at the same live database,
because Vercel's own function logs are impractical to harvest for the
`{ op, ms, outcome, requestId }` server-timing lines those two rows require.
Both host conditions are named per row below.

## Conditions

| Condition | Value |
| --- | --- |
| Commit | 54a062f77bf053df1545363412b49c4f2113454d |
| Date | 2026-08-21T22:20:32Z |
| Dataset | ADR-0009 deployed seed: 50 patients, 10 providers, 150 studies, 250 cine clips, 700 images, and approximately 16,000 slots |
| Host | https://patient-imaging-portal.vercel.app (Vercel pdx1 → Supabase us-west-2) for PF-1, PF-2, PF-3, PF-5; a local production build (`npm run build && npm run start`, `PORT=4560`) on the same live Supabase us-west-2 project for PF-4 and PF-6 |
| VU ramp | 10 s to 20 VUs, 40 s to 50 VUs, 10 s down to 0 |
| Duration | 60 s per k6 script |
| Run count | One run per script. PF-1/PF-2/PF-3 (`k6/imaging.js`) and PF-4/PF-6 (`k6/booking.js`) take one bounded pass per admitted VU (50 samples each); PF-5 (`k6/slots.js`) repeats for the full run (1,378 samples) |

The Commit and Date above are the deployed-stack evidence from JOR-302
(PF-1, PF-2, PF-3, PF-5). PF-4 and PF-6 were captured 2026-08-21T22:38Z against
this branch's merge commit `a255e3afb8d9ca2a3c17f9ca06c9c0e17d6d51ef`, using the
same live Supabase seed as the deployed stack — the server-timing values are
production-code timings regardless of which host process emitted them, so the
local-host capture is a valid PF-4/PF-6 measurement.

## Results

| Requirement | Target | Measurement source | Result |
| --- | --- | --- | --- |
| PF-1 single image | p95 < 1.0 s | `pf1_single_image_ms`: study manifest plus signed Storage image bytes | 1130.00 ms p95; accepted exceedance |
| PF-2 cine first frame | p95 < 1.0 s | `pf2_cine_first_frame_ms`: 100-frame manifest plus first signed Storage frame bytes | 707.00 ms p95 |
| PF-3 cine fully loaded | p95 < 5.0 s | `pf3_cine_fully_loaded_ms`: manifest plus all 100 signed Storage frames; paired with the client playback check | 5060.00 ms p95; accepted exceedance |
| PF-4 share creation | p95 < 1.0 s | `share.create` server timing lines; required samples: 20 or more | 745.60 ms p95; samples: 50 |
| PF-5 open-slot query | p95 < 1.0 s | `pf5_slot_query_ms` from `GET /api/slots` | 346.25 ms p95 |
| PF-6 booking action | p95 < 1.0 s | `booking.create` server timing lines; required samples: 20 or more | 559.31 ms p95; samples: 50 |

Medians: PF-1 731 ms, PF-3 4.25 s (deployed-stack full-load run, JOR-302).
Checks 199/199, HTTP failures 0/5,155 on that run. A one-VU probe against the
same deployed commit recorded 916 ms / 637 ms / 6.33 s for PF-1/PF-2/PF-3,
showing the ramp-load numbers above are load-driven, not a broken endpoint.

PF-4 and PF-6 are never computed from k6 request duration. Their p95 values
come only from the PHI-free `{ op, ms, outcome, requestId }` lines emitted by
the application process — 50 `booking.create` lines and 50 `share.create`
lines, all `outcome: "ok"`, captured from `k6/booking.js`'s stated load
(`RUN_ID=2040a3e2`) against the local production server described above.

## Disposition: PF-1 and PF-3 pre-elective exceedance (JOR-302)

JOR-302 closed as the human-accepted record of the deployed production stack's
imaging performance. Its measured numbers are fixed evidence, not a target the
scripts should re-chase — re-running the imaging workload against the live
shared stack again would cost real Supabase and Vercel usage without changing
what already happened. PF-1 (1.13 s) and PF-3 (5.06 s) both exceed their
targets under the stated 20→50 VU ramp; the human accepted recording these
as-is, as the honest pre-elective baseline this file exists to establish.

EL-1 (T66, tracked as JOR-243) is the designed closer for these two misses —
the work expected to bring PF-1 and PF-3 under target. T67 re-measures PF-1 and
PF-3 after EL-1 lands, against this same baseline.

## Shared-pool and 100-frame conditions

ADR-0009 intentionally shares a small pool asset set across many records, so
the CDN cache is warmer than a production corpus would be. `k6/imaging.js`
rotates the demo patient's visible studies and images by virtual-user number
where it can, but targets repeat after that account's distinct records are
exhausted. The measured baseline is therefore a warm pool asset result, not a
cold-cache claim.

The benchmark selects the healthy performance clip only after its manifest
reports 100 available signed frame URLs. The separate EC-2 clip keeps its
intentional missing object and is not used for PF-3. The playback check
(`e2e/playback-frames.spec.ts`, run 2026-08-21T22:39Z against the same local
production server as PF-4/PF-6) proved the client traverses all 100 healthy
manifest indices in order at the manifest's own `defaultFps`, with the
100-frame preload completing at concurrency 100 before playback started.

## PF-4/PF-6 write residue

`k6/booking.js` has no cancel/revoke step, so its 60-second stated-load run
against the local production server left durable rows in the live seeded
Supabase dataset: 50 appointments and 50 shares, created under
`RUN_ID=2040a3e2`, all with recipient emails matching
`performance-2040a3e2-*@example.test`. A repeat run with the same `RUN_ID`
reuses the existing bookings and skips duplicate shares (see `k6/README.md`),
so this residue does not grow on rerun with an unchanged `RUN_ID`.
