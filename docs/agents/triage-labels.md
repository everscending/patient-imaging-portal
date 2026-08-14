# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those
roles onto what actually carries them in this repo's tracker (Linear, team
`Jordan`).

Linear splits the job across two fields. Labels are multi-valued and additive.
Status is single-valued and is the column an issue sits in on the board. Loom
treats Status as its state machine (Loom change P90, shipped 2026-08-11), so the
two roles Loom drives are carried by Status — applying them as labels would
create a second, silently diverging source of truth.

| Canonical role    | Carrier in Linear    | Value        | Meaning                                  |
| ----------------- | -------------------- | ------------ | ---------------------------------------- |
| `needs-triage`    | Label                | `needs-triage`   | Maintainer needs to evaluate this issue  |
| `needs-info`      | Label                | `needs-info`     | Waiting on reporter for more information |
| `ready-for-agent` | **Status**           | `Todo`       | Fully specified, ready for an AFK agent  |
| `ready-for-human` | Label                | `ready-for-human` | Requires human implementation           |
| `wontfix`         | **Status**           | `Canceled`   | Will not be actioned                     |

When a skill mentions a role — "apply the AFK-ready triage label", for
example — set the carrier named in the table above. For `ready-for-agent` and
`wontfix` that means a Status change, not a label change.

## Loom's other states

Loom maps the rest of its lifecycle to Status the same way. Do not create labels
with these names:

| Loom state    | Linear Status |
| ------------- | ------------- |
| `ready-for-agent` | `Todo`      |
| `in-progress` | `In Progress` |
| `review`      | `In Review`   |
| `merge-queue` | `Merge Queue` |
| `blocked`     | `Blocked`     |

## Housekeeping

A stale `ready-for-agent` **label** existed on team `Jordan` from before the
Status migration. It carried no issues and should be deleted from Linear's team
label settings. If it reappears, something is still applying the old label —
find it rather than reconciling by hand.
