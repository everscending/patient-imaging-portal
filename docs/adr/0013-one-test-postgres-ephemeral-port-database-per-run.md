# ADR-0013 — One test Postgres on an ephemeral port, with a database per run

- **Status:** Accepted
- **Date:** 2026-08-14
- **Supersedes:** §9's port-namespaced test container
- **Requirements touched:** CQ-6, CQ-8, PF-7 (and every test that touches a database)

## Context

§9 named the test container `pip-testpg-${TEST_PG_PORT}` and called it
"port-namespaced, so two worktrees never collide". That is only true if each
worktree carries a different `TEST_PG_PORT`, and **nothing assigns one**. Every
worktree inherits the same default, 54310.

So two lanes running in parallel — the ordinary case, since the loop gives each
ticket its own worktree — resolve to the same container name, find it already
running, and share one database. One lane migrates and seeds while the other is
mid-test.

The failure is not loud. It looks like flaky tests, and it appears only under
concurrency, which is exactly the condition the build spends its parallelism on.
The collision is also temporal: whoever boots second wins the reuse, so running
the harness once proves nothing.

## Decision

**One Postgres container for the machine, on a port the operating system
chooses, with a database per test run.**

- The container is `pip-testpg`, started `--publish 0:5432` — Docker asks the OS
  for a free host port. Nothing in the repository picks a port number.
- The harness discovers the port it got (`docker port pip-testpg 5432`) and hands
  it to the client. This is the same rule §9 already states for listening test
  fixtures: **bind port 0, pass the assigned port to the client.**
- Each run creates its own database — `pip_run_<random>` — applies the
  migrations into it, and drops it at the end. Isolation is the database, not
  the container.
- Cluster-global roles are provisioned idempotently and shared by those run
  databases. The harness never drops a role between runs: database-local grants
  in any live run make a cluster-wide drop both invalid and unsafe.
- **`TEST_PG_PORT` becomes an optional pin, not the identity.** Unset (the
  normal case) means an ephemeral port. Set, it publishes on that port instead,
  for the one case that needs it: attaching a database client to look around
  during a single debugging session.
- On startup the harness drops `pip_run_*` databases older than a day, so a
  killed run costs disk rather than correctness.

## Consequences

**Parallel lanes stop sharing state, and so do parallel runs inside one
worktree** — which the derive-a-port-per-worktree alternative would not have
fixed, since two runs in one worktree share both the container and the database.

**Nothing computes a port, so nothing can compute the same one twice**, and no
computed number can already be held by an unrelated process on the machine. The
whole collision class goes away rather than getting a better guess.

**One Postgres process for the machine** instead of one per worktree — less
memory, and the container is reused across runs, so only the first run pays for
a start.

**Two new steps in the harness:** read the port back after starting the
container, and create and drop a database around each run. Both are cheap, and
the second is what makes the isolation real.

**A stray database can survive a hard kill.** The startup sweep bounds it; the
worst case is wasted disk, never a corrupted run.

## Alternatives considered

**Derive `TEST_PG_PORT` per worktree from a hash of its path.** Keeps the current
shape and gives each worktree its own server. Rejected: it still claims a
specific number, so two worktrees can hash to one offset and a computed port can
already be in use — the same failure, made rarer rather than removed. It also
leaves two runs in one worktree colliding.

**A container per run.** The strongest isolation and the simplest to reason
about. Rejected on cost: a container start on every gate invocation, on every
tier that touches a database, in every lane.
