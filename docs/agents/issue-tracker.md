# Issue tracker: Linear

Team: JOR
Project: Patient Imaging Portal

Issues for this repo live in **Linear**. The two lines above are machine-read —
see "Why the format matters" below before editing them.

| Field | Value |
| ----- | ----- |
| Workspace | `everscending` |
| Team | `Jordan` (key `JOR`) |
| Project | `Patient Imaging Portal` |
| Project ID | `21970468-61c4-4585-9ac4-15d1ce65953d` |
| Project URL | https://linear.app/everscending/project/patient-imaging-portal-ebf3ba688732 |

## Why the format matters

`Team:` and `Project:` must stay as **plain `Field: value` lines inside the first
20 lines** of this file. Loom parses them with a line-anchored regex over the
head of the file; a value inside a markdown table row does not match and reads as
empty.

That is not cosmetic. **Team `Jordan` is shared by four projects** — Patient
Imaging Portal, Demand Letter Generator, Triggers API, and Patient Portal — and
loom's scheduler universe is "open issues labelled `build-N`". With `Project:`
unset, every issue read is unscoped and a build here would pick up another
project's open tickets. `build-1` and `build-2` already exist on this team and
belong to Demand Letter Generator.

With `Project:` set, loom scopes every read to this project and the collision
cannot happen. Do not move these lines into the table, and do not push them past
line 20.

## Credentials

`LINEAR_API_KEY` is configured in `~/.loom/config.yml` (machine-wide, `chmod
600`). It is never committed and never placed in `.loom.yml`.

## How to read and write issues

Use the Linear MCP server (`mcp__linear-server__*`) — there is no `gh`/`glab`
equivalent for the tracker here.

| Task | Tool |
| ---- | ---- |
| Find issues | `list_issues` (filter by `team`, `project`, `label`, `state`) |
| Read one issue | `get_issue` |
| Create or edit | `save_issue` |
| Comment | `save_comment` / `list_comments` |
| Labels | `list_issue_labels` / `create_issue_label` |
| Statuses | `list_issue_statuses` |
| Milestones (epics) | `list_milestones` / `save_milestone` |

**Always set both `team` and `project`** when creating an issue, or it lands on
the team board unscoped and becomes visible to another project's build.

Prefer the **project ID** over the name when querying. The name has changed once
already, and a stale name returns an empty result set rather than an error —
which reads as "this build has no tickets", not as "the query was wrong".

## State model

**State lives in Linear's Status field, not in labels**, for the five states loom
drives. All five already exist on team `Jordan`:

| Loom state | Linear status | Type |
| ---------- | ------------- | ---- |
| `ready-for-agent` | `Todo` | unstarted |
| `in-progress` | `In Progress` | started |
| `review` | `In Review` | started |
| `merge-queue` | `Merge Queue` | started |
| `blocked` | `Blocked` | started |
| closed | `Done` | completed |

Labels carry the rest: `build-N` membership, `fix`, `tier::docs|logic|api|ui`,
and `model::<tier>` escalations. Those already exist on this team too.

## Conventions

- **New issues** are created in the `Patient Imaging Portal` project on team
  `Jordan`.
- **Epics are Linear milestones** on this project. Every milestone carries a
  `## Acceptance criteria` section — the phase-6 acceptance probe reads it, and
  an epic without one cannot be probed meaningfully.
- **Blocking relationships** use Linear's native blocked-by relations rather than
  prose in the description.
- **Agent briefs** are posted as a comment on the issue.

## Pull requests

Linear is the board, not the code host. The forge is **GitHub** —
`git@github.com:everscending/patient-imaging-portal.git`. Pull requests live
there; issues live in Linear. A ticket is closed by its merged PR, which carries
a `Closes` link back to the Linear issue.
