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

## Confirming run — JOR-235

This is an appended confirming run of the whole benchmark, not a replacement
for the record above. Everything above this heading is JOR-221's and JOR-302's
fixed evidence and stays byte-untouched — T67's comparison reads that block,
never this one. What follows is a second execution of the same six PF rows
under the same stated load, recorded so all six exist as one dated run rather
than as six separately dated fragments.

### Conditions

| Condition | Value |
| --- | --- |
| Run date | 2026-08-22T02:30:19Z (PF-1/2/3 run 1), 2026-08-22T02:32:17Z (PF-1/2/3 run 2), 2026-08-22T02:34:17Z (PF-5), 2026-08-22T02:36:05Z (PF-4/PF-6), 2026-08-22T02:38:03Z (playback) |
| Run commit | 75a8d7f351330f211c1259bfe3d9304b10db20bc |
| Deployed commit | 40c3b4c75eed61ecf09dee6f48d35dca69c78e5c |
| Run host | https://patient-imaging-portal.vercel.app (Vercel pdx1 → Supabase us-west-2) for PF-1, PF-2, PF-3, PF-5; a local production build (`npm run build && npm run start`, `PORT=4610`) on the same live Supabase us-west-2 project for PF-4 and PF-6 |
| Run dataset | ADR-0009 deployed seed: 50 patients, 10 providers, 150 studies, 250 cine clips, 700 images, and approximately 16,000 slots |
| Run VU ramp | 10 s to 20 VUs, 40 s to 50 VUs, 10 s down to 0 |
| Run duration | 60 s per k6 script |
| Run count | One run per script. `k6/imaging.js` was run a second time because PF-3 crossed its threshold on the first run — a stability check, not a retry for a better number, and both runs are recorded. PF-4 and PF-6 take one bounded write pair per admitted VU (50 server-timing samples each); PF-5 repeats for the full run (1,371 samples). |
| Run identifier | `k6/booking.js` ran under `RUN_ID=365d2971` |

`75a8d7f` is the commit this run's k6 scripts, local production build and
playback check were taken from. The deployed host still serves `40c3b4c`, the
last deployment this repository records (docs/el1-benchmark.md). Every commit
between the two touches only `.loom.yml`, `scripts/gate.sh`, `k6/imaging.js`,
tests and documentation — no `app/`, `lib/` or `components/` path — so the
application code behind PF-1, PF-2, PF-3 and PF-5 is the same code either SHA
names. The one file that does differ, `k6/imaging.js`, is the load script this
run executed locally at `75a8d7f`; the deployed host never runs it.

### Results

| Requirement | Target | This run (p95) | Verdict | Measurement source |
| --- | --- | --- | --- | --- |
| PF-1 single image | p95 < 1.0 s | 913.09 ms (run 1), 870.55 ms (run 2) | met | `pf1_single_image_ms`, `k6/imaging.js` |
| PF-2 cine first frame | p95 < 1.0 s | 710.20 ms (run 1), 649.25 ms (run 2) | met | `pf2_cine_first_frame_ms`, `k6/imaging.js` |
| PF-3 cine fully loaded | p95 < 5.0 s | 5030 ms (run 1), 4740.15 ms (run 2) | unstable | `pf3_cine_fully_loaded_ms`, `k6/imaging.js` |
| PF-4 share creation | p95 < 1.0 s | 708.88 ms; samples 50 | met | `share.create` server timing lines, `k6/booking.js` |
| PF-5 open-slot query | p95 < 1.0 s | 351.38 ms; samples 1,371 | met | `pf5_slot_query_ms`, `k6/slots.js` |
| PF-6 booking action | p95 < 1.0 s | 576.90 ms; samples 50 | met | `booking.create` server timing lines, `k6/booking.js` |

A verdict of `met` means every recorded run of that row was under target,
`missed` means every one was over, and `unstable` means the runs fall on both
sides of the line — the same rule docs/el1-benchmark.md applies.

