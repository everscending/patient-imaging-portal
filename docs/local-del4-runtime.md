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

A derived id alone is not enough for coexistence: the committed config also
pins its listen ports, and a second checkout's `start` would die on "port is
already allocated" (cleanly — the first stack survives — but it never comes
up). The generated config therefore also shifts every port into a
per-checkout block of 200, derived from the same path hash, and the script
reads the database port back from the CLI's own `status` output rather than
assuming the committed value — so a second checkout's provisioning can never
talk to the first checkout's database.

- `bash scripts/local-del4-runtime.sh project-id` prints the id this checkout
  would use, without starting or touching anything.
- `bash scripts/local-del4-runtime.sh port-base` prints the derived port
  block's base the same way.
- `bash scripts/local-del4-runtime.sh materialize` prints the generated
  config exactly as the CLI would receive it.
- `DEL4_PROJECT_ID=<id>` and `DEL4_PORT_BASE=<port>` override the derivations.
- Running the Supabase CLI directly (not through this script) still uses the
  committed default id and ports.
