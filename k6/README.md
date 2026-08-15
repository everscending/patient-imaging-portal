# k6 load scripts

This directory holds the k6 load-test scripts for PF-1, PF-2, PF-3 and PF-5
(REQUIREMENTS.md). Writing the scripts themselves is a later ticket; this
README documents how they must be run once they exist.

## Stated load

**20–50 virtual users for 60 seconds**, against the seeded dataset
(REQUIREMENTS.md). Every script in this directory must be runnable at that
load with `--vus` and `--duration`, e.g.:

```sh
k6 run --vus 50 --duration 60s --env BASE_URL="$BASE_URL" <script>.js
```

## No literal port

Nothing in this directory may hardcode a port. `BASE_URL` is derived from
`PORT` (default 4310, ARCHITECTURE.md §9) the same way `playwright.config.ts`
derives its `baseURL` — never a well-known port number written in as a
literal:

```sh
BASE_URL="http://localhost:${PORT:-4310}" k6 run --env BASE_URL="$BASE_URL" <script>.js
```

## Shared-pool caveat

Per ARCHITECTURE.md §16, a shared pool of seed assets warms caches more than
production would. Scripts should request distinct assets per virtual user
where k6 can arrange it, and report when it can't.
