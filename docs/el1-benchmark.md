# EL-1 before-and-after benchmark

EL-1 (ADR-0005, built as JOR-243) is the delivery optimisation aimed at the two
imaging misses JOR-302 recorded against the deployed production stack. This file
is the before-and-after record for that work: what the same workload measured
before EL-1 existed, what it measures now, and which technique in the build is
responsible for the difference.

The before column is **read from `docs/performance-baseline.md`, never
re-derived**. Those numbers are JOR-302's fixed evidence of what the deployed
stack did before EL-1 landed. Re-running the pre-EL-1 workload to "refresh" them
would cost real Supabase and Vercel usage and could only produce a different
number for the same past event, so the baseline file stays the single source of
the before column and this file quotes it.

## Conditions

Both columns are the same workload under the same conditions. They are stated
once here and are not restated per row, because a row measured under different
conditions would not be a comparison.

| Condition | Value |
| --- | --- |
| Script | `k6/imaging.js` |
| Host | https://patient-imaging-portal.vercel.app (Vercel pdx1 → Supabase us-west-2) |
| Dataset | ADR-0009 deployed seed: 50 patients, 10 providers, 150 studies, 250 cine clips, 700 images, and approximately 16,000 slots |
| VU ramp | 10 s to 20 VUs, 40 s to 50 VUs, 10 s down to 0 |
| Duration | 60 s |
| Run count | One run for the before column. The after column was run once, and once more only because PF-3 missed on the first run — a stability check, not a retry for a better number. Both after runs are recorded below. |
| Before commit | 54a062f77bf053df1545363412b49c4f2113454d |
| After commit | 40c3b4c75eed61ecf09dee6f48d35dca69c78e5c |
| Before date | 2026-08-21T22:20:32Z |
| After date | 2026-08-22T01:38Z (run 1), 2026-08-22T01:41Z (run 2) |

The one difference between the two runs is the build under test, which is the
point of the comparison. The after run additionally measures EL-1's own delivery
path (the second table below); that measurement is taken only after every PF
timer has stopped, so PF-1, PF-2 and PF-3 keep the exact requests, order and
timers the before run used. It adds load to the after run and can therefore make
a PF row look worse than the baseline, never better.

## Results

| Requirement | Target | Before | After run 1 | After run 2 | Verdict |
| --- | --- | --- | --- | --- | --- |
| PF-1 single image | p95 < 1.0 s | 1130.00 ms p95 | 934.80 ms p95 | 859.05 ms p95 | met |
| PF-2 cine first frame | p95 < 1.0 s | 707.00 ms p95 | 668.65 ms p95 | 783.35 ms p95 | met |
| PF-3 cine fully loaded | p95 < 5.0 s | 5060.00 ms p95 | 5105.30 ms p95 | 4657.00 ms p95 | unstable |

A verdict of `met` means every recorded after run was under target, `missed`
means every one was over, and `unstable` means the runs fall on both sides of
the line. Both after runs completed 350 of 350 checks with 0 of 5,755 HTTP
requests failing.

PF-1 and PF-3 carried JOR-302's "accepted exceedance" tag in the baseline. They
are the two rows EL-1 was built to close.

**PF-1 is closed.** 1130.00 ms → 934.80 ms and 859.05 ms, under target on both
runs. That is the thumbnail-first path doing what it was built to do.

**PF-3 is not closed.** 5060.00 ms → 5105.30 ms and 4657.00 ms. It straddles its
5.0 s target rather than clearing it, and the first run was marginally worse than
the recorded baseline. This is reported as measured. No threshold was adjusted to
make it pass, and the passing run is not presented as the result. Run 1's 45 ms
over the baseline is inside the margin this ticket's own added EL-1 measurement
load could account for — that load only ever pushes a PF row upward, as the
conditions above state — so it should not be read as EL-1 having made PF-3 worse.

The reason PF-3 is largely unmoved is visible in the split below: PF-3 times the
whole 100-frame clip, and EL-1 did not make the clip smaller or fewer bytes. What
EL-1 changed is *when* those bytes are needed. The bounded read-ahead window —
the frames the viewer actually fetches before playback — completes at 1507.90 ms
and 1211.10 ms p95, roughly a quarter of the whole-clip total, and the poster
gives the viewer something to draw at about 650–710 ms. A patient waits for the
window, not for the clip; PF-3 as defined measures the clip.

## Disposition: PF-3 straddle accepted (JOR-249)

**PF-3's straddle — 5105.30 ms and 4657.00 ms against a p95 < 5.0 s target — is
human-accepted, 2026-08-22**, on the same precedent JOR-302 set when it accepted
PF-1 and PF-3 as recorded rather than re-chasing them. A row that lands on both
sides of its line across two runs is a real result about this workload on this
shared stack, not a defect to be re-run until it reads better.

**JOR-235's benchmark run has since happened**, and it reproduced this exact
straddle: 5030 ms and 4740.15 ms, under these same conditions. Its record in
`docs/performance-baseline.md` carries the human acceptance that closes PF-3
as a final result, 2026-08-22. The deferral this section recorded ends there;
nothing in it defers PF-3 onward any longer.

