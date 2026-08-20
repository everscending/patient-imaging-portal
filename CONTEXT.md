# Domain vocabulary — Patient Imaging Portal

The ubiquitous language for this build. Every ticket title, database column,
API field, type name, test name and UI string uses these words with these
meanings. A synonym in the "words we avoid" table is a defect, not a style
preference — one unpinned word between a writer and a reader is a system that
looks correct and silently fails.

Source of authority: `REQUIREMENTS.md` for what must be true, `docs/adr/` for
why the shapes are what they are.

---

## People and roles

| Term | Meaning |
|------|---------|
| **Patient** | A person who has had, or will have, an ultrasound visit at the clinic. Sees only their own data (SEC-2). |
| **Provider** | The clinician who performs visits and owns a schedule. Sees only their own schedule and their own patients' data. |
| **Admin** | Front-desk staff. Scoped access, and every access is logged. |
| **Account** | The login identity — an email and password held by Supabase Auth. One account maps to at most one patient record. |
| **Patient reference** | The pre-existing Patient/Account identifier a patient types during identity verification (FR-2). It exists on the seeded record *before* the account does, and it is never the primary key. Format: `PT-` plus four digits, assigned in sequence (`PT-0001`), matching the worked examples in `ARCHITECTURE.md`. An earlier draft of this file forbade a sequence; that rule had no stated reason and was withdrawn by decision on 2026-08-14. What guards the reference is EC-1's lockout — three failed attempts inside five minutes, counted per reference **and** per source — not the size of the number space. |

An **account** is who you are logged in as. A **patient** is whose data you are
looking at. They are linked, and the link is verified, never assumed.

## Identity verification

| Term | Meaning |
|------|---------|
| **Identity verification** | The FR-2 second-factor step: patient reference plus date of birth, matched against a seeded record. |
| **Identity link** | The permanent connection between an account and one patient record, written by the first successful identity verification and by nothing else (ADR-0011). An account with no link reaches no images and no reports. There is no expiring "unlock": the link does not lapse, and a returning patient is not asked again. |
| **Attempt** | One identity-verification try, successful or not. Attempts are counted per patient reference and per source, which is what makes the EC-1 lockout real. |
| **Lockout** | The state after too many failed attempts, during which further attempts are refused regardless of correctness. |

## Imaging

| Term | Meaning |
|------|---------|
| **Visit** | One completed or scheduled attendance by a patient with a provider. A visit is the *event*. |
| **Study** | The imaging produced by one completed visit. A study belongs to exactly one visit and one patient. A study is the *artifact*. Only studies from **completed** visits are visible to a patient (FR-3). |
| **Image** | One still ultrasound picture belonging to a study. |
| **Cine clip** | A multi-frame sequence belonging to a study, described by a manifest. Up to 100 frames (FR-4). |
| **Frame** | One image file inside a cine clip, carrying an index that fixes its order. |
| **Manifest** | The JSON document describing a cine clip: its frames in order, their storage references, and its default playback rate. |
| **Storage key** | The opaque random identifier under which an image or frame lives in blob storage. Never derived from a patient, study, or sequence identifier (ADR-0003). |
| **Access grant** | One authorized, audited issuance of signed URLs for a study, clip, or report. The unit at which SEC-4 records PHI access. |
| **Gap indicator** | What the viewer shows in place of a frame whose file is missing or corrupt (EC-2). The clip still plays. |

## Reports

| Term | Meaning |
|------|---------|
| **Report** | The clinician's written findings for one study. |
| **Preliminary** | A report status. **Never visible to a patient** (FR-7). |
| **Signed** | A report status: finalized, attributed to a signing provider with a signing timestamp. The only status a patient can see. |

"Finalized" is the PRD's word and means the same thing as **signed**. The code
says `signed`.

## Sharing

| Term | Meaning |
|------|---------|
| **Share link** | A time-limited, revocable, unguessable URL granting one named recipient access to one image or one report (FR-5, FR-8). |
| **Share token** | The secret inside a share link. Stored only as a hash; the raw token exists in the email and nowhere else. |
| **Unresolved share token** | A well-formed share token that matches no persisted share link. Its caller is anonymous, not a recipient, and its denied use is audited without storing the raw token. |
| **Anonymous caller** | A caller with neither an authenticated account nor a persisted share link. |
| **Expiry** | The time after which a share link stops working on its own. |
| **Revocation** | The sharer explicitly ending a share link before its expiry. |
| **Recipient** | The person a share link was sent to. Not an account, and never granted more than the one resource shared. |

Expired and revoked links behave identically to a caller: a clear "no longer
available" response, never the content, never a hint that it once existed
(EC-5).

## Scheduling

