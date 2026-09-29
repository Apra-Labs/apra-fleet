# Supervisor project-folder resolution and service restart

How the supervisor decides which folder is "the project", and how it fails
when that folder, `git`, `bd`, or the service manager is unusable. The goal is
that every failure is loud, names its real cause, and never reports success
for something that did not happen.

## What counts as a project beads directory

A `.beads` directory is a project's only if it contains `metadata.json`
(`isProjectBeadsDir()` in `beads-identity.mjs`). A bare `.beads` in a home
folder is bd global state, not a project.

Both consumers of this rule use the one predicate:

- `discoverBeadsDir()` (the upward walk from the launch folder), and
- the Projects page's `hasBeadsDbAt()` check in `project-route.mjs`.

Sharing it is the invariant: the walk-up and the Projects page must never
disagree about whether a folder is a project. Known limitation: a bd worktree
`.beads` that holds only a redirect file is skipped by this predicate.

### Backlog with no project

When no project beads directory exists, the backlog endpoint answers
`200 {noProject: true}` (via `hasProject()` and `isNoBeadsDirectoryError()`),
so the UI can render an empty state. Only the specific "no beads directory"
error degrades this way; every other bd failure still returns `500`.

## Launch guards

- `launchGuard` refuses a launch with `409` when the launch cwd is unusable.
- The spawner waits one tick for the child's asynchronous `error` event and
  throws `SPRINT_SPAWN_FAILED` carrying the cause; the API maps it to `500`.
  Node emits spawn errors via `nextTick`, which runs before a `setImmediate`
  fallback, so the one-tick wait reliably observes ENOENT-style failures.

## Missing `git` / `bd`

`probeBeadsIdentity` distinguishes a spawn ENOENT (tool not on PATH) from a
non-zero exit. The ENOENT case records a non-enumerable `probeCauses`, and the
surfaced error names the PATH problem instead of the misleading "git remote
add origin" advice.

## Restart semantics

`restart` (`src/cli/restart.ts`) runs stop and start in strict mode:

- stop re-queries the service afterwards and throws if it is still running;
- start refuses the "already running" no-op;
- the CLI entry catches the error and exits `1`.

Restart guidance depends on an explicit `--managed-service` flag rather than
on inferred environment. The registered service unit passes that flag,
`supervisor.ts` forwards its argv unchanged, and `serve.mjs` parses it.
`install` always re-registers the unit so upgraded installs pick up the flag.
The registered-unit arguments are pinned in three test files; change them
together.

## Local-environment caveat

`tests/sea-http-verify.test.ts` fails locally when the built installer binary
is stale (rebuild with `npm run build:binary`). It is skipped on CI when the
binary is absent, so it is not a product regression.
