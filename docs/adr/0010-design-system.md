# ADR-0010 — Design system: AS Software brand, muted

- **Status:** Accepted
- **Date:** 2026-08-14
- **Requirements touched:** CQ-4, CQ-5, DEL-6, and every UI ticket

## Context

This build is a take-home assessment for **AS Software**, whose product is
ultrasound reporting and image management ("Ultrasound, Automated."). The
audience reading the submission is therefore the brand's own team, which makes
looking like an AS Software product worth real points — and looking like an
untouched component-library default worth losing them.

Three candidate palettes were drawn on live screens and compared:

1. **AS Software brand, muted** — their violet, desaturated.
2. **Clinical neutral** — a cool grey system with violet held right back.
3. **athenahealth** — that company's published brand palette.

## Decision

**P1 — AS Software brand, muted.**

### Colour

Derived from AS Software's own theme stylesheet
(`/wp-content/themes/as-software/assets/dist/css/style.css`), then desaturated.

| Token | Value | Source |
|-------|-------|--------|
| `primary` | `#6b46a8` | Their `#873fe0`, pulled toward their own plum |
| `secondary` | `#3b2a54` | Their `#36195a` |
| `accent` | `#1d8fa5` | Their `#00c0dd`, darkened |
| `base-100` | `#ffffff` | |
| `base-200` | `#f7f5fb` | violet-tinted surface |
| `base-300` | `#ebe6f4` | |
| `base-content` | `#241b31` | |
| `info` | `#2f5fb8` | |
| `success` | `#16785c` | |
| `warning` | `#9a5b12` | |
| `error` | `#a63a4b` | |

**Two colours were deliberately not used as-published.**

- `#873fe0` is a marketing-site violet. At full saturation across an entire
  application it reads as a highlighter rather than as brand, and it sits behind
  a greyscale ultrasound image for as long as a patient is looking at one.
  `#6b46a8` is the same hue, desaturated, and measures about **6.9:1** on white
  — comfortably past WCAG AA for body text.
- `#00c0dd` measures roughly **2:1** on white and fails CQ-5 as a text colour
  outright. `#1d8fa5` replaces it. The original stays available as a fill.

### Typography

AS Software use **niveau-grotesk** (Adobe Typekit), which is licensed and
cannot ship in this repo. The build uses **Figtree** (Google Fonts) — the
closest free geometric sans — self-hosted or loaded from Google Fonts, with a
system sans fallback.

### Contrast is a gate condition, not a preference

CQ-5 requires sufficient contrast and status conveyed by more than colour alone.
Every token above is checked against its intended background, and **status is
always carried by a word as well as a colour** — a badge reads "Signed",
"Outside hours", "Revoked", never a bare coloured dot.

## Consequences

**It reads as an AS Software product** to the people evaluating it, which is the
whole reason a brand-derived palette beats a default theme here.

**The muting is load-bearing, not taste.** Both changed values were changed for a
measured contrast or legibility reason, and both are recorded above so a later
ticket cannot "restore the real brand colour" and silently fail CQ-5.

**One palette, one place.** The tokens live in the Tailwind/DaisyUI theme
configuration. No component hardcodes a hex value; a ticket that needs a new
colour adds a token here first.

## Alternatives considered

**P2 · Clinical neutral.** A cool grey system with violet only on primary
actions. Genuinely the best option for judging greyscale ultrasound — a neutral
surround does not shift how the image reads — and the safest on contrast.
Rejected because it forfeits the brand recognition, which is worth more in this
specific submission than the marginal perceptual gain. The perceptual point is
not dismissed: the image viewer itself uses a **near-black surround** regardless
of palette, which is where the surround actually matters.

**P3 · athenahealth.** Their published brand guide (*our brand colors*, Nov 2017)
gives exact values: Purple `#582c83` (PMS 268), Teal `#0093b2`, Ruby `#a50050`,
plus digital-only action colours CTA green `#62bb46` and Alert orange `#f26522`.
A deeper, more restrained purple that reads as established healthcare software.
Rejected for the obvious reason — it is a **different company's** brand, and
wearing a competitor's colours into an AS Software assessment is the wrong
signal. Worth recording that their guide states only Purple, Ruby, Brown, Gray
and Black pass WCAG AA; Teal, Spring, Yellow and both action colours do not.
