# Credential-free DEL-4 runtime

This local-only runtime starts Supabase Auth, PostgREST, Storage, and
Postgres; applies the repository migrations and grants; then provisions the
deterministic seed and assets. It uses generated local development keys only.

```sh
bash scripts/local-del4-runtime.sh start
PORT=45308 bash scripts/local-del4-runtime.sh run node scripts/run-next.mjs dev
bash scripts/local-del4-runtime.sh reset
bash scripts/local-del4-runtime.sh stop
```

`reset` removes only this checkout's own local Docker volumes before
rebuilding the runtime. The app port is lane-specific; dependency ports are
reserved in `supabase/config.toml`.

## Concurrent checkouts

`supabase/config.toml` commits a default `project_id` of `patient-imaging-308`,
which the Supabase CLI uses to namespace its Docker containers and volumes.
Running this script always derives a project id from the checkout's absolute
path instead (`patient-imaging-<8 hex chars>`), and runs the CLI with
`--workdir` against a generated copy of `supabase/config.toml` carrying that
id — the tracked file's default is never touched. This lets two checkouts
(a worktree, a scratch clone, the main clone) run the runtime at the same
time without one's `stop`/`reset` tearing down the other's stack.

- `bash scripts/local-del4-runtime.sh project-id` prints the id this checkout
  would use, without starting or touching anything.
- `DEL4_PROJECT_ID=<id>` overrides the derived id.
- Running the Supabase CLI directly (not through this script) still uses the
  committed default, `patient-imaging-308`.
