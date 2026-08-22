# The recorded demo walkthrough

A screen recording of the whole product, driven in DEL-6's order by one
committed test. Nothing in it is acted out: the recording is a by-product of
`e2e/demo-walkthrough.spec.ts` driving the real app, so every second of it is
a requirement being met, and anyone can produce it again.

## Where the recording is

| | |
|---|---|
| Recording | `test-results/demo-walkthrough/demo-walkthrough.webm` |
| Step timings | `test-results/demo-walkthrough/demo-timeline.json` |
| Driven by | `e2e/demo-walkthrough.spec.ts` |

Both files are build output, not commits — `test-results/` is ignored, the
same way `tests/artifacts/demo-run.log` is. The spec that makes them is what
is committed, so the recording is always one command away rather than a stale
file someone has to trust.

## How to make it again

```
npx playwright test --project=demo-walkthrough
```

**Run target: the local stack.** The command boots
`e2e/fixtures/start-test-server.mjs`, which runs the real Next.js app against
the fake Supabase Auth and PostgREST fixture, with the seeded demo accounts.
It does not touch the deployed site. Pass `PORT` to move it off the default
`4310` if that port is busy — the run recorded below used `PORT=4650`.

Recording is switched on by the `demo-walkthrough` project in
`playwright.config.ts` and nowhere else, so no other spec records.

## What each moment of the recording shows

Offsets are from the start of the recording, harvested from the run of
2026-08-22 (a 15.64-second recording, 533,015 bytes). They come from that
run's `demo-timeline.json`, not from a stopwatch. A later run lands within a
second of these, so treat them as where to look rather than as exact frames.

| At | DEL-6 step | What you see |
|----|-----------|--------------|
| 00:00 | DEL-6 (1a) patient identity verification | Sign in, then unlock records with the patient reference and date of birth |
| 00:02 | DEL-6 (1b) image viewing | The study opens and the image viewer finishes loading |
| 00:03 | DEL-6 (1c) cine viewing | A cine clip plays; the screen offers no way to share it |
| 00:05 | DEL-6 (2a) secure sharing of an image | A secure link to an image is sent to a recipient |
| 00:05 | DEL-6 (2b) secure sharing of a report | A secure link to a report is sent to a recipient |
| 00:06 | DEL-6 (2c) revocation on /shares | At phone width, the shares list revokes one of the two links |
| 00:08 | DEL-6 (3) report viewing | The signed report is read in the portal |
| 00:08 | DEL-6 (4) provider availability setup | The provider narrows Monday's hours; the collision list names the appointment that is kept |
| 00:09 | DEL-6 (5) patient booking | Service, then provider, then a time, then confirm |
| 00:12 | DEL-6 (6) the no-double-book behaviour | Two live sessions confirm the last open time at once |
| 00:13 | — race resolved | One session is booked; the other is told the time has gone |
| 00:13 | DEL-6 (7a) reschedule | An appointment moves to another time with the same provider |
| 00:14 | DEL-6 (7b) cancel | An appointment is cancelled and the list shows it |
| 00:14 | DEL-6 (8) a reminder being sent | The reminder job runs behind its shared secret |

The phone-width segment is DEL-6 (2c), driven at 390px on the patient shell
with its bottom tab bar.

## The no-double-book moment is a real race

At 00:12 two signed-in sessions each pick the genuinely last open time — the
spec books every other open time first, then checks exactly one is left — and
confirm at the same instant. Neither outcome is arranged. The database picks
the winner, one request is answered `201` and the other `409
slot_unavailable`, and the losing screen shows the pinned wording:

> That slot is no longer available. Someone booked it moments ago. Please
> choose another time.

Both screens are recorded, so whichever session loses, the refusal is on
camera. In the run above the second session lost.

## The reminder, and which transport carried it

DEL-6 (8) calls the real scheduled job, `POST /api/jobs/reminders`, with the
`x-cron-secret` header, and the spec also checks the job refuses `401` without
it. It is the job itself, never a stub and never a direct call to the mailer.

**Transport: `log`.** With no mail-provider key set, `lib/config.ts` selects
the `log` transport (GAP-3), which is a real transport — it writes each
message to `.local/mail/*.json` rather than handing it to a provider. That is
what lets the whole walkthrough run with no credentials at all.

The job answered `{"due":0,"sent":0,"skipped":0,"failed":0}` and the `log`
transport delivered 2 messages: the two secure-link emails queued at 00:05,
drained from the durable outbox by the same job.

**The `sent` count is 0 on the local stack, and cannot be anything else.**
`sent` counts appointment reminders, and an appointment only becomes due in a
30-minute window 24 hours ahead of it. The fixture seeds fixed appointment
times, none of which land in that window, and it implements neither the
`claim_reminder_send` routine nor the `reminder_sends` table the count is
written to. So the local stack can show the job running and real delivery
through the `log` transport, but it cannot show a non-zero appointment
reminder count. That needs the deployed stack.

## What keeps this honest

`tests/docs/demo-contract.test.ts` fails the build if the demo drifts: if the
steps leave DEL-6's order, if the phone-width segment goes, if the race is
replaced with a pre-booked time, if a share action appears on a cine clip, if
a raw share token is read back off a later screen, if a credential reaches the
recording, if the reminder becomes a stub, or if this document loses its
regeneration command.
