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

`reset` removes only the `patient-imaging-308` local Docker volumes before
rebuilding the runtime. The app port is lane-specific; dependency ports are
reserved in `supabase/config.toml`.
