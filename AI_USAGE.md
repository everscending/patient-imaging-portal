# AI usage

DEL-1 requires this document. It states which AI tools built this repository
and for what, and states plainly whether any AI runs when the deployed app
serves a request.

## Tools used, and for what

Every phase of this build — planning, design records, ticket authoring,
implementation, and review — used the same tool: **Claude (Sonnet 5), via
Claude Code**, driven by this repository's own `loom` orchestration (see
`AGENTS.md` and `docs/agents/`).

| Phase | What Claude did |
|-------|------------------|
| Planning | Drafted `PRD.md`, `REQUIREMENTS.md`, and `ARCHITECTURE.md` from the brief given at project start. |
| Design records | Authored `docs/adr/`, including the elective-scope decision (`docs/adr/0005-elective-scope-el1-only.md`) and the stated-rule parameters (`docs/adr/0008-stated-rule-parameters.md`). |
| Requirement extraction | Derived `REQUIREMENTS.md`'s numbered requirements (`FR-`, `SEC-`, `DEL-`, etc.) from `PRD.md`. |
| Ticket authoring | Wrote each ticket's scope, acceptance criteria, and mandatory adversarial tests, sequenced by dependency. |
| Implementation | Ran one Claude Code session per ticket, each in its own git worktree, each starting from a generated brief for that ticket alone. This ticket's own commit carries an `Assisted-by` trailer naming the session that wrote it. |
| Review | Ran a further Claude Code session per ticket to review that ticket's diff against `origin/main` before merge. |

## Prompts and configuration that materially shaped the solution

Every implementation and review prompt is generated, not hand-written: each
one assembles the ticket's own row from the planning documents above —
`REQUIREMENTS.md`, `CONTEXT.md`, and the relevant files under `docs/adr/` —
plus a fixed set of execution rules (which worktree, which gate tier, the
commit trailer format, the submit script). None of those source documents
carries PHI, a credential, or a key (SEC-6, SEC-7), so no prompt built from
them does either. Two configuration choices from that process are worth
recording because they shaped what got built, not just how:

- The gate a session's work must pass before it may commit is pinned in
  `.loom.yml`, not restated here.
- The elective scope a planning or authoring session works within is pinned
  in `docs/adr/0005-elective-scope-el1-only.md`, not restated here.

## AI-1 does not apply to this build

EL-5 (optional natural-language booking) is cut —
`docs/adr/0005-elective-scope-el1-only.md`. AI-1, the natural-language
booking eval harness, applies only if EL-5 is selected. It is not: there is
no golden set, no accuracy threshold, and no scorecard harness in this
build, and adding one would mean building a cut elective.

## Runtime AI

**No runtime AI is used.** No model, engine, or LLM is called on any request
path in this application, at any tier. There is therefore no runtime model,
engine, or version to record here.
