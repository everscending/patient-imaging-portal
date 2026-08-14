# UX specification — Patient Imaging Portal

The source of truth the build's UI gate checks against. A UI ticket that
contradicts this file is wrong; a UI ticket that needs something this file does
not carry is a phase-2 escape — close it here first, then write the ticket.

Companion documents: `REQUIREMENTS.md` (what must be true), `ARCHITECTURE.md`
(wire shapes, URL map, test hooks), `docs/adr/` (why), `CONTEXT.md` (words).

Mockups reviewed at 390 px and at desktop: `.lavish/phase2-ux.html`.

---

## 1 · Decisions of record

| ID | Decision | Resolved as |
|----|----------|-------------|
| **P-0** | Palette and typography | AS Software brand, muted — see `docs/adr/0010` |
| **U-1** | Patient navigation shell | Bottom tab bar on mobile, left sidebar on desktop |
| **U-2** | Where identity verification happens | Dedicated `/verify` route, redirect with return-to |
| **U-3** | Cine playback controls | Always-visible docked control bar |
| **U-4** | Sharing and revocation | Share action on the item, plus a standing Shared links screen |
| **U-5** | Provider availability editor | Form-based weekday list with a post-save outcome summary |

---

## 2 · Design system

Full rationale in `docs/adr/0010`. The build-facing summary:

- **Primary** `#6b46a8` · **Secondary** `#3b2a54` · **Accent** `#1d8fa5`
- **Surfaces** `#ffffff` / `#f7f5fb` / `#ebe6f4` · **Text** `#241b31`
- **Status** info `#2f5fb8` · success `#16785c` · warning `#9a5b12` · error `#a63a4b`
- **Type** Figtree, with a system sans fallback

Two rules that are gate conditions, not preferences:

1. **No component hardcodes a hex value.** Colours come from theme tokens. A
   ticket needing a new colour adds a token in the theme config first.
2. **`#873fe0` and `#00c0dd` are not used for text.** They are AS Software's
   published values, and both fail CQ-5 contrast at body size. The muted
   substitutes above are what ship.

---

## 3 · The shell (U-1)

One navigation model, two shapes.

**Mobile (< 768 px) — bottom tab bar.** Four destinations, fixed to the bottom,
inside the thumb arc: **Imaging · Reports · Visits · Shares**. Every destination
is one tap from every other, which is what the DEL-6 demo walkthrough needs.

**Desktop (≥ 768 px) — left sidebar.** Same four destinations as a persistent
list, patient name above them, unlock countdown below them.

**Provider** uses the sidebar at both sizes: **Schedule · Availability**.
**Admin** uses the sidebar with **Audit log** only — that is the whole of admin's
surface in the URL map. Both are desk users; the phone-width bar is a patient
affordance.

**The unlock indicator is part of the shell.** Whenever an identity unlock is
live, its remaining time is visible — a badge in the mobile top bar, under the
sidebar on desktop. A patient must never be surprised by re-verification.

**Tap targets** are at least 44 × 44 px on touch. The tab bar is the screen
EC-4 is measured on first.

---

## 4 · Screens

Each screen names the requirements it must satisfy and the specific thing it has
to prove. `data-testid` names are pinned in `ARCHITECTURE.md` §14.

### 4.1 Sign in and register — `/login`, `/register` · FR-1, SEC-7

Email and password, session expiry stated in plain words. Signing in unlocks
nothing on its own; every PHI route still requires §4.2.

### 4.2 Identity verification — `/verify` · FR-2, EC-1

**A dedicated route, not a modal (U-2).** Middleware redirects any locked route
here carrying `?next=`, and returns the patient afterwards. One URL, one
component, one focus target.

**The error string is the whole point of this screen.** One identical message for
a wrong patient reference, a wrong date of birth, and an active lockout:

> **We could not match those details.** Please check them and try again.

No field-level error. No partial-match hint. **No mention that a lock is in
effect** — saying "locked" confirms the patient reference exists, which is the
leak EC-1 exists to prevent. After 3 failures the submit button is disabled for
5 minutes with a neutral "Try again in a few minutes"; the *response* is still
the same string.

The screen states the unlock lasts 45 minutes, so its later expiry is expected
rather than alarming.

### 4.2a Profile — `/profile` · FR-1

The third capability FR-1 names, after register and log in. Deliberately small:
display name and contact phone, with email shown read-only.

Email and password changes go through Supabase Auth's own flows, not this form.
**The patient reference is never editable here** — it is written once by identity
verification (§4.2), and a profile form that could change it would hand any
account access to any patient's records.

Reachable from the shell at both sizes. Before FR-2 has run it shows the account
only; afterwards it also shows the linked patient reference, read-only.

### 4.3 Studies list — `/studies` · FR-3, EC-12

Cards on mobile, a thumbnail grid on desktop. Each entry: study description,
date, provider, and counts of images and cine clips.