| Term | Meaning |
|------|---------|
| **Service** | A kind of ultrasound a provider offers — obstetric, renal, thyroid. A patient picks one when booking, and it is recorded on the appointment. **Availability is per provider, never per service**: a provider has one slot grid, so two services can never claim the same minute. |
| **Working hours** | A provider's recurring bookable window, expressed in the provider's own time zone. |
| **Slot length** | The duration of one bookable unit of a provider's time. |
| **Block** | A specific range a provider marks unavailable, overriding working hours. |
| **Slot** | One concrete bookable interval for one provider, with a start instant, an end instant, and a state. |
| **Open slot** | A slot that is bookable now: future, not blocked, not already taken. |
| **Appointment** | A patient's claim on a slot. Carries the status lifecycle. |
| **Status** | One of `requested`, `confirmed`, `completed`, `cancelled`, `no_show` (FR-14). |
| **Transition** | A status change. Only the transitions FR-14 and EC-11 permit are allowed, each is role-appropriate, and each writes an audit event. |
| **Minimum notice** | The period before an appointment start within which a patient may no longer reschedule or cancel (FR-13). Enforced server-side. |
| **Reminder** | One email dispatched a stated interval before an appointment. At most one per appointment per interval, enforced by a persisted send record (EC-9). |

## Compliance

| Term | Meaning |
|------|---------|
| **PHI** | Protected Health Information: patient identity, images, cine clips, frames, reports, and appointments with named providers. Everything in the tables above except provider working hours is PHI. |
| **Audit event** | One append-only record of a PHI access or a booking/status change, carrying actor, action, target and timestamp (SEC-4). Never updated, never deleted. |
| **Actor** | Who caused an audit event — an account, a share-link recipient identified by the link's record, an anonymous caller, or the system for scheduled work. |
| **Target** | What the event was about, recorded as an identifier reference. Never the content itself, and never a name or date of birth (SEC-6). |

---

## Words we avoid

| Avoid | Use instead | Why |
|-------|-------------|-----|
| Scan | **Visit** (the event) or **study** (the images) | "Scan" is used for both in clinical speech, and this codebase must never blur the two — visibility rules key on the visit's status while ownership keys on the study. |
| Session (for a visit) | **Visit** | `Session` means the authentication session and nothing else. |
| User | **Patient**, **provider**, **admin**, or **account** | "User" hides which role is acting, and the role is the whole of SEC-2. |
| Photo, picture, snapshot | **Image** | One word for one thing. |
| Video, movie, loop | **Cine clip** | The PRD's word, and it is not a video file — it is a manifest plus frames. |
| DICOM, PACS, series | — | This build stores mock JPEG/PNG frames, not DICOM. Borrowing the vocabulary implies a standard that is not implemented. |
| Booking (as a noun) | **Appointment** | `Book` is the verb; `appointment` is the record. |
| Reservation, slot booking | **Appointment** | Same reason. |
| Cancel (a share link) | **Revoke** | `Cancel` belongs to appointments. Two different lifecycles must not share a verb. |
| Delete (a share link) | **Revoke** | Nothing is deleted — revocation is a recorded state change, and the audit trail survives it. |
| Available | **Open** (of a slot) | "Available" is also used of system uptime; `open` is unambiguous. |
| Finalized | **Signed** | One word for the report status the patient can see. |
| Password hash, credentials (in logs) | — | Never logged in any form (SEC-6, SEC-7). |
| PII | **PHI** | This domain is health data. Using the weaker term signals the weaker obligation. |
| Token (unqualified) | **Share token**, **session JWT**, or **CSRF token** | Three unrelated secrets. An unqualified "token" in a ticket body is an ambiguity, not a shorthand. |
| Verify (for login) | **Authenticate** | `Verify` is reserved for FR-2 identity verification, which is a different gate. |
| 403 for someone else's data | **404** | A 403 confirms the resource exists, which is itself a cross-patient leak under FR-6. |

---

## Terms added by the closed decisions

| Term | Meaning | Source |
|------|---------|--------|
| **Findings** | The body of a report: what was observed. A structured column, not free-form HTML. | ADR-0007 |
| **Impression** | The report's conclusion. A structured column. | ADR-0007 |
| **Signing provider** | The provider recorded in `signed_by`. Only present on a signed report. | ADR-0007 |
| **Out of hours** | An appointment that survives an availability edit which removed the time around it. An annotation on the appointment, derived from current availability and recomputed on every availability write — never edited by hand, never a lock. | ADR-0006 |
| **Asset pool** | The set of distinct synthetic images and cine frame sets generated once by the seed. Many studies reference the same pool asset; sharing bytes never shares access. | ADR-0009 |
| **Pool asset** | One generated still or one generated 100-frame set inside the asset pool. | ADR-0009 |
| **Source seed** | The fixed value the asset generator starts from, so a clean checkout reproduces byte-identical assets. Unrelated to "seed script" as a verb. | ADR-0009, CQ-6 |

Additions to **words we avoid**:

| Avoid | Use instead | Why |
|-------|-------------|-----|
| Conclusion, summary (of a report) | **Impression** | The clinical term, and the column name. |
| Report body, report HTML | **Findings** and **impression** | There is no report blob — ADR-0007 stores structured columns. |
| Blocked (of an appointment) | **Out of hours** | `Block` is a provider's unavailability range. An appointment is never "blocked". |
| Flagged (unqualified) | **Out of hours** | Name the flag. |
| Seed (for the generator input) | **Source seed** | `Seed` alone means the seed script. |