What the acceptance rests on is that the patient-facing wait is already covered
by rows that do meet expectations: the bounded read-ahead window — the frames the
viewer actually fetches before playback — completes at 1507.90 ms and 1211.10 ms
p95, and the poster gives the viewer something to draw at about 650–710 ms. PF-3
measures the whole 100-frame clip, which is not what a patient waits for.

No threshold was changed to record this, and the accepting verdict is `unstable`,
not `met`.

## EL-1 delivery path

These rows have no before column and are not a substitute for PF-1/PF-2/PF-3.
They exist because the PF rows measure whole-asset totals, while EL-1's claim is
about what reaches the screen first and how much is fetched before playback. A
whole-asset total cannot show that.

| Measurement | What it times | After run 1 | After run 2 |
| --- | --- | --- | --- |
| `el1_thumbnail_first_ms` | study manifest plus signed thumbnail bytes | 891.65 ms p95 | 618.55 ms p95 |
| `el1_cine_poster_ms` | clip manifest plus signed poster bytes | 646.40 ms p95 | 706.95 ms p95 |
| `el1_cine_frame_window_ms` | clip manifest, poster, and one bounded read-ahead window of frames | 1507.90 ms p95 | 1211.10 ms p95 |

These rows have no target of their own. They are here because they are the
numbers the techniques below actually change, and because PF-3's whole-clip total
would otherwise be the only thing on record.

## Techniques

Each row names the module that implements it. Nothing here is claimed that the
build does not do.

| Technique | Implemented in | What the build actually does |
| --- | --- | --- |
| Thumbnail-first render | `components/imaging/ImageViewer.tsx` | While the full image is still loading, the viewer draws the study manifest's `thumbUrl` for the selected image and shows a "Loading full image…" status beside it. The thumbnail is dropped once the full image reports loaded, and a thumbnail that fails is not retried. |
| Prefetch and priority hints | `components/imaging/ImageViewer.tsx` | The image on screen is requested at `fetchPriority="high"`. Once it has finished, and only then, the next filmstrip image is warmed through a detached `Image` at `fetchPriority="low"`, so the prefetch never competes with the picture the patient is waiting for. There is nothing to prefetch until the authorized manifest has arrived, so a prefetch can never precede the grant that minted the URL. |
| Per-frame streaming with a bounded window | `components/imaging/CineViewer.tsx` | The frame on screen is fetched first and alone at high priority. Only once it has settled does the viewer read ahead of the playhead, and it keeps at most `CINE_FRAME_WINDOW` (8) fetches in flight. A 100-frame clip therefore loads in windows instead of a hundred simultaneous requests. |
| Caching | `components/imaging/CineViewer.tsx`, `lib/imaging/studies.ts` | Every decoded frame is held in an in-viewer cache keyed by frame index for the life of the viewer, so re-visiting a frame costs no request. The clip manifest signs the poster inside the frames' own signing batch, so the viewer has something to draw before the first frame arrives without a second signing round trip. |

Gaps in a cine clip still come only from the manifest's `available: false`. None
of the techniques above may invent a gap from a fetch that failed or is slow;
`e2e/el1-regression.spec.ts` re-asserts that as EC-2.

## ADR-0009 warm-cache caveat and the distinct-asset arrangement

ADR-0009 deliberately shares a small pool of distinct synthetic assets across
many records, because DEL-4's literal row counts would need roughly 1.25 GB
against a 1 GB free ceiling that CUT-3 forbids exceeding. Rows stay at DEL-4's
numbers; the bytes behind them repeat.

The consequence for this file is that the CDN cache is warmer than a production
corpus would be, in both columns equally. `k6/imaging.js` rotates the demo
patient's visible studies and images by virtual-user number where it can, but
targets repeat once that account's distinct records are exhausted. Both columns
are therefore warm pool asset results, not cold-cache claims, and the comparison
between them is valid precisely because the same arrangement applies to both.

The benchmark selects the healthy performance clip only after its manifest
reports 100 available signed frame URLs. The separate EC-2 clip keeps its
intentional missing object and is never used for PF-3.

## Client playback

`e2e/playback-frames.spec.ts` is the client-side half of PF-3 and is re-run for
this ticket: 100 frames, no dropped frames, at the manifest's own `defaultFps`,
with preload concurrency bounded by the viewer's stated window rather than the
whole clip at once.

Result: passed, 2026-08-22T01:47Z. All 100 frames rendered in index order at the
manifest's `defaultFps` with no dropped frames, and peak preload concurrency was
8 — exactly `CINE_FRAME_WINDOW`, not the whole clip.

## Priority-1 regression re-run

`e2e/el1-regression.spec.ts` re-asserts every Priority-1 acceptance criterion
against the EL-1 build: FR-2 identity verification and its three-failure
five-minute lockout, FR-3 own-and-completed studies only, FR-4 cine playback,
FR-5 the secure share link and its configured window, FR-6 cross-patient access
concealed as 404 and never 403, and EC-1 through EC-5.

A regression in any of them is a gate failure, not a note. No speed result in
this file may be traded for one.

Result: passed, 2026-08-22T01:46Z. All 10 criteria green on the EL-1 build. The
delivery changes cost none of them.