**Only studies from completed visits appear.** Scheduled and cancelled visits are
invisible here.

**The empty state is a requirement, not polish** (EC-12): "No images yet — images
appear here once a completed visit has been processed by the clinic." A list
that errors on zero rows fails the gate.

### 4.4 Image viewer — `/studies/[id]` · FR-3, EC-3, EC-4

Filmstrip of the study's images; the selected one fills the frame against a
**near-black surround** — this is where surround actually affects how greyscale
reads, and it stays near-black in every palette.

**Zoom and pan**: pinch and drag on touch; `−` / `100%` / `+` buttons plus arrow
keys on desktop. CQ-5 requires the keyboard to do everything the pointer does.

**EC-3 is a visible state, not a hope.** A thumbnail renders immediately, the
full image streams in behind a labelled loading state, and the UI stays
interactive throughout. It never blocks on a full download.

### 4.5 Cine viewer — `/studies/[id]/clips/[id]` · FR-4, EC-2, EC-4

**Always-visible docked control bar (U-3)** below the frame — never a fading
overlay. Controls that hide cannot have their tap targets measured, and contrast
over a moving greyscale frame cannot be guaranteed.

The bar carries: a scrub track, previous / play-pause / next as real buttons, an
FPS control defaulting to **12** (stated in the README per FR-4), and a frame
counter.

**EC-2 lives in this bar.** When the manifest reports frames with
`available: false`:

- the frame area shows a gap placeholder — "Frame 47 unavailable" — not a broken
  image;
- the scrub track shows a marker at each missing frame;
- a persistent notice reads "2 of 100 frames unavailable — playback continues";
- **playback does not stop and the viewer does not crash.**

The client acts on `available: false` from the API. It never infers a gap from a
failed image load.

**Orientation change preserves playback state** (EC-4): current frame, play/pause
and FPS all survive a rotate.

### 4.6 Reports — `/reports`, `/reports/[id]` · FR-7, CQ-4, CQ-5

Structured text rendered by one component (ADR-0007), so it reflows at phone
width, is keyboard-navigable, and prints cleanly.

Header block: **patient reference, study reference, signing provider and signing
timestamp** — the four fields `GET /api/reports/:id` actually carries. Then
**Findings**, then **Impression**, as real headings.

