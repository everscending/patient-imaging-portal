# k6 load scripts

This directory holds the k6 load-test scripts for PF-1 through PF-6
(REQUIREMENTS.md). PF-4 and PF-6 are read from the server timing lines produced
while `booking.js` drives their routes, not from k6 request duration.

## Stated load

**20–50 virtual users for 60 seconds**, against the seeded dataset
(REQUIREMENTS.md). The scripts embed that ramp and duration, so a measured run
needs only the configured base URL:

```sh
k6 run --env BASE_URL="$BASE_URL" <script>.js
```

`booking.js` also requires a fresh eight-character lowercase hexadecimal
`RUN_ID`. It creates at most one booking/share pair per VU. Reusing the same
`RUN_ID` safely reuses each booking and skips duplicate shares:

```sh
RUN_ID="<unique-8-hex>" BASE_URL="$BASE_URL" k6 run --env RUN_ID="$RUN_ID" --env BASE_URL="$BASE_URL" k6/booking.js
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

PF-3 passes the manifest's remaining frame requests to one `http.batch`, the
same application-level concurrency shape as the browser viewer's full-manifest
preload. Do not override k6's per-host transport limit unless a browser run
records a different transport arrangement.

## Live playback proof

The normal Playwright gate uses the committed fixture. To run the same
rendered-frame proof against an already running production build and live
seeded stack, set its existing-server switch and base URL:

```sh
PLAYBACK_LIVE=1 PLAYWRIGHT_BASE_URL="$BASE_URL" npx playwright test e2e/playback-frames.spec.ts --project=product
```