Checks and HTTP failures across the four k6 runs: imaging 350 of 350 checks
with 0 of 5,755 requests failed, on each of its two runs; slots 1,371 of 1,371
checks with 0 of 1,374 failed; booking 100 of 100 checks with 0 of 106 failed.

PF-4 and PF-6 are read only from the PHI-free `{ op, ms, outcome, requestId }`
lines the application process emitted while `k6/booking.js` drove its stated
load — 50 `share.create` lines and 50 `booking.create` lines, every one
`outcome: "ok"` and every one carrying a distinct `requestId`. Neither row is
computed from k6 request duration.

### Disposition: PF-3 accepted as final (JOR-235)

PF-3 measures 4.7–5.1 s p95 at the target boundary across four runs (JOR-249:
5105/4657 ms; JOR-235: 5030/4740 ms) under identical conditions;
human-accepted as the final result 2026-08-22, and the sync-audit review
reaffirmed that decision without reopening it. The patient-visible wait is
the poster (~650 ms) and the bounded read-ahead window (~1.2–1.5 s);
whole-clip completion sits at the target line. No threshold was changed.

Why this exceedance is acceptable rather than fixed:

- **The measured quantity is not the experienced quantity.** PF-3 times the
  100th frame's byte completion, but the viewer is playable long before that:
  playback starts from the poster and the read-ahead window, both measured
  well under their sibling targets (PF-2 first frame 649–710 ms p95). A
  patient pressing play at the default 12 FPS consumes 100 frames over ~8.3
  seconds, so a whole-clip completion of ~5 s never stalls playback — frames
  arrive ahead of the playhead throughout.
- **The spread straddles the line symmetrically.** Two of four runs are under
  target and two are over, with the band (±4%) inside run-to-run variance on
  shared free-tier infrastructure. Buying certainty below 5.0 s would mean
  optimizing for the benchmark harness (or paying for dedicated capacity,
  which CUT-3 forbids) rather than for any patient-visible outcome.
- **The client-side playback check passes.** The smooth-playback half of the
  PF-3 row — no visible dropped frames at the default rate — holds in the
  committed Playwright evidence (`e2e/playback-frames.spec.ts`), which is the
  half a patient can perceive.

The verdict column above deliberately keeps `unstable`: the number is
reported as measured, and this section records the human decision about it —
never a quietly widened threshold.

This acceptance is a new one and it is terminal. It replaces the deferral
JOR-249 recorded, which had held PF-3 open for this run. Nothing defers PF-3
onward from here.

The run that passed is not presented as the result: both runs are recorded
above. Run 1's p95 is recorded at k6's default second precision (5.03 s)
because the millisecond-precision summary export was only added for the
confirm run; the crossing itself is not in doubt, as k6 failed its own
`p(95)<5000` threshold on run 1 and passed it on run 2.

PF-1, the other row JOR-302 tagged as an accepted exceedance at 1130.00 ms,
is under target on both runs here — 913.09 ms and 870.55 ms — confirming what
JOR-249 measured. PF-2, PF-4, PF-5 and PF-6 met their targets as before.

### Client playback

`e2e/playback-frames.spec.ts` re-run against the same local production build
with its existing-server switch (`PLAYBACK_LIVE=1`), 2026-08-22T02:38:03Z:
passed. All 100 frames rendered in index order at the manifest's own
`defaultFps` with no dropped frames, and peak preload concurrency was 9 — the
viewer's stated `CINE_FRAME_WINDOW` of 8 plus the on-screen frame's own
`<img>` element, never the whole clip at once.

### PF-4/PF-6 write residue for this run

`k6/booking.js` ran under a fresh `RUN_ID=365d2971`. Reusing `2040a3e2` would
have reused its bookings and skipped every share, leaving PF-4 with no samples
at all, so a fresh identifier was required and it adds exactly one more
bounded residue batch to the live seeded dataset: 50 appointments and 50
shares, with recipient emails matching `performance-365d2971-*@example.test`.
That is the same bound the block above records for `2040a3e2`, and a repeat
run under `365d2971` reuses those bookings and skips duplicate shares rather
than growing the batch.