The patient's *name* is deliberately not in the report response: the reader is
already authenticated as that patient, the reference identifies the document,
and every additional PHI field on the wire is one more thing a share link could
disclose (SEC-9's data-minimisation argument, applied to the response body).

**Preliminary reports never appear in the list and return 404 if their URL is
guessed** — never 403, which would confirm the report exists.

Actions: Share (§4.7), and Print on desktop.

### 4.7 Sharing — item action + `/shares` · FR-5, FR-8, SEC-8

**Two halves (U-4).** Creating is an action on the thing you are already looking
at — **an image or a report** — opening a sheet on mobile and a dialog on
desktop that asks only for a recipient email and states the rules in plain
words: *expires after 48 hours, revocable at any time*.

**Cine clips are not shareable.** FR-5 and FR-8 cover images and reports only,
and `share_links.resource_kind` admits exactly those two. The cine viewer offers
no share action.

Revoking lives at a **standing `/shares` destination** in the shell, listing
every link the patient has created with its state — **Active** (with time
remaining), **Revoked**, **Expired** — and a Revoke button on the active ones.
That screen is what the SEC-8 write-up points at and what DEL-6 demonstrates
revocation on.

### 4.8 The recipient's view — `/s/[token]` · FR-5, FR-8, EC-5, SEC-8

**The highest-risk page in the build** — the only PHI-bearing route reachable
without a session.

It shows the one shared resource and nothing else: no patient navigation, no
sibling studies, no route to any other resource. `noindex`. A short banner says
the link was shared by a patient, is time-limited, and its use is recorded, plus
the remaining time.

**Expired, revoked, and never-existed render one identical screen:**

> **This link is no longer available.** Secure links expire and can be revoked by
> the person who shared them. Ask them to send a new one.

Any difference between those three confirms the link once existed (EC-5). No
cached content is served after expiry or revocation.

### 4.9 Booking — `/book` · FR-11, FR-12, EC-6, EC-7, EC-10

**Service selector first, then provider**, then open slots grouped by day. Only
genuinely open, future slots appear.

Choosing a service narrows *which providers* can be picked — it does not filter
slots. A provider has one slot grid, not one per service, so two services can
never both claim the same minute (`ARCHITECTURE.md` §3). The chosen service is
recorded on the appointment and shown on every appointment card.

**EC-6 is visible on this screen.** Every time renders in the **viewer's** zone
with its abbreviation, and a line states the provider's zone. The confirmation
row additionally shows the **provider's local time** for the chosen slot, so
neither side can misread it.

**EC-7 is the loser's message.** A concurrent loss renders:

> **That slot is no longer available.** Someone booked it moments ago. Please
> choose another time.

and the slot greys out in place. Never a stack trace, never a silent double-book.

**EC-10**: Confirm carries a client-generated idempotency key. A double-tap or a
retry creates at most one appointment. The same key against a *different* slot is
an error, not a silent no-op (`ARCHITECTURE.md` §10).

### 4.10 My appointments — `/appointments` · FR-13, FR-14, EC-8, EC-11

Cards on mobile, a table on desktop. Each: date and time in the viewer's zone,
provider, service, status, and available actions.

**Status is a word, never only a colour** (CQ-5): Requested, Confirmed,
Completed, Cancelled, No-show, Outside hours.

**Actions are rendered from the server's `allowedTransitions`**, never from a
matrix written into the component. A patient sees Cancel and Reschedule only
when the server says so; the role × transition table lives in exactly one place
(`ARCHITECTURE.md` §6). A booking arrives as **Requested** and is confirmed by
the provider — nothing auto-confirms, and the UI must not imply otherwise.

**"Outside hours"** is ADR-0006's flag — the provider changed their hours and this
appointment was preserved. Copy: *"Your appointment is unaffected."* It never
blocks reschedule or cancel; it is information, not a lock.

**The notice rule renders from the server**, using `canChange` and
`changeDeadline` from the API — never re-derived in the browser, or the UI and
the server will disagree. Inside the window the actions are replaced by:
*"Changes are not allowed within 24 hours of the start. Call the clinic."*

**EC-11**: invalid transitions are not offered. No-show appears only on a
confirmed appointment whose start has passed.

### 4.11 Provider schedule — `/provider/schedule` · FR-10, FR-14, SEC-2

The day's slots in the **provider's own zone**, stated on the page. Booked slots
show the patient **by reference only — never a name or date of birth**, keeping
the provider surface consistent with the no-PHI-in-logs discipline (SEC-6).
Open slots are shown as open. Actions offered only where the transition is legal.

A provider sees only their own schedule (SEC-2).

### 4.12 Availability editor — `/provider/availability` · FR-10, EC-8

**Form-based weekday list (U-5)**, not a drag grid — native inputs mean keyboard
and screen-reader support come free, and drag-to-select at phone width is both
hard to build and hard to make accessible.

Working hours per weekday, slot length, and a list of blocks. The provider's
time zone is stated at the top.

**The post-save summary is the EC-8 requirement made visible.** It renders the
API's own `preservedOutOfHours` payload:

> **Saved. 14 open slots removed.**
> These booked appointments are now outside your hours and have been kept:
> Mon 16:00 · PT-04471

The edit always succeeds. Booked appointments are never silently deleted and
never double-booked.

### 4.13 Audit log — `/admin/audit` · SEC-4, SEC-6, FR-6

Time, actor, action, target, outcome. **Identifiers only** — no names, no dates
of birth, no health context.

**Denials are listed alongside grants.** That is what makes the FR-6 and FR-9
adversarial tests demonstrable to a reviewer: the rejected attempt has a row.

### 4.14 Degraded states · EC-12, CQ-3

Three shapes, all required:

- **A dependency is unreachable** — a clear message in place of the content
  ("Images are temporarily unavailable… your data is safe"), plus a retry.
  Never an unhandled 500, never a blank screen.
- **Email dispatch failed but the share link exists** — the link is *not* rolled
  back. The UI says delivery failed, that the link is active, and offers the URL
  to copy. The link is the durable thing; the email is a delivery attempt.
- **Health endpoint** — `GET /api/health` returns 200 with per-dependency state
  in the body, so an uptime check can tell "the app is gone" from "the app is up
  and reporting a degraded dependency" (PF-9).

---

## 5 · Cross-cutting rules

**Responsive (CQ-4).** Every patient flow is fully usable at 390 px: identity
verification, image and cine viewing, report viewing, sharing, and booking. No
horizontal scrolling of the page body; wide content scrolls inside its own
container. Touch targets ≥ 44 px.

**Accessibility (CQ-5).**
- Every interactive control is a real focusable element with an accessible name.
  Cine transport, slot buttons and revoke controls are buttons, not divs.
- Full keyboard operation, including zoom and pan and frame stepping.
- Status is always conveyed by text as well as colour.
- Contrast is checked against the actual token pair, not assumed.
- One `<h1>` per page; headings descend without skipping.
- The `/verify` error is announced to assistive technology (`role="alert"`).

**Server-side validation, every surface.** EC-12 names booking, availability,
image/report access, sharing **and auth payloads**. The client may validate for
speed; the server validates for correctness, and the auth forms are not exempt.

**Never rendered anywhere.** A password or hash; a raw share token outside the
one screen that issues it; another patient's identifiers; a database error
string; a stack trace.

**Empty states.** Every list has one, and every one renders cleanly rather than
erroring (EC-12).

**Loading states.** Anything that can take more than a moment shows a labelled
loading state. The UI never freezes waiting on a network response (EC-3).
