# Issue Tracker

Issues for this repo live in **Linear**.

| Field        | Value                                                                  |
| ------------ | ---------------------------------------------------------------------- |
| Workspace    | `everscending`                                                          |
| Team         | `Jordan` (key `JOR`)                                                    |
| Project      | `Patient Imagine Portal`                                                |
| Project ID   | `21970468-61c4-4585-9ac4-15d1ce65953d`                                  |
| Project URL  | https://linear.app/everscending/project/patient-imagine-portal-ebf3ba688732 |

Note: the project name in Linear is spelled "Imagine", not "Imaging". Match the
spelling in Linear when querying by name, or use the project ID.

## How to read and write issues

Use the Linear MCP server (`mcp__linear-server__*`). It is the primary interface —
there is no `gh`/`glab` equivalent here, and no `LINEAR_API_KEY` is configured for
raw GraphQL calls.

| Task                | Tool                                          |
| ------------------- | --------------------------------------------- |
| Find issues         | `list_issues` (filter by `team`, `project`, `label`, `state`) |
| Read one issue      | `get_issue`                                    |
| Create or edit      | `save_issue`                                   |
| Comment             | `save_comment` / `list_comments`               |
| Labels              | `list_issue_labels` / `create_issue_label`     |
| Statuses            | `list_issue_statuses`                          |

When creating an issue, always set both `team` and `project` so it lands on the
right board.

## Conventions

- **New issues** are created in the `Patient Imagine Portal` project on team `Jordan`.
- **State lives in the Status field**, not in labels, for the states Loom drives.
  See `docs/agents/triage-labels.md` for the full mapping.
- **Agent briefs** are posted as a comment on the issue, following the structure in
  the `triage` skill's `AGENT-BRIEF.md`.
- **Blocking relationships** use Linear's native blocked-by / sub-issue relations
  rather than prose in the description.

## Pull and merge requests

Linear is not the code-review surface. PRs and MRs are not part of the triage
queue and do not carry triage roles. Only issues do.
