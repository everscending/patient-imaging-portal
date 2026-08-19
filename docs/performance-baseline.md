# Performance baseline

Measurement is pending the JOR-296 hosted PostgREST JWT-claim repair. The
scripts and playback check are committed first; this file will record the
measured source commit and observed values after that prerequisite is deployed.
No placeholder below is a benchmark result.

## Conditions

| Condition | Value |
| --- | --- |
| Commit | Pending measured source commit |
| Date | Pending (UTC) |
| Dataset | ADR-0009 deployed seed: 50 patients, 10 providers, 150 studies, 250 cine clips, 700 images, and approximately 16,000 slots |
| Host | Pending; local application process using the deployed Supabase seed |
| VU ramp | 10 s to 20 VUs, 40 s to 50 VUs, 10 s down to 0 |
| Duration | 60 s per k6 script |
| Run count | Pending; imaging and booking use one bounded pass per admitted VU, slots repeats for the full run |

## Results

| Requirement | Target | Measurement source | Result |
| --- | --- | --- | --- |
| PF-1 single image | p95 < 1.0 s | `pf1_single_image_ms`: study manifest plus signed Storage image bytes | Pending |
| PF-2 cine first frame | p95 < 1.0 s | `pf2_cine_first_frame_ms`: 100-frame manifest plus first signed Storage frame bytes | Pending |
| PF-3 cine fully loaded | p95 < 5.0 s | `pf3_cine_fully_loaded_ms`: manifest plus all 100 signed Storage frames; paired with the client playback check | Pending |
| PF-4 share creation | p95 < 1.0 s | `share.create` server timing lines; required samples: 20 or more | Pending |
| PF-5 open-slot query | p95 < 1.0 s | `pf5_slot_query_ms` from `GET /api/slots` | Pending |
| PF-6 booking action | p95 < 1.0 s | `booking.create` server timing lines; required samples: 20 or more | Pending |

PF-4 and PF-6 are never computed from k6 request duration. Their p95 values
come only from the PHI-free `{ op, ms, outcome, requestId }` lines emitted by
the local application process, and the final baseline will state the measured
sample count for each operation.

## Shared-pool and 100-frame conditions

ADR-0009 intentionally shares a small pool asset set across many records, so
the CDN cache is warmer than a production corpus would be. `k6/imaging.js`
rotates the demo patient's visible studies and images by virtual-user number
where it can, but targets repeat after that account's distinct records are
exhausted. The measured baseline will therefore be a warm pool asset result,
not a cold-cache claim.

The benchmark selects the healthy performance clip only after its manifest
reports 100 available signed frame URLs. The separate EC-2 clip keeps its
intentional missing object and is not used for PF-3. The playback check proves
that the client traverses all 100 healthy manifest indices in order at the
manifest's own `defaultFps`.
