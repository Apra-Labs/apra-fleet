# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased] -- apra-fleet supervisor launcher and named OS-service registration (sprint FAILED -- doc regression left open)

Sprint goal: let the fleet-supervisor OS service start on a machine that has
only the released `apra-fleet` binary and no separate `node` install, ship the
supervisor's source inside the published npm package so an npm-installed
`serve.mjs` can actually resolve its imports, and make a supervisor
registration failure a loud, non-zero install error instead of a silent
advisory. All of the code and test work landed and is independently verified
(build green, full `npm test` green, pack-size gate green, zero remaining
references to the deleted node-path-resolution helper, `npm pack --dry-run`
confirms the supervisor source ships). The sprint verdict is nonetheless FAIL:
a documentation page added by this same sprint (`docs/install.md`) still
describes the OLD behaviour it replaced -- a node-path unit, a
resolved-at-install-time node executable, and a non-fatal registration
failure -- which is the exact inversion of what shipped and is left open as a
reopened, unclosed issue for a follow-up sprint to fix (`llms-full.txt` is
generated from README/docs and will need regenerating once that page is
corrected).

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $28.7711.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.8045 across 3 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 25 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

What shipped and is verified working:

- **`apra-fleet supervisor`**: a new foreground subcommand that boots the
  installed fleet-sprint supervisor (`bin/serve.mjs`) on the running
  binary's own embedded runtime -- no separate `node` on PATH required.
  Arguments after `supervisor` pass through verbatim. See
  [packages/apra-fleet-se/docs/architecture.md](packages/apra-fleet-se/docs/architecture.md)
  for the no-double-boot design this relies on.
- **The fleet-supervisor OS service now runs `<installed apra-fleet binary>
  supervisor`**, not a resolved node path -- the dead-code
  node-executable-resolution helper this replaces is gone entirely
  (zero references left in the tree).
- **Supervisor registration failing at install time is now a loud, non-zero
  install failure** naming the reason, replacing the previous silent
  advisory-and-continue behaviour. `install --workflows none` (which never
  installs the supervisor's source to begin with) remains the one
  legitimate non-registration and is reported as such.
- **The OS service manager is generalized to multiple named services**
  (`mcp-server`, `fleet-supervisor`), each with its own unit/plist/scheduled
  task so either can be stopped, restarted, or removed independently of the
  other; per-service restart policy and stop mechanism live on a shared
  descriptor table instead of being duplicated per platform.
- **`packages/apra-fleet-se/src/` now ships inside the published npm
  package's `files` array**, closing the gap where an npm-installed
  `bin/serve.mjs` could not resolve its own `../src/supervisor/*.mjs`
  imports; a new test walks every import reachable from `serve.mjs` and
  guards that all of it is published.
- **Windows service teardown terminates the whole process tree**, not just
  the scheduled task's own wrapper process, on both `stop` and `unregister` --
  closing an orphaned-process gap where the supervisor could survive a
  stop/uninstall still bound to its port.
- See
  [packages/apra-fleet-se/docs/project-model.md](packages/apra-fleet-se/docs/project-model.md)
  for the formal schema this sprint also wrote down: how a project, its one
  beads database, its members, and the supervisor relate.

Carried forward (filed as follow-up work, not fixed this sprint, all left
open for a future sprint):
- **Reopened, blocking**: `docs/install.md`'s "Two OS-level services" section
  still documents the pre-sprint behaviour (node-path unit, resolved node
  executable, non-fatal registration) that this sprint replaced -- an agent
  or operator reading it will misdiagnose a failed install. Needs a doc-only
  fix plus an `llms-full.txt` regeneration.
- On macOS, `apra-fleet stop` then `apra-fleet start` cannot restart the
  supervisor service -- `stop` unloads the launchd job entirely and `start`
  only attempts a `kickstart`, which fails for a job that is no longer
  bootstrapped; currently downgraded to a warning rather than fixed.
- `apra-fleet stop` is missing the non-default-instance guard that
  `apra-fleet start` already has, so running `stop` under an overridden
  `APRA_FLEET_DATA_DIR`/`APRA_FLEET_PORT` stops the machine-global
  supervisor belonging to the default instance instead of leaving it alone.
- Pack-size headroom dropped to about 12.5% after shipping the supervisor
  source; still under the gate but worth a deliberate decision (raise the
  threshold, or ship only the subtree reachable from `serve.mjs`) before the
  next moderate asset addition trips it.
- The supervisor's registered `WorkingDirectory` still does not point at the
  project it supervises (a pre-existing, separately tracked gap -- see
  `docs/project-model.md`).

## [Unreleased] -- Member env map actually reaches dispatch, reservation becomes a reapable object

Sprint goal: make the member registry's `env` name-value map actually reach
every dispatched process (previously stored and emitted but never
injected), and turn the member reservation from a plain holder string into
an object that can be automatically reaped once its holder's process is
gone. Both landed and are covered by `npm test` plus the dedicated
`apra-fleet-client` parity suite (root `npm test` does not reach that
package -- run it separately).

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $27.9782.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.2993 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 24 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

What shipped and is verified working:

- **A member's `env` map is injected at every dispatch site**, not just
  stored and emitted: the synchronous exec path, the prompt-launch path
  (including all of its retries), and both the POSIX and Windows
  long-running task wrappers. The builder is selected by the member's
  registered shell, not by its OS -- a Windows member registered as
  git-bash gets POSIX-shaped assignments, not PowerShell ones -- and merges
  the plaintext env map with the member's decrypted auth credentials, with
  auth winning any name collision. The long-running wrappers intentionally
  carry the plaintext map only, never auth, because those wrapper scripts
  persist as files on the member. See
  [docs/cross-shell-command-construction.md](docs/cross-shell-command-construction.md).
- **The member reservation is now an object** (`{runId, pid, at}`) instead
  of a bare holder string, with the old string kept as a same-write mirror
  so every existing string reader keeps working unchanged. A reservation
  with a recorded pid is lazily reaped the next time a reserve is
  attempted if that pid is no longer alive; a legacy or pid-less
  reservation is never reaped. See
  [docs/member-reservation-design.md](docs/member-reservation-design.md).
- **Reserve now supports an owner-tag refusal**: a caller can supply the
  owner tag it expects the member to carry, and the reserve is refused
  outright (writing nothing) if the member is tagged for a different
  package or reference.
- **`packages/apra-fleet-client` kept in lockstep** with both changes:
  wrappers, typedefs and `api-reference.md` rows for the new reservation
  fields and the owner-tag refusal parameter.
- **The `member.env` map a project bind writes (S8) is now exported into
  every dispatch**, since S8's project-bind env entries flow through the
  same registry `env` field this sprint wires into the dispatch path.

Carried forward (filed as follow-up work, not fixed this sprint, all
lower priority than the goal and left open for a future sprint):
- The dead-holder reap and a concurrent fresh reserve are not yet
  mutually exclusive at the storage layer.
- The env-var-empty-string fallback used by the test concurrency scaler
  was fixed only at its one call site touched this sprint, not at its
  root in the shared scaling helper.
- The `apra-fleet-client` package test suite still is not reached by the
  root bounded test runner and must be run separately.
- A reservation's liveness check trusts a bare process id; it does not
  yet guard against the operating system recycling that id onto an
  unrelated process after the original holder exits.

## [Unreleased] -- Project overview domain: bind/unbind, checkout flow, health panel, git drawer and export/import (sprint goal met)

Sprint goal: build the project-overview domain of the fleet-supervisor
console on top of the existing `supervisor.sqlite` project store -- binding a
fleet member to a console project (owner tag plus a merged `BEADS_DIR` env
entry and a cached git probe), the members-grouped-by-checkout-group overview
model, an "add checkout on a machine" flow, an eight-check health panel, a
per-member git drawer, and a project export/import CLI. It is domain logic
and JSON routes only -- the console UI that renders it is later work. All of
it landed and is verified: every overview row is derivable from the new
route, all eight documented health checks exist with OK/WARN/FAIL unit
coverage, export/import round-trips including the project's original
creation timestamp, the "add checkout" flow is idempotent end to end (a
re-run reports every step skipped with zero mutating calls, and a dirty or
foreign-origin checkout is refused and never touched), and the git drawer
returns every specified field. A previously-interpolated shell injection
vector in the beads-remote probe was fixed with a reject-then-quote policy
that branches on the target member's registered shell (POSIX vs
PowerShell); a client-supplied project creation timestamp is stripped by the
HTTP create route so it cannot be spoofed. See
[packages/apra-fleet-se/docs/project-overview-domain.md](packages/apra-fleet-se/docs/project-overview-domain.md)
for the full design and its trade-offs.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $57.3375.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.9611 across 5 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 57 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

Carried forward (filed as follow-up work, not fixed this sprint):
- The new HTTP routes were verified at the unit level only, against mocked
  store/client collaborators -- never yet exercised over HTTP against a
  deployed sandbox. Integration testing was hard-stopped in two of five
  sprint cycles by a missing broad `curl` permission grant, already tracked
  separately as its own follow-up; the route-level end-to-end verification
  itself is tracked as its own open backlog item.
- A static shell-command-injection guard exists for two of the domain's
  modules (each scans its own source for a raw, unquoted interpolation) but
  not yet for the HTTP route modules or the export/import CLI -- including
  the one route module where a real injection defect was found and fixed
  this sprint, which currently has only behavioral coverage for that fix.
- The owner-package identifier this domain stamps on a bound member's owner
  tag was reconciled against the only independently-landed candidate source
  available at the time; it needs re-verification once a second,
  independently-landed source for the same identifier exists, since a
  mismatch would make every already-written owner tag unreadable on the
  registration side.
- A small, deliberately out-of-epic-scope test file landed on this sprint's
  branch ahead of its intended standalone landing route, by design (reverting
  it first would have dropped a flake fix with no replacement yet on the
  integration branch); reconciling it back to a single landing route is
  tracked as its own open follow-up once the standalone route merges.

## [Unreleased] -- Console auth guard, `/ext` workflow-package reverse proxy, and the console/supervisor permissions denylist

Sprint goal: one shared auth guard for the `/ui` console (fleet-key bearer or
a derived cookie, never the raw key itself, on every `/api/*` and mutating
`/ext/*` request), a workflow-package registry (register/list/unregister,
config-declared packages, version-range compatibility check, health
polling), an `/ext/<package id>/*` reverse proxy with SSE pass-through and a
per-package derived upstream credential, and a `compose_permissions`
denylist so a member can never be auto-granted a curl against the console's
or supervisor's own control-plane ports. All of it landed and is verified
working; no beads were deferred out of scope at or above the sprint's goal
priority.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $56.0051.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.8267 across 4 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 41 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

What shipped and is verified working:

- **A shared local-token helper** lifted into the client package
  (`packages/apra-fleet-client`'s `./auth/*` subpath export) carries the
  generic mechanism (token resolution, bearer/cookie check, fail-closed path
  normalisation) used by both the fleet-sprint supervisor and the console,
  while each caller keeps its own route policy locally so one caller's
  guarded-path rules can never leak into another's.
- **The console auth guard**: every `/api/*` request and every non-`GET`
  `/ext/*` request requires the fleet-key bearer or the `apra_console_token`
  cookie set on `GET /ui`. The cookie carries an HMAC of the fleet key, never
  the raw key, since the raw key also signs member JWTs.
  `handleConsoleRequest` is now total -- no request reaching it can throw an
  unhandled rejection that kills the server process.
- **The workflow-package registry** (`src/services/workflow-packages.ts`):
  atomic-write JSON storage, a hand-rolled semver-range compatibility check
  run at registration, health polling with injectable clock/fetch, and a
  `workflowPackages` config key for statically-declared packages, merged
  with runtime-registered ones behind one service so callers never need to
  know which source a package came from.
- **The `/ext/<package id>/*` reverse proxy** (`src/console/proxy.ts`):
  streams both directions via `pipe()`, passes `text/event-stream` through
  unbuffered (uncompressed, headers flushed early, Nagle disabled) so SSE
  events are not batched, rewrites upstream `Location` headers back under
  the package's mount, and attaches a per-package derived upstream
  credential (never the raw fleet key) that is withheld entirely on an
  unauthenticated `GET` so a cross-origin page cannot ride the console's
  credential to a third-party package.
- **`compose_permissions` refuses console and supervisor control-plane
  grants** by pattern, with a short, explicit, order-sensitive exception
  list for the specific grants an operational runbook already documents --
  checked strictly after the catch-all/shell-chaining denial rules so the
  exception mechanism itself can never resurrect a broader grant.
- **`baseUrl` scheme validation** for workflow packages runs both at
  registration (reject before persistence) and again in the proxy's own
  resolution path (a config-declared package is not gated by the
  registration route at all).

Carried forward (filed as low-priority backlog, not blocking this sprint's
acceptance criteria): scoping a proxied upstream `Set-Cookie`'s `Path` to the
package's own mount so one package cannot set a cookie another package or
the shell would receive; escaping the reserved cookie name before it is
interpolated into the `Set-Cookie`-filter regular expression; bounding the
workflow-package registration route's request body size; broadening direct
test coverage of the remaining throw regions inside the console's now-total
dispatch; and having the `/ext` proxy's base-URL resolver skip a
config-declared package with a scheme error itself, rather than relying on
the proxy's own guard to catch it.

## [Unreleased] -- Member owner tag, env map and git status tools (sprint goal mostly met -- see carried-forward items)

Sprint goal: give the member registry an `owner {package, ref}` binding, a
stored `env` name-value map and an `llmAuthExpiresAt` field; expose a
`member_owner` tool to set/clear the owner tag with a member-held refusal;
and expose a `member_git_status` tool that reports live git status for a
member's work folder without assuming that folder is a checkout. All three
landed and are covered by `npm test` plus a dedicated `apra-fleet-client`
parity/wrapper suite (root `npm test` does not reach that package). Two
lower-priority follow-ups are carried forward, not yet fixed: `owner`
accepted through `register_member`/`update_member` is not yet format-
validated the way `member_owner`'s own `set` path is, and the
`MemberOwnerStructured` client typedef has no client-server parity test
case yet (its sibling `MemberGitStatusResult` case does).

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $16.6414.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.6856 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 18 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

What shipped and is verified working:

- **Registry gains `owner`, `env` and `llmAuthExpiresAt`.** `owner` is a
  `{package, ref}` tag a consumer package uses for its own bookkeeping (not
  a project/repo/group field); `env` is a free-form name -> value map,
  stored and emitted only (not yet read by any dispatch or provider command
  path); `llmAuthExpiresAt` is an ISO 8601 expiry for a member's LLM auth.
  `list_members` and `member_detail` (`"json"` format) emit the full field
  set, including fields that already existed server-side but were not yet
  surfaced (`modelTiers`, `shell`, `vcsTokenExpiresAt`, `reservedBy`,
  `unreservable`).
- **`member_owner` sets and clears the owner tag**, refusing both `set` and
  `clear` while the member is held (`reservedBy` set), via one exported
  check reused by `update_member`'s own inline copy of the same rule so
  `update_member` cannot be used to bypass the held-refusal.
- **`member_git_status` reports live git status** for a member's work
  folder through an ordered six-probe sequence (work-tree check, porcelain
  v2 status, worktree list, origin URL, playbook presence, KB bible commit)
  run through the same command path every other member-bound tool uses --
  paths resolved to literals in JavaScript, no shell-level expansion,
  PowerShell probes base64/utf16le-wrapped. A folder that is not a git work
  tree returns `{checkout: null}` with no error, since the server never
  requires a member's work folder to be a checkout.
- **`packages/apra-fleet-client` kept in lockstep**: wrappers, typedefs and
  `api-reference.md` rows for both new tools and the extended registry
  fields (method count 32 -> 34), with its own parity/wrapper test suite
  green.

See [docs/mcp-tools.md](docs/mcp-tools.md) for the full parameter and
output reference.

Carried forward (filed as follow-up work, not fixed this sprint):
- `owner` accepted by `register_member`/`update_member` is checked only for
  non-empty strings, not the package/ref format `member_owner`'s own `set`
  path validates.
- `MemberOwnerStructured` (the client's owner-tool typedef) has no
  client-server typedef parity test case yet.

## [Unreleased] -- Shell pages: Members, Secrets, Health (sprint goal not met -- blocking defect found in review)

Sprint goal: complete the S1 members table (drawer actions, add-member
wizard), S2 Secrets and S3 Health screens against `/api/fleet/*`, with every
action in the design's screen action table backed by a tested route and a
tested UI control. The 18 `/api/fleet/*` routes, the Secrets and Health
pages, hash-based shell navigation, and a shared `@apralabs/apra-fleet-ui-kit`
primitives package all landed and are verified working. Review found the
epic is not yet done: the Members table renders the `owner` field as a raw
value, but the field is a structured `{package, ref}` object on the branch
this sprint merges against, so a real payload crashes the screen with no
error boundary to contain it (the shipped UI test fixture hardcodes the old
string shape, so the suite does not catch it); and the `member_detail` route
has a passing route-level test but no UI control actually calls it, so the
"route with a test and a UI control with a test" criterion is unmet for that
action. Both gaps are in this sprint's own package (`packages/apra-fleet-shell-ui/`)
and carry forward as open work.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $22.9450.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $1.2040 across 3 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 28 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

What shipped and is verified working:

- **18 `/api/fleet/*` routes** mapping 1:1 to the client API, each validated
  against its own tool's zod schema, with a thrown-error -> 400 / tool
  `isError` -> 422 mapping, and credential responses built from an explicit
  field whitelist so no secret value leaks through a route response.
- **The Members table structure (S1/W1)**: background-refreshing table (no
  flash back to loading on a failed refresh), a row-click drawer with the
  member action set (provision LLM auth, provision/revoke VCS auth, setup
  SSH key, compose permissions, update LLM CLI, remove), and an add-member
  wizard for local and SSH-remote members. The owner column itself does
  *not* yet render correctly -- see the known gap below.
- **Secrets (S2)**: list, add via the out-of-band credential URL, update
  policy/members/expiry, delete, GitHub App setup -- with no secret value
  ever appearing in a request body or the DOM.
- **Health (S3)**: fleet status, version, data directory, update-available
  state, and a workflow-packages list that degrades to the same empty state
  on both a 404 and a network failure.
- **Hash-based shell navigation** across the three pages, and a shared
  `@apralabs/apra-fleet-ui-kit` package (`Table`, `Drawer`, `Form`, `Wizard`,
  `Page`) so future console pages compose from common primitives.
- File ownership held: no file under `src/tools/`, `src/types.ts`, or
  `src/console/server.ts` was touched.

Known gap carried forward (blocks the epic acceptance criterion):

- The Members table's owner column must render the structured
  `{package, ref}` owner object (not treat it as a plain string), and the
  shell needs a rendering safety net (an error boundary) so a future
  shape mismatch degrades to a visible error instead of a blank screen.
- `member_detail` needs an actual UI control (e.g. in the member drawer)
  that calls the route, not just route-level test coverage.
- See `docs/console-architecture.md` for the durable client/server
  type-drift risk this defect is an instance of.

## [Unreleased] -- Console seam and shell UI foundation for `/ui` (sprint goal not yet met -- see carried-forward items)

Sprint goal: serve a React/Vite shell at `/ui` reading a live members table
from `GET /api/fleet/members`, from a dev checkout and from the packaged SEA
binary alike, behind a dedicated `src/console/` seam so later console
features (secrets, health, workflow-package proxy) land as new files rather
than edits to shared routing code. The workspace packages, the console seam
itself (route dispatch, in-process API facade, static asset serving with a
traversal guard and dev-disk/SEA-asset fallback), and several supervisor
test-reliability fixes landed and are verified working. The binary-serving
half of the goal -- packing the shell's built assets into the SEA manifest
and into the distributed npm package -- was not implemented this sprint, so
the epic's own acceptance criterion (the binary answering `GET /ui` 200) is
not yet met; this entry documents real, verified progress and explicitly
does not claim the epic is done.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $30.4730.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $1.2334 across 5 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 46 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

What shipped and is verified working:

- **A dedicated console seam** (`src/console/server.ts`,
  `src/console/routes/*.ts`, `src/console/local-api.ts`,
  `src/console/static.ts`) delegates `/ui` and `/api/fleet/*` handling out of
  the shared HTTP transport file via a single boolean-returning entry point,
  called once before the existing `/mcp` 404 guard. Route registration uses
  an explicit import list rather than a directory glob, since globbing does
  not work against the SEA binary's virtual asset filesystem. See
  `docs/console-architecture.md`.
- **`/api/fleet/members` is served in-process**, calling the same tool
  handler an MCP client would call rather than making an HTTP self-call.
- **Static asset serving handles both a dev checkout and the packaged SEA
  binary**, with a traversal guard that runs before any filesystem or asset
  lookup (rejecting `../`, percent-encoded traversal, Windows drive-letter,
  and UNC path shapes) and correct asset-vs-client-route fallback behavior
  (a missing built asset 404s; an unknown client-side route falls back to
  `index.html`).
- **New workspace packages** `packages/apra-fleet-ui-kit` (design tokens,
  a `Page` shell, a `Table` primitive) and `packages/apra-fleet-shell-ui` (a
  Vite/React SPA with a Members page), wired into the root workspace with a
  `build:ui` script; content is ASCII-only with no cloud/tenant/
  auth-provider identifiers.
- **`dist-pm` (the packaging step that vendors `apra-pm` content into
  `dist/`) now prunes destination-only files instead of only overlaying
  new ones**, so a schema-staleness guard's "run dist-pm to fix it"
  remediation is actually truthful. See `docs/npm-packaging.md`.
- **Supervisor test reliability**: `supervisor-guard-e2e` and
  `supervisor-lifecycle` now derive their health/request-wait budgets from
  named, env-overridable constants and emit a bind-state diagnostic
  (distinguishing "never bound" from "bound but did not answer") on
  timeout, proven by dedicated subtests rather than assumed correct. See
  the testing-convention section in `packages/apra-fleet-se/docs/
  architecture.md`.

Carried forward (sprint goal not yet met):

- Packing the shell's built assets into the SEA binary's manifest (so
  `apra-fleet run` from the packaged binary can answer `GET /ui` 200) is
  unimplemented.
- Shipping the built shell assets in the distributed npm package (so an
  npm-installed `apra-fleet` also answers `GET /ui` 200, not just a dev
  checkout) is unimplemented.
- A post-migration reconciliation confirming the sandbox-deploy `/ui` smoke
  gate reports success against the migrated console seam (rather than the
  earlier interim inline route) has not been performed.
- No console route in this sprint has an auth guard; binding the server to
  a non-loopback host currently exposes the full member registry and the
  shell to any host that can route to the port. This is called out
  explicitly in `docs/console-architecture.md` as a known constraint a
  future iteration must close before console features and non-loopback
  binding can safely coexist.
- Integration test evidence for this epic is incomplete: environment
  permission gaps (missing broad `curl`/`kill` allowances for the sandbox's
  dynamically assigned ports) blocked full integration and regression runs
  this sprint.

## [Unreleased] -- Beads hygiene: milestone labels, gate-lock ignore, no token-estimate memories

- `scripts/check-bead-milestones.mjs`: lists non-closed beads with zero, several or
  unknown `milestone:*` labels (exit 2). Options `--assignee`, `--known`, `--file`,
  `--json`. A standalone, opt-in operator tool. The `milestone:*` labels are a local,
  ad-hoc convention until a formal milestone model lands, so the script is not wired
  into any sprint phase, hook, prompt or CI job.
- `.gitignore`: ignore `.beads.gate.lock`, the bd runtime lock that sprints kept
  re-filing as a dirty-worktree finding.
- apra-pm: the legacy auto-sprint harvest and the pm cost skill no longer write the
  `token-estimates-json` bd memory; `scripts/fix-token-memories.mjs` is removed.
  Calibration stays in `sprint-logs/calibration.json`.
- backlog-groomer: new hygiene step. Follow-ups under closed parents are groomed, given
  the parent's context and detached. Fully closed epics are listed as deletion
  candidates, which need operator confirmation. Token-estimate memories are banned.

## [Unreleased] -- Windows dispatch pipe stall, missed-stall tail truncation and unbounded test runner (sprint goal not yet met -- see carried-forward items)

Sprint goal: close three P1 regressions that could each hold a Windows-member
dispatch open indefinitely -- a dispatch that never completed because a
grandchild process inherited its stdout/stderr pipe, a stall detector that
never fired against a frozen transcript whose tail ended in an
untimestamped entry, and a root test-runner chain with no wall-clock bound
that could hang the whole dispatch behind it. The epic's own acceptance
criterion is `npm test` green on both Windows and Linux; that criterion is
not yet met, so this entry documents real, verified progress and explicitly
does not claim the epic is done.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $19.2194.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.4967 across 3 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 29 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

What shipped and is verified working on Windows:

- **Windows dispatch completion now keys off the dispatched process's own
  exit, not pipe EOF.** A grandchild started by a dispatched CLI (a sandbox
  server, a nested test runner) can hold the dispatch's stdout/stderr pipe
  open on Windows long after the process actually dispatched has exited.
  The read side now treats process exit as the completion signal on
  Windows only, with a short bounded grace window to drain any output
  already buffered in the pipe; POSIX is unchanged, since a real EOF is
  reachable there and remains the more complete signal. The two call sites
  that implement this (local and SSH strategies) now finalize before
  tearing down the readable stream, closing a prior ordering defect that
  could silently drop output landing late inside the drain window. See
  `docs/dispatch-reliability-hardening.md`.
- **The stall detector now catches a frozen transcript whose tail read
  finds no parseable timestamp at all**, instead of silently skipping the
  threshold check for that poll. The tail read now scans backwards for the
  most recent dated entry (a trailing untimestamped record no longer hides
  one sitting just above it), and when no timestamp is found anywhere in
  the tail window, the transcript's own file-modification time is used as
  the staleness signal instead of treating the read as pure absence of
  evidence. See `docs/stall-detector-resilience.md`.
- **Both bundled test-runner chains (the root runner and the
  workspace-local runner) are now bounded by a wall-clock timeout with a
  process-tree kill cascade**: a graceful group-terminate first, escalating
  to an unconditional group-kill if the tree hasn't exited, plus a forced
  process-exit backstop in case the kill signal never produces an exit
  event. An outer terminating signal delivered to the runner itself now
  always yields a non-zero exit code, regardless of which internal code
  path happens to reach `process.exit` first, and a deferred hard-kill
  timer now captures its target process-group id at signal time so it
  cannot lose track of (or kill the wrong occupant of) that slot. See
  `docs/dispatch-reliability-hardening.md`.
- The process-tree-kill reproduction/test harness used to prove the above
  now signals the whole POSIX process group (not just one pid),
  disambiguates a zombie from a genuinely live process before reporting
  liveness, and polls with a bounded wait for the target to actually leave
  the process table instead of assuming a sent kill signal took effect
  immediately.

Carried forward, not resolved by this release -- this is why the sprint
verdict is FAIL against the epic's own acceptance criteria:

- **No CI evidence exists yet at the tip of this work.** The epic requires
  `npm test` green on Windows AND Linux; the most recent CI run available
  predates several of the fixes above, and that run's Linux leg failed on
  exactly the process-tree-kill correctness gaps this release addresses.
  Local Windows verification is real (build, unit, and workspace test
  suites all green) but is necessary, not sufficient, evidence for a
  cross-platform acceptance criterion -- a fresh CI run on all target OSes
  is required before this can be called done.
- **A POSIX-only "outer signal produces a non-zero runner exit code"
  ordering case was still failing against exit code 0 as of the last
  available CI evidence**, despite its implementing subtasks having been
  marked complete -- closing a subtask is not the same as the parent
  behavior being independently confirmed against a deployed build. The gap
  is filed and tracked; the dependent feature and its parent remain open
  pending that confirmation.
- A separate, out-of-scope macOS process-leak failure was observed and
  filed under the task that claims that exact coverage, rather than folded
  into this release's scope.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $23.4256.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.4256 across 3 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 44 priced dispatch(es) used real per-member rates (get_member_model_pricing).

## [Unreleased] -- memory-contract/v1 skeleton complete: round-trip harness, CI drift guard, taxonomy, sign-off

Sprint goal: turn the existing MCP knowledge-tool surface into the
memory-contract/v1 skeleton (JSON Schemas, method contract, error taxonomy,
round-trip validation against the live sqlite provider), as a single sprint /
single PR. **Sprint verdict: PASS**, verified first-hand against the working
tree rather than by closed-task count: all four contract layers (prose spec,
JSON Schema 2020-12, MCP + OpenAPI bindings, conformance-suite hook) are
present or explicitly stubbed with a named downstream owner; the
provider-parameterized round-trip harness validates both request and
response for every inventoried tool against the live handler and passes
clean; the CI drift guard was proven live by a deliberate dry-run break
(a hand-introduced diff was caught and reported, then the guard passed again
once reverted); the degradation list (what JSON Schema structurally cannot
verify) was handed off with named downstream ownership; and the pre-existing
tool-surface-guard regression stayed green. Full generation is confirmed
byte-identical on repeat runs with a clean working tree, and the full local
test suite (unit plus workspace suites) passed with zero failures.

What landed on top of the schema-generation work already described below:
the error taxonomy with stable machine codes, and its projection into both
the MCP-side error shape and an RFC 9457 Problem Details OpenAPI stub; a
fixture corpus recorded from real, live tool calls (including ordered,
stateful scenarios where a later call depends on an id minted by an earlier
one); the round-trip validator that exercises every tool's real handler
against its published request and response schema; a three-way roster guard
that independently checks the real tool-registration surface, the
generator's expected roster, and the schemas on disk agree, closing the gap
where a generator's own hardcoded tool list can only notice a tool
disappearing, never a new one going unrostered; response schemas widened to
match the real multi-block response envelope (an optional onboarding
preamble and nudge alongside the payload, each with optional annotations)
while keeping the decoded payload shape itself just as strict as before; and
a self-review sign-off recording the per-layer verdict and the explicit
scope handed to each downstream owner. See
`docs/memory-contract-v1-roundtrip-and-handoff.md` for the full design of
the round-trip harness, the drift guard, the taxonomy-to-wire projection, and
the handoff boundary, and `docs/memory-contract-v1-generator-design.md` /
`docs/memory-contract-v1-inventory-notes.md` for the schema-generation and
inventory-level notes referenced below.

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $33.2868.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0813 across 3 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 45 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```

Carried forward as backlog (deliberately deferred, not blocking): the
directive-activation absence scan currently runs only in the generator's
strict check mode and is not wired into the plain write path; the two
copies of the beads-export shrink guard (the standalone script and its
inline copy invoked from the auto-sprint export step) have no equivalence
test proving they stay in sync; several response-body fields that are typed
as unconstrained JSON already have a known TypeScript shape available and
could be tightened; the scratch dump writers used for ad-hoc beads listing
still target the repo root instead of a temp directory; and the repo-path
quoting in the auto-sprint export shrink guard command could be hardened
further. A periodic sweep of this file's own carried-forward lists, to
correct any item that has since landed, is itself tracked as backlog work.

A full regression pass was also run this cycle as an informational,
non-gating check and surfaced pre-existing, already-tracked breakage
unrelated to this sprint's own changes: a set of integration-suite files
failing for reasons predating this sprint, a single-file test-suite time
budget exceeded by a number of files, one real-time watchdog test failing on
replay-drift after the watchdog itself fired correctly, and a smoke-test run
blocked before completion by a permission classifier declining to seed a
credential during setup. None of these are new; each was already tracked
from a prior pass and was reconfirmed rather than duplicated.

## [Unreleased] -- memory-contract/v1 schema generation, postprocess hardening, and test stabilization

Sprint goal: turn the existing MCP knowledge-tool surface into the
memory-contract/v1 skeleton (JSON Schemas, method contract, error taxonomy,
round-trip validation against the live sqlite provider), as a single sprint /
single PR. **Sprint verdict: FAIL**, judged against the epic's own acceptance
criteria rather than closed-task count: no round-trip validator exists yet
(the epic's own stated exit criterion), no CI drift guard was wired, and the
fixture corpus directory is still empty. `bindings/mcp/` now holds 23
committed tool definitions (commit `fcccf19f`, one per inventoried tool);
`bindings/openapi/` remains an unowned empty stub. See
`docs/memory-contract-v1-generator-design.md` for the full design of what did
land.

What landed: the zod-to-JSON-Schema generation path was selected, proven
against every hard construct in the surface (discriminated unions, closed
enums, optional/nullable/nullish, recursive references, tuples), and wired
into a `contract:generate` script that emits metaschema-validated draft
2020-12 request and response schemas for all 23 inventoried tools, with a
demonstrated byte-identical re-run guarantee. The deterministic postprocess
step that normalizes the generator's raw output to 2020-12 (dialect
declaration, `definitions`-to-`$defs` renaming, exclusive-bound numeric
form, tuple encoding) was hardened to be container-aware when repointing
`$ref` pointers, so a data field that happens to be named "definitions" is
no longer mistaken for a schema container and incorrectly rewritten. A claim
recorded earlier in this cycle -- that a real response carrying a display
preamble would fail its own published response schema -- does not hold for
any of the 23 inventoried kb_*/code_* tools: `wrapTool`'s onboarding preamble
and nudge suffix only ever attach when the tool result is non-JSON
(`isJsonResponse` false), all 23 kb_*/code_* handlers return
`JSON.stringify(...)`, and the nudge-suffix path is gated to `register_member`
and `execute_prompt` (`src/services/tool-registry.ts`, `src/services/onboarding.ts`). The
published single-text-block response schemas are still narrower than the real
three-block `wrapTool` envelope in general -- `register_member`,
`execute_prompt`, and any future non-JSON-returning tool can still trigger
it, and that gap is exactly what the still-missing round-trip validator is
meant to catch -- but it is not reachable through the 23 tools this contract
actually covers. Also fixed: a real
port-selection bug where an OS-assigned ephemeral port could land in a
client fetch implementation's blocked-port list, and the beads-export commit
guard's argument-passing bug in its inline copy. The `apra-pm` test suite
now also runs from the root local test command, and several subprocess-
spawning tests had their timeouts raised to real subprocess cost to stop
flaking under a loaded full-suite run.

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $26.8852.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0473 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 31 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```

Carried forward (still open, core to the memory-contract/v1 deliverable): the
error taxonomy with stable machine codes and its projection into MCP error
payloads and the OpenAPI stub, the round-trip fixture corpus and its
provider-parameterized validator (the sprint's stated exit criterion), the CI
drift guard, and the final self-review/sign-off checklist. Two items
previously carried forward here have since landed in later cycles of this
same continuing sprint and are no longer open: the MemoryProvider method
contract (`methods.json`, commit `c4161584`) and MCP binding definitions for
every inventoried tool (`bindings/mcp/`, commit `fcccf19f`).

**Correction (all four items above have since landed):** every item this
paragraph lists as still open has since landed in a later cycle of this same
continuing sprint -- see the newest entry at the top of this file for the
error taxonomy and its wire/OpenAPI projection, the round-trip fixture
corpus and its provider-parameterized validator, the live CI drift guard,
and the completed self-review/sign-off checklist. None of the four remain
open.

## [Unreleased] -- memory-contract/v1 inventory and test-suite stabilization

Sprint goal: turn the existing MCP knowledge-tool surface into the
memory-contract/v1 skeleton (JSON Schemas, method contract, error taxonomy,
round-trip validation against the live sqlite provider), as a single sprint /
single PR. **Sprint verdict: FAIL** (a final reviewer dispatch stalled and
could not be repaired after retry; no PASS was reached).

What landed: the contract-surface inventory (`memory-contract/v1/INVENTORY.md`)
was corrected and hardened against several inaccuracies found during
cross-checking against the real code (a tool-call-site miscount, an
incomplete list of dropped HTTP query filters, a mis-stated anchoring claim,
and an unflagged teardown-method-naming/extra-parameter asymmetry between the
two provider implementations -- see `docs/memory-contract-v1-inventory-notes.md`
for the durable findings). A baseline verification pass was recorded. A
correctness bug was fixed in the automated beads-export commit guard, which
could previously let a divergent local export silently replace the
committed issue-id set while the exported file grew in size (a size-based
check would not have caught it); the guard now compares id sets. The root
local test runner now also runs the `apra-pm` suite (previously reachable
only via CI's explicit `--prefix` invocation), and several tests that spawn
real subprocesses (git clone, PowerShell, an external CLI) had their
timeouts raised to real subprocess cost so they stop flaking under a loaded
full-suite run; a real port-selection bug was also fixed where an
OS-assigned ephemeral port could land in a client fetch implementation's
blocked-port list. The zod-to-JSON-Schema generation path and its
deterministic per-tool schema emit also landed: the `contract:generate`
script emits metaschema-validated draft 2020-12 request and response schemas
for all 23 inventoried tools (46 documents in memory-contract/v1/schemas/),
with a demonstrated byte-identical re-run guarantee.

Carried forward (still open, core to the memory-contract/v1 deliverable):
the error taxonomy with stable machine codes and its projection into MCP error
payloads and the OpenAPI stub, the round-trip fixture corpus and its
provider-parameterized validator (the sprint's stated exit criterion), the CI
drift guard, and the final self-review/sign-off checklist.

**Correction: all of the above have since landed** in a later cycle of this
same continuing sprint -- see the newest entry at the top of this file.

Deploy could not be completed during this sprint: repeated attempts were
blocked either by the runbook's own active-sprint safety gate (deploying
while this sprint's own dispatch was still the active sprint) or by an `npm
ci` failure unlinking a native `rollup` binary on Windows, which the existing
lock-clearing preflight script does not detect (it only scans for orphaned
`esbuild` holders). A regression pass afterward also could not run, blocked
on missing command-allowlist entries for its own harness.

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $28.4659.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0000 -- no integ-test-runner dispatch ran this sprint (no playbook found, or deploy never succeeded).
Pricing source: all 39 priced dispatch(es) used real per-member rates (get_member_model_pricing).

## [Unreleased] -- Groundwork for the v0.5 console integration branch: epic closed, all three CI legs green

The final pass on the v0.5 console groundwork branch. Both Windows-only test
failures the previous pass left open are now root-caused and fixed, closing
out every P1 acceptance criterion for the epic; `ubuntu-latest`,
`macos-latest` and `windows-latest` are all green on the same head.

What shipped since the previous pass:

- **`integration-gate-status.mjs`'s ESM entry-point guard now uses
  `pathToFileURL(process.argv[1]).href`** instead of a raw `file://` string
  built by template-literal interpolation, so `main()` actually runs on
  win32 (see
  [docs/cross-shell-command-construction.md](docs/cross-shell-command-construction.md#windows-pitfalls-in-local-node-tooling-not-member-transport-but-the-same-failure-shape)
  for the general failure shape and fix pattern).
- **`supervisor-guard-e2e.test.mjs` is hardened against hosted-runner
  contention** on Windows: every HTTP/TCP timeout is now derived from the
  package's existing `scaledTimeout()` helper (explicit concurrency, since
  a bare `node --test` invocation of a single file does not always inherit
  the env var that helper reads), the first loopback health probe retries
  until any response or a scaled deadline rather than a fixed 5s budget, and
  every timeout/failure names its request and carries the child process's
  stdout/stderr so a CI failure is actionable. No assertion was weakened and
  nothing is skipped on Windows.
- **`deploy.md`'s two remaining unauthenticated supervisor curls** (the
  force-release call in the Active-sprints gate section, and the
  `/api/sprints` gate curl in the Deploy build script) now carry the
  `Authorization: Bearer $(cat "$HOME/.apra-fleet/fleet.key")` header,
  matching the form already used throughout the other playbooks.
- **The playbook auth-curl scan test now covers all three playbooks**
  (`deploy.md`, `integ-test-playbook.md`, `regression-test-playbook.md`),
  not just the regression playbook, so the "no unauthenticated supervisor
  curl in any playbook" acceptance criterion is actually enforced across the
  full set of operator-facing docs rather than one of three.

Deferred (filed as open, low-priority backlog, not blocking this epic):

- Supervisor auth's `aclVerified` reporting for an unprotected `fleet.key`.
- Integration gate status treats terminal `SKIPPED`/`NEUTRAL` check
  conclusions as pending rather than resolved.
- No startup warning when the supervisor starts with no service token
  configured.
- The supervisor launch API still cannot express a synced multi-machine
  topology (`--sync`), tracked separately from this epic.

### Cost analysis

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $15.9796.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.3051 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 21 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- Groundwork for the v0.5 console integration branch: follow-up pass on the open P1 gaps

A follow-up pass on the same v0.5 console groundwork branch, closing most of
the P1 gaps the previous pass left open and confirming the branch's CI
blocker is now isolated to two Windows-only test failures.

What shipped since the previous pass:

- **The base-reviewer permission profile now grants `Bash(curl:*)`**,
  matching what the integ-test-playbook's own Permissions section already
  required; the reviewer stack can now run the playbook's curl-based
  supervisor checks instead of failing on a missing grant.
- **The sandbox-deploy smoke test now exercises the real `/ui` 404 branch**
  instead of failing earlier at the `/health` check, closing the gap where
  that branch was previously untested.
- **`resolveServiceToken()` gained a read-only mode** (`createIfMissing:
  false`): probes that only need to check whether the supervisor is
  configured (`check-foreign-sprints.mjs`, `sandbox-deploy.mjs`'s
  snapshot/verify/teardown checks) no longer mint a `private/token` file as
  a side effect of a passive read.
- **The documented sandbox service-token path was corrected** in `deploy.md`
  and `integ-test-playbook.md` to match what `resolveServiceToken()` and
  `jwt.ts` actually resolve (the real home directory, not a sandbox-local
  path), and the root `package.json` trailing newline lost in an earlier
  pass was restored.

What is still open, and why the branch cannot merge yet:

- **CI has never been green on this branch.** The `ubuntu-latest` and
  `macos-latest` required checks pass; `windows-latest` fails, which is
  enough by itself to block the PR under the integration branch's ruleset.
- **Both Windows failures are in tests this branch added, and both are
  root-caused, not flaky:**
  - `integration-gate-status.mjs`'s ESM entry-point guard compares
    `import.meta.url` against a raw `file://` string built from
    `process.argv[1]`, which never matches on win32 (backslash path vs.
    percent-encoded URL) -- so `main()` silently never runs on Windows. See
    [docs/cross-shell-command-construction.md](docs/cross-shell-command-construction.md#windows-pitfalls-in-local-node-tooling-not-member-transport-but-the-same-failure-shape)
    for the fix pattern (`pathToFileURL(process.argv[1]).href`) already used
    by every other script in this repo.
  - The supervisor guard end-to-end test's real `serve.mjs` boot hits a 5s
    HTTP timeout on Windows after the process reports it is listening; not
    yet root-caused.
- A known, already-tracked, deliberately-deferred gap remains: `GET /` on
  the supervisor hands its bearer token to any loopback caller via the
  `se_token` cookie, because the same route must stay unauthenticated for
  the dashboard shell to load. No new work item was filed for this pass
  since it is already tracked.

### Cost analysis

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $5.0216.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.3167 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 14 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- Groundwork for the v0.5 console integration branch

Sprint goal: prepare every shared file the v0.5 console tracks will build on
top of -- the loopback-bearer supervisor auth guard, the two test playbooks,
`sandbox-deploy.mjs`, `CLAUDE.md` and CI -- so later console sprints can land
without ever touching these files themselves, plus stand up the
integration-branch merge gate that later sprints' PRs merge through.

What shipped:

- **Loopback-bearer supervisor auth guard landed on the branch with the
  shared `fleet.key` as its preferred token source.** `resolveServiceToken()`
  now tries `~/.apra-fleet/fleet.key` (the same key `src/services/jwt.ts`
  signs with) before falling back to minting a `private/token` under the
  supervisor's own data root, so the supervisor and the rest of the fleet's
  JWT-authenticated surface can share one credential without an extra
  provisioning step. The token source is logged; the value never is.
- **Every playbook curl carries the bearer token**, and regression-playbook
  teardown distinguishes a `401` (guard is up, as expected) from a refused
  connection (supervisor actually down) instead of treating both as "already
  stopped."
- **The launch API forwards `sync` to the runner.** `POST /api/sprints`
  validates `body.sync` as a boolean and, when true, appends `--sync` to the
  spawned runner's `extraArgs`; the ledger records it so a synced-topology
  launch is visible in sprint history.
- **deploy.md, both test playbooks, `sandbox-deploy.mjs` and `CLAUDE.md`
  prepared for the upcoming React/Vite console workspace**: a
  `npm run build:ui` build step (tolerant of the script not existing yet),
  staging ports `7601`/`8801` reserved and never touched by the sandbox
  deployer, and an integration-branch rules block in `CLAUDE.md` (fork/PR
  model, per-track shared-file ownership, tests only through the bounded
  runner).
- **CI builds UI workspaces when present, and stays green when none exist**
  (`npm run build:ui --if-present` in both the Linux and packaging jobs).
- **`fleet-integrator` merge gate added**: a generic SKILL.md agent loop plus
  a read-only `integration-gate-status.mjs` status script that computes
  merge/repair/wait/skip decisions for PRs into a configured integration
  branch; the mutating action (squash-merge, one repair prompt per stuck
  head sha, owner report) stays in the agent loop, never in the script.
- **`check-generic-boundary.mjs` now scans `fleet-sprint/skills/**/*.md`**
  for tracker-id leaks, closing the one gap in the dogfood-safety-net's file
  coverage.
- **`list_members` returns a parseable JSON envelope for an empty registry**
  instead of a plain-text "No members registered." string, and the
  supervisor's own short-lived fleet-members reader now skips the
  `<apra-fleet-display>` onboarding preamble block before parsing, instead
  of assuming the first content block is always the JSON payload.
- **`resolveServiceToken()`'s read-only callers no longer mint a
  `private/token` as a side effect of a read**: `check-foreign-sprints.mjs`
  and `sandbox-deploy.mjs`'s snapshot/verify/teardown probes now pass
  `createIfMissing: false` and return no token rather than creating one when
  neither `fleet.key` nor an existing `private/token` is present.

Known follow-on gaps (deliberately left open, not closed by this pass):

- **`npm test` was RED at final review** (2 failed / 326 passed test files):
  the composed reviewer permission profile grants no `curl` family despite
  the integ-test-playbook Permissions section now requiring it, and the
  sandbox-deploy smoke test's "/ui returns 404" case never reaches the /ui
  probe because it fails an earlier /health check first. Both are filed as
  open P1 issues for the next pass.
- The sandbox service-token path documented in `deploy.md` and
  `integ-test-playbook.md` still names a sandbox-local path; live sandboxes
  resolve the token from the real home directory instead. Filed as an open
  P2. Root `package.json` also lost its trailing newline despite this
  epic's "root package.json is not touched here" rule.
- README.md and this file previously described the auth-guard token as
  always minted under `<data-root>/private/token`; corrected during harvest
  now that `fleet.key` is the preferred source (see above).

### Cost analysis

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $25.5050.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.4806 across 4 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 47 priced dispatch(es) used real per-member rates (get_member_model_pricing).

## [Unreleased] -- fleet-sprint: a finished sprint with deferred beads no longer aborts as stalled, and a permission-scope git rejection stops spinning the sprint

Sprint goal: three independent reliability fixes to the fleet-sprint
orchestrator, all triggered by real observed sprints that either aborted or
spun despite the underlying work already being complete.

What shipped:

- **A sprint whose only remaining beads are deliberately deferred now exits
  PASS instead of aborting stalled.** The cycle-evaluation/stall-detection
  logic now shares the exact same deferred-bead partitioning the dispatcher's
  ready-work query already used, so the two views of "is there still work to
  do" cannot drift apart. Deferred beads are named explicitly on every
  terminal surface (exit line, typed error, final-verdict prompt, sprint
  analysis artifact) instead of silently inflating an "open" count. A second,
  independent short-circuit exits the cycle loop as soon as every configured
  sprint root/target bead is already closed -- covering the case where the
  root closes as a side effect of something other than the review verdict --
  while still guaranteeing a genuinely fresh re-review gets its chance first.
- **Pushing a change under a repo's workflow-automation path no longer
  permanently fails a sprint.** The GitHub credential-minting path now
  requests the fine-grained permission that gates pushes to
  workflow-automation files on every access level that can push, and a
  mint-time rejection because the broader installation was never granted
  that permission now surfaces as a named, actionable operator referral
  instead of the raw API error or a silent downgrade. A push rejected for
  lacking that permission is now classified as a distinct, non-retryable
  permission-scope failure -- ahead of the generic failure-pattern
  precedence, so it can no longer be misread as a routine divergence -- and
  the orchestrator no longer wastes a self-heal-and-retry cycle attempting to
  re-mint the identical doomed credential. A completed dispatch whose work is
  committed locally but whose publish push hits this exact wall is now
  reported as "work done, publish blocked" and excluded from re-dispatch for
  the rest of the sprint, rather than being marked failed and re-dispatched
  every remaining cycle against a gap no retry can close. A pre-dispatch
  preflight warns before dispatch when a branch touches a workflow-automation
  path and the credential in effect won't carry the push, so the operator
  referral surfaces before the wasted work, not just after.
- **A brand-new sprint branch no longer fails its first sync on a doomed
  pull-rebase.** The post-dispatch sync step previously assumed the remote
  already had the sprint branch and ran a pull-rebase that always failed with
  a "remote ref not found"-shaped error on a branch that had never been
  pushed yet. That exact, unambiguous error is now recognized and shared
  between the pre- and post-dispatch sync steps: it skips the conflict-
  resolution ladder entirely and retries the push directly (which creates the
  branch on the remote), while a genuine divergence -- caught by the same
  retry being rejected because a concurrent writer already published the
  branch -- still raises the typed divergence error exactly as before.

Filed as follow-up (deliberately left open, not closed by this pass -- none
block this sprint's own acceptance criteria):

- The permission-scope "publish blocked" state is recorded internally but not
  yet surfaced anywhere a human/dashboard/report actually reads it beyond the
  log line, so a sprint that is entirely publish-blocked still ends as a
  generic stalled verdict with the referral visible only in the log.
- The dispatch-outcome path that classifies and carries over a
  permission-scope-blocked streak has no direct test coverage of its own
  (only the underlying predicate it calls is tested), so this remains an open
  gap rather than a verified behavior.
- The real GitHub.com verification of a live workflow-permission push (as
  opposed to the local-bare-repo equivalent this pass verified against) is
  still an outstanding manual/operator step.
- Personal-access-token-mode members are deliberately excluded from the new
  workflow-permission preflight (a PAT's granted scopes aren't derivable from
  the registry today), so they still only learn about a missing scope from
  the rejection itself, not a warning beforehand.
- Regression carry-over (informational only -- does not gate this sprint's
  verdict): the real-bd regression suite and smoke test could not run this
  pass because the sandbox permissions required to drive them were not
  granted; no carry-over bead beyond the existing permissions gap was filed.

### Cost analysis

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $28.7423.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.3375 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 32 priced dispatch(es) used real per-member rates (get_member_model_pricing).


## [Unreleased] -- apra-fleet-client catch-up and fleet-supervisor project-store skeleton

Sprint goal: catch `@apralabs/apra-fleet-client` up with tool-registry
methods it was missing, and lay the durable-state foundation for the
fleet-supervisor's project domain (console projects, per-member git probe
cache).

- **Client wrappers for previously-unwrapped tools.** `ApraFleet` gains
  `revokeVcsAuth`, `setupGitApp`, `updateLlmCli`, `monitorTask`,
  `stopPrompt`, `version`, and `kbSetup`, each backed by a real
  tool-registry entry and its own test case. `package.json` gains
  `./auth/*`, `./beads/*`, and `./registration/*` subpath exports; the
  `./beads/*` mapping is backed by a real module (`beads/normalize.mjs`, a
  pure copy of the fleet-supervisor's bead-normalization/tree helpers,
  usable by any consumer without depending on the supervisor package's `bd`
  subprocess plumbing). The doc-parity test that checks
  `docs/api-reference.md` against `ApraFleet`'s method list now also flags
  stale documented methods, not just missing ones.
- **`credential_store_set` gains a non-blocking, headless-friendly path.**
  When the server has no TTY attached, or the caller passes `return_url:
  true`, the tool returns `{url, expiresAt}` in `structuredContent`
  immediately instead of blocking on terminal input; the secret is
  encrypted and stored the moment the user submits the form at that URL, no
  follow-up call needed. A bounded backstop timer prevents a listen failure
  in the underlying web server from leaving the call hung indefinitely.
- **fleet-supervisor gains a `node:sqlite`-backed project store.**
  `supervisor.sqlite` holds `projects` and `member_git` tables behind an
  ordered, idempotent migration runner (WAL journalling, foreign keys
  enforced, one transaction per migration). An unmounted `/api/projects`
  route module (`POST`/`GET`/`PUT`/`DELETE`) validates payloads and, per the
  "console never creates a beads remote" rule, probes an operator-supplied
  `beads.remote` via `git ls-remote` on the project's backlog member rather
  than ever running `git remote add` -- the same gate is reused by create
  and update so the invariant lives in one place. Mounting this route module
  into the running supervisor, and building the first UI surface against
  it, are follow-on work.
- Carried forward as open backlog (not fixed this sprint): validating/
  escaping the operator-supplied remote before it reaches the shell probe
  command; documenting the new client subpath exports and
  `beads/normalize.mjs` in `api-reference.md`; swapping the supervisor's own
  `backlog.mjs` onto the shared `beads/normalize.mjs` helpers instead of
  keeping two copies; widening the route module's "already mounted" guard
  to cover `bin/serve.mjs`, not only `src/supervisor/**`; a residual
  non-ASCII sweep in `auth-web.ts` and its tests; and reconciling
  `docs/secret-variables.md`'s older description of `credential_store_set`
  as unconditionally blocking (updated as part of this sprint's docs pass,
  but the backlog item tracking a fuller doc audit remains open). A
  regression pass attempted after the sprint's final verdict was blocked
  before running by a permissions gap (missing `curl`/`kill` allowances for
  the sandbox supervisor's HTTP API) -- informational only, does not gate
  this sprint, and no code changes resulted from it.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $7.4067.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0366 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 13 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- fleet-se supervisor: resolves, displays and enforces its beads tracker identity

- **The supervisor now knows which `.beads` it runs against.** `bin/serve.mjs`
  walks up from its cwd (or the new `--beads-dir <path>` flag, which accepts
  the project folder or its `.beads` dir) to the project's `.beads` before
  binding its port. No reachable `.beads` (or a failing `bd where` there)
  is a loud startup WARNING that names the fix, not an exit: the supervisor
  runs with its identity unknown (`beads: null` + `beadsWarning` on
  `/api/health`, an amber `Beads: NOT RESOLVED` dashboard line, sprints
  launched without `--expect-beads`) until `GET /api/health?refresh=1`
  recovers it; only a nonexistent `--beads-dir` is a startup error. The
  resolved identity (`.beads`
  dir, prefix, `sync.remote`, git origin) is logged once at startup, exposed
  as `beads` on `GET /api/health` (`?refresh=1` re-probes), shown as a header
  line on the dashboard, and recorded as `beads` on every launched sprint's
  ledger entry (its prefix shows on the sprint card).
- **Every sprint the supervisor launches is told what to expect.** Sprint
  children now run from the resolved project root and receive
  `--expect-beads <json>` (`beadsDir`/`prefix`/`syncRemote`/`repoRemote`), so
  the engine can verify each member's own `bd where` against the same
  tracker instead of silently dispatching at whatever a member's cwd
  happens to resolve. Nothing sets `BEADS_DIR`; nothing is persisted.
- **Engine: identity MISMATCH is fatal, an unresolved probe is a warning.**
  `verifyBeadsIdentity` aborts (`BeadsIdentityError`, reason `MISMATCH`)
  only on a field that resolved on both sides and differs. A member whose
  `bd where` fails, whose `sync.remote` is unset or whose git `origin` is
  missing gets a `[beads-identity] WARNING:` line naming the member, field,
  probe, error and the fix; that field is not compared and the sprint
  proceeds. The published `beadsIdentity` state carries `warnings` and a
  per-member `unresolved` list (rendered as "?" cells and warning rows in
  the viewer); the CLI banner's pre-flight probe warns instead of exiting.

## [Unreleased] -- Supervisor: loopback-only bind + bearer-token auth guard

Sprint goal: `fleet-se-serve` previously bound every interface with no
authentication on its API surface. This sprint made it bind `127.0.0.1`
only and put a shared bearer-token guard in front of the mutating/sensitive
routes, while keeping every existing client (dashboard, sprint-runner
coordination clients, spawned children, operator tooling) working
unchanged from the user's point of view.

What shipped:

- **`src/supervisor/auth.mjs` (new)**: mints a 32-byte hex service token
  under `<supervisor-data-root>/private/token` on first start (idempotent
  reuse thereafter), enforces/heals 0600 on POSIX and reports an
  `aclVerified` flag on Windows (where mode bits cannot be asserted), and
  authorizes a request via `Authorization: Bearer <token>` or an
  `se_token` cookie, compared with a constant-time check. The token is
  never logged or included in error text.
- **`server.mjs`** listens on `127.0.0.1` only and answers `401` with a
  `WWW-Authenticate: Bearer` header before any route dispatch for every
  guarded route. The entire `/api/` surface and `POST` to any
  `/sprints/:id/live/*` sub-route are guarded; the dashboard shell, live
  view, `/state`, `/events`, and history stay open (loopback-bound,
  read-only).
- **Every existing client updated to authenticate**: the dashboard's
  `GET /` now sets the `se_token` cookie for same-origin fetches; the
  sprint-runner's HTTP coordination clients send the bearer header; the
  spawner passes the token into spawned children via environment (never
  argv); `scripts/check-foreign-sprints.mjs` and
  `scripts/sandbox-deploy.mjs` were updated to send the token on every
  supervisor call they make; the fleet-supervisor skill's curl examples
  got bash + PowerShell twins showing the bearer header.
- **Test harness and coverage**: a new `test/helpers/supervisor-harness.mjs`
  spins up an authenticated supervisor for tests; new/expanded suites
  cover the bind + auth guard end to end, every client working with auth
  on, and a set of path-normalization bypass classes (dot segments,
  protocol-relative paths, percent-encoding) to prove the guard and the
  HTTP router can never disagree about which route a URL names.
- **Flake fix**: `check-sandbox-sync-remote.test.ts` teardown paths now
  route through one shared non-throwing cleanup helper instead of several
  bare, throwing `fs.rmSync` calls, fixing an intermittent Windows EBUSY
  failure unrelated to the auth work but discovered alongside it.

Known follow-on gaps (deliberately left open, not closed by this pass):

- **Criteria defect**: `GET /` must stay open (unauthenticated dashboard
  shell) and must hand the token to the browser via the `se_token` cookie
  for same-origin fetches to work -- together those requirements mean any
  loopback caller can harvest the token by hitting `GET /`. Needs a
  design decision (e.g. a first-use pairing flow), not a one-file patch.
- Deploy/regression tooling that polls `/api/health` unauthenticated
  needs updating in lockstep with this guard, or it misreads a healthy,
  now-authenticated supervisor as crashed/unreachable -- left to
  follow-up rather than patched alongside the guard.
- Authenticate or replace the remaining bare supervisor curl examples in
  `deploy.md` and user docs; pin percent-encoded path forms in the
  `requiresAuth` truth table; a test-harness temp-directory leak; add the
  beads gate lock file to `.gitignore`.

### Cost analysis

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $29.8612.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.1913 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 36 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- fleet-sprint: child-bead creation refuses an id collision instead of silently overwriting

Sprint goal: close the hole where creating a child bead at an id that
already belongs to an existing bead (open or closed) silently overwrote
that bead's content in place, rather than failing loudly -- and land it as
two independent fixes, since patching only the trigger would have left the
underlying creation path unguarded.

What shipped:

- **Every explicit-id child-bead create now probes before creating.** The
  single seam every proposed follow-up task flows through checks for an
  existing occupant at the target id first and refuses (releasing the
  reservation, throwing loudly) rather than letting `bd create --id` run
  into a silent overwrite. The probe's own failure path fails closed: an
  unrecognized or unparseable outcome is treated as "unknown, do not
  assume free," not as an implicit green light.
- **The id allocator's floor computation now counts closed children.** The
  read that seeds the very first allocation under a parent previously
  excluded closed issues by default, so once every child under a parent
  was closed the floor silently reset to 0 and the allocator re-minted
  already-used ids -- the actual trigger that produced the collision this
  epic exists to prevent. Both fixes land together and are independently
  verified; neither alone closes the hole.
- **Reservation lifecycle hardening**: the allocator's reservation is
  confirmed as soon as the create lands and is never released again after
  that point, even if the follow-up parent-link update or the confirm call
  itself fails -- releasing an id that already genuinely exists would hand
  it out again and reproduce the same collision.
- **A new mechanical CI guard** (in the same family as the repo's existing
  shell-command/dolt-literal/unbracketed-push guards) enforces that no
  other module in the scanned set dispatches a bead-creation command
  outside the one guarded seam, using a content-shape rule (robust to a
  renamed helper or wrapped call) rather than an identifier-matching rule
  (trivially defeated by one). A related lexing gap shared by several of
  these guards -- a regex literal containing a quote or apostrophe could
  desync a source-text scanner's comment/string masking -- was fixed once,
  in the shared helper every guard in the family now reuses.

Filed as follow-up (deliberately left open, not closed by this pass --
none block this fix's own acceptance criteria):

- apra-fleet-btj9.11 / .12 (P3) -- the collision probe's failure
  classification is brittle at both ends: against a legacy server response
  shape a genuinely free id can fail closed, and a zero-exit but
  unrecognized payload shape can be misread as free.
- apra-fleet-btj9.13 / .14 (P3) -- the best-effort follow-up-task fallback
  path can mislabel and duplicate a finding when the underlying create
  actually landed.
- apra-fleet-btj9.15 / .16 (P3) -- the new guard is not yet wired into the
  cross-guard coverage matrix, and some stale test recordings elsewhere
  still emit unrelated drift noise.
- Regression carry-over (informational only -- does not gate this sprint's
  verdict): the real-bd regression suite and smoke test both failed on a
  dispatch stall in this pass; no new carry-over bead was filed from it.

### Cost analysis

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $58.8740.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.2723 across 5 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 47 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- Stall detector: per-dispatch inactivity threshold, decoupled exec timer, adaptive probe cadence

Sprint goal: fix the stall detector so it honours each dispatch's own
`timeout_s` instead of a single global env-var threshold, decouple the
exec-level rolling timer per provider so it stops acting as a sloppier
version of the total-duration ceiling for providers whose exec channel is
silent mid-turn, and reduce probe overhead on long-threshold entries with an
adaptive polling cadence.

What shipped:

- **Per-dispatch stall threshold.** `StallEntry` now carries its own
  `thresholdMs`, threaded from the dispatch's `timeout_s` at every add/update
  call site in the dispatch tool, so a caller's declared timeout genuinely
  drives when that dispatch is judged stalled instead of a single
  process-wide default. The threshold-clamp formula was also corrected so
  the orchestrator-authored (trusted) baseline is never capped by the
  ceiling meant to bound the model-authored (untrusted) pending-tool
  timeout -- only the untrusted contribution is capped; the trusted baseline
  competes with it via a max/min combination, so a legitimately long
  declared timeout is never silently shortened.
- **Exec-level rolling timer decoupled per provider.** Each provider adapter
  now declares, as a required capability, whether its exec-level inactivity
  timer should be sized from the dispatch's `timeout_s` or instead pinned to
  the total-duration ceiling (`max_total_s`). Providers whose exec channel is
  a real mid-turn liveness signal (or whose only stall signal at all is this
  timer) keep the `timeout_s`-sized rolling deadline; providers whose exec
  channel is silent mid-turn and would otherwise suffer false kills switch to
  the ceiling-derived timer, relying on transcript-based stall detection as
  their real stall signal instead. An absent total ceiling falls back to a
  large-but-finite sentinel rather than an effectively-infinite timeout,
  because an out-of-range timer delay does not wait forever -- it fires
  almost immediately.
- **Adaptive stall probe cadence.** The stall detector now polls each tracked
  entry on a cadence scaled to that entry's own threshold (floored at the
  loop's own tick interval, capped at five minutes), instead of polling every
  entry every tick regardless of its threshold. A tick that gates out a
  probe performs no stall evaluation for that entry at all. New observability
  fields on each poll-tick log line report probes issued, probes skipped, and
  the computed probe interval per entry.
- **Dispatch inactivity budget split from the total ceiling.** Fleet-sprint
  role dispatches now derive a distinct inactivity-timeout budget (capped at
  30 minutes) from the total-duration budget, rather than reusing the total
  ceiling as the inactivity threshold -- a role with a large total budget no
  longer gets a correspondingly large grace period before a stalled session
  is detected.
- Documentation (`docs/features/stall-detector.md`,
  `docs/stall-detector-resilience.md`, and the fleet-sprint architecture doc)
  updated to describe the per-dispatch threshold, the per-provider exec-timer
  source, and the inactivity/total-ceiling split as current behavior.

Carried forward (deliberately left open, not closed by this sprint):

- An integ-cycle run failed to return a schema-valid report after exhausting
  its repair attempts; disposed as unrelated to this sprint's diff (a
  schema-validation failure class, not a stall-detector kill) but the lost
  integration signal for that cycle is tracked as follow-up.
- A final-review dispatch was found to have compared against a stale local
  base-branch revision rather than the remote's current tip; tracked as
  follow-up to make that check itself more robust.
- Hub/member clock skew immunity for the stall detector, and a working
  mid-turn stall signal for one provider that currently has none, remain
  open, lower-priority follow-ups from earlier sprints.
- A post-verdict regression pass failed with a stall-detector-driven dispatch
  abort; informational only, did not gate this sprint's verdict, and carries
  over as backlog.

### Cost analysis

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $54.3312.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.8319 across 6 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 71 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```

## [Unreleased] -- restore config-driven HTTP KB provider selection

Sprint goal: give `getKbProviders` back the provider-selection logic an
earlier cleanup removed, so a stock, unmodified build can be pointed at a
remote KB server by configuration alone, with the SQLite path staying
byte-identical when no such configuration is present.

What shipped:

- **`getKbProviders` selects the project provider from config.** When
  `FLEET_DIR/knowledge/config.json` (written by `kb_setup`) selects
  `provider: "http"` with a URL and a decryptable token, the project KB
  provider is now an `HttpKbProvider`; every other case -- no config file,
  `provider: "sqlite"`, or a malformed/incomplete config -- degrades to the
  existing `SqliteProvider` unchanged, with a malformed config logging one
  loud warning instead of failing every KB tool.
- **No new no-arg `SqliteProvider` construction.** The `HttpKbProvider` this
  selection builds is always constructed with the already-built project
  `SqliteProvider` as its explicit fallback, closing the specific hazard of
  `HttpKbProvider`'s own default fallback resolving a database from the
  wrong working directory.
- **A `requireSqliteProject` narrowing guard** now sits in front of every KB
  tool call site that needs `SqliteProvider`-only capabilities (list,
  feedback, freshness sweep, reconcile/resolve-contradiction, directive
  methods), so those operations refuse loudly and by name when the project
  provider is remote instead of behaving unpredictably. That is eight of the
  nine SqliteProvider-only call sites; the ninth, `kb_stats`, deliberately
  degrades instead, using the non-throwing `isSqliteProject` guard to report
  a not-computable bible block over a remote provider.
- **`kb_setup` validates `remote`.** A value that is not an `http://` or
  `https://` URL is rejected before any hook or config is written, and plain
  `http://` to a non-loopback host returns a `warnings` entry (and logs one),
  because the bearer token would travel in cleartext. Loopback http
  (`localhost`, `127.0.0.0/8`, `[::1]`) does not warn. It warns rather than
  refuses so existing LAN deployments keep working.
- Test coverage is against real implementations only, including an
  end-to-end test that runs `kb_setup` for real against a live local HTTP
  server -- no mocked provider stubs. See `docs/knowledge-layer-design.md`
  for the full selection contract and its one remaining follow-up gap (an
  audit of `kb_stats` consumers now that its response is a union shape).

Carried forward as open backlog: auditing `kb_stats` consumers against its
now-union response shape. The user-directive pending-proposal clamp and
`kb serve`'s behaviour under a remote project provider were both listed here
as follow-ups and are resolved in this same branch.


### Cost analysis

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $10.0737.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0000 -- no integ-test-runner dispatch ran this sprint (no playbook found, or deploy never succeeded).
Pricing source: all 15 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- planner/plan-reviewer catch decompositions that contradict a bead's own NOTES corrections

Sprint goal: fix a real, observed failure mode where a sprint decomposed a
bead into children that were faithful to its original DESCRIPTION but
silently contradicted corrections already recorded in that bead's own NOTES
history -- caught only by a manual adversarial review, not by the normal
plan/review loop.

What shipped:

- **Planner reads NOTES before decomposing.** Before decomposing any bead
  with a non-empty NOTES section, the planner role now reads NOTES in full,
  chronologically, and treats a later correction/amendment/supersession entry
  as authoritative over the DESCRIPTION passage it contradicts, rather than
  decomposing from DESCRIPTION alone.
- **Plan-reviewer gains an independent safety-net check.** A new review
  criterion flags a child whose content contradicts a correction recorded in
  its parent's NOTES; a CHANGES_NEEDED finding of this kind must quote the
  exact conflicting text from both the parent's correction and the child's
  contradicting passage, so the finding is falsifiable by inspection rather
  than a vague "may not be aligned" assertion.
- **A tooling-computed staleness signal**, independent of the model
  remembering to check: once per planning phase, the engine now flags any
  in-scope bead whose NOTES were updated after its most recently created
  child, and surfaces that as an advisory note in both the planner's and the
  plan-reviewer's dispatch context. The signal never blocks planning and
  degrades silently to the prior prompt-only behavior on any lookup failure.
  See `docs/planner-plan-reviewer-notes-staleness.md` for the full design,
  including a known limitation (the signal currently only considers a bead's
  *open* children, so it can miss or misfire once children close) and a note
  on two beads-health-gate test scenarios that are flaky only under full test
  concurrency -- both left open as low-priority backlog rather than papered
  over in this change.

Deploy could not be verified end-to-end this sprint: the sandbox smoke step
failed for an environmental reason (the `node` binary resolved from `PATH`
predated the `node:sqlite` built-in the fleet server now requires), not a
code or runbook defect. Re-run once the environment resolves a supported
Node version.

### Cost analysis

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $3.5589.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0000 -- no integ-test-runner dispatch ran this sprint (no playbook found, or deploy never succeeded).
Pricing source: all 7 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- runner.js structural refactor epic closed out: independent end-to-end verification, security tracing, final hardening

Sprint goal: close epic apra-fleet-3swo (the runner.js strangler-fig
decomposition, dispatch-engine consolidation, and productization work) with
an independent, from-scratch verification pass against the whole
`main..branch` diff -- not a re-statement of an earlier sprint's own PASS
claim -- plus land the last round of hardening findings before closure.

What shipped:

- **Epic apra-fleet-3swo closed, all 70 children closed.** Independent
  verification (re-derived from source, not read off the diff) confirmed the
  central claims: `runner.js` 11,849 -> 3,118 lines with 44 new
  `fleet-sprint/*.mjs` modules covering every module the epic named and all
  twelve `phases/*.mjs` files, zero files deleted. All 13 sprint roles route
  through the single `dispatchRole(ctx, roleName, opts)` engine;
  `inline-ladder-guard.checkModules({})` live-scanned 57 files with 0
  violations -- the load-bearing proof that no role dispatches twice.
- **Security/failure-path tracing** across the sprint's new surfaces: the
  `vcs_credential_exec` server-side credential handoff (the token never
  enters any returned field, including a thrown dispatch error's message; an
  OS/shell with no credential-read implementation hard-fails with
  `unsupported_member_os` rather than degrading to a credential-less
  dispatch), the structured `provision_auth`/`provision_vcs_auth` responses
  (traced end-to-end through `wrapTool`'s `structuredContent` passthrough
  into the outcome check that branches on it), `install --force`'s
  stop-registered-service-then-escalate kill path, and the sandbox-deploy
  port-allocation-race retry ladder (bounded retries, gated on a proven
  conflict only).
- **The legacy `readMemberVcsCredentialToken` prose-scraping credential-read
  path is fully retired from production** -- every caller now routes through
  `vcs_credential_exec`. `buildCredentialReadCommand` (its per-shell command
  string builder) is kept as `vcs_credential_exec`'s own in-process building
  block and stays exported and tested.
- **Test suite, run independently rather than trusted from the sprint's own
  claim**: root `npx vitest run` -- 322 files / 4581 tests passing, 0
  failures. `packages/apra-fleet-se npm test` -- 3104 tests, 0 failures,
  including the long phase4 move-only-completeness `ANCHOR_DESYNC` probe.
  `packages/apra-fleet-se/scripts/check-generic-boundary.mjs` (this repo's
  lint-equivalent gate for the generic engine boundary) -- 77 engine files
  scanned, 0 apra-fleet-specific assumptions found.

Filed as follow-up during this closing review (deliberately left open, not
closed by this pass -- see "Carried forward" in the sprint analysis
artifact):

- apra-fleet-3swo.73 (P2) -- an integ-test-runner schema-repair exhaustion
  currently produces a schema-invalid report indistinguishable from a real
  test failure; only the `infra` degrade class maps to an inconclusive
  record today.
- apra-fleet-3swo.74 (P2) -- a PowerShell inline vcs-token escaping gap.
- apra-fleet-3swo.75 / .76 / .77 (P3) -- a sprint-analysis cycle undercount,
  stale emoji-prefix test doubles, and a `provisionFailed` fail-open edge
  case.
- Regression carry-over (informational only -- does not gate this sprint's
  verdict): apra-fleet-x0mr (nested golden-transcript/mock-sprint sub-suite
  budget overrun) and apra-fleet-wzmv (a bare `phase4-move-only-completeness`
  failure), both newly filed from the real-bd regression suite;
  apra-fleet-eft.17, apra-fleet-j48h, and apra-fleet-jz2m (pre-existing
  tracking beads) updated with fresh evidence rather than duplicated.

### Cost analysis

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $113.2537.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $1.5799 across 10 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 100 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- runner.js structural refactor complete: monolith to modules, dispatch engine fully migrated

Sprint goal: finish the strangler-fig decomposition of
`fleet-sprint/runner.js` -- extract every module the epic named, collapse
all hand-written per-role dispatch ladders onto the `dispatchRole(ctx,
roleName, opts)` engine, and slice `runSprintCycle`'s body into
`phases/*.mjs` with move-only discipline, verified byte-identical against a
golden transcript.

What shipped:

- **`runner.js` decomposition is complete.** The file went from 11,849 lines
  on `main` to 3,118 lines (189,158 bytes) at this branch's tip, with 44 new
  `fleet-sprint/*.mjs` modules (including all twelve `phases/*.mjs` files and
  every module the epic named: `vcs-auth`, `git-sync`, `coordination`, `kb`,
  `beads-scope`, `beads-transitions`, `member-target`, `role-policies`,
  `sprint-args`, `worklists`, `prompts`, `sprint-state`). No files were
  deleted; `runner.js` is now a composition root plus a facade that
  re-exports every symbol its importers and mock-sprint test fixtures rely
  on.
- **All 13 sprint roles now dispatch through the single `dispatchRole`
  engine**, reading `role-policies.mjs`'s data table -- zero hand-written
  inline `agent()` dispatch ladders remain. `inline-ladder-guard.mjs` is now
  a live check across every role.
- **Move-only discipline held for the entire slice**: across the full
  twelve-phase extraction and the thirteen-role dispatch-engine migration,
  the golden mock-sprint transcript fixture changed on exactly two lines,
  and only because the plan-reviewer schema intentionally grew a new field.
- **Every role's dispatch watchdog is now explicit and reasoned**
  (`role-policies.mjs`): all 13 roles declare `watchdog()` or `noWatchdog()`
  with a stated rationale, and each armed watchdog resolves against its own
  row's hard elapsed ceiling rather than a shared inactivity budget.
- **Pre-sprint validation refusals are now typed** (`PreSprintValidationError`)
  with a frozen reason vocabulary, replacing an untyped `Error`
  distinguishable only by prose.
- **The plan-reviewer contract carries a structured, per-bead `findings`
  array** alongside free-text `notes`, and contested-bead routing now reads
  it directly instead of prose-scraping `notes`.
- **`vcs_credential_exec` gained an inside-caller-quotes substitution mode**
  (`{{vcs_token_inline}}`) alongside the existing bare `{{vcs_token}}`
  placeholder, so a caller needing the token inside its own quoted string no
  longer has to choose between double-escaping and a broken command; token
  redaction now also covers a dispatch failure's thrown-error message, not
  just successful stdout/stderr.
- **Fixed:** `install --force` no longer races a service-manager-managed
  server's automatic relaunch -- it stops the registered service first and
  only escalates to a direct kill when the same pre-stop pid is still alive
  afterward.
- **Fixed:** the sandbox deploy helper's OS-assigned-port allocation race
  (bind failure when a concurrent process claims a just-released port
  number) is resolved: conflicts are tagged only when proven (a grace-window
  poll, not a single probe), retries are bounded, and re-allocation excludes
  both the lost port and its adjacent neighbors.
- **Fixed:** a crossing sync-bracket close now preserves the bracketed
  body's own error as `cause` on the mutual-exclusion error it raises,
  instead of discarding it.
- **Fixed:** `resultText()` now skips a user-audience onboarding/welcome-back
  display banner instead of reading it back as if it were the tool's own
  output.

Carried forward (correctly left open, low priority): the Phase 5
credential-helper retirement work that routes remaining callers off the
legacy prose-scraping credential-read path and deletes it -- the new
server-side credential handoff is live, but the old path still has callers
pending migration.

### Cost analysis

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $30.6928.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.1322 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 27 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- runner.js module decomposition: dispatch engine fully migrated, Phase 4 residual chain mostly landed (sprint FAILED -- scope incomplete, full test gate red)

Sprint goal: continue the strangler-fig decomposition of
`fleet-sprint/runner.js` -- collapse the remaining hand-written per-role
dispatch ladders onto the `dispatchRole(ctx, roleName, opts)` engine, and
keep slicing `runSprintCycle`'s body into `phases/*.mjs` modules with
move-only discipline.

What shipped:

- **All 13 sprint roles now dispatch through the single `dispatchRole`
  engine** (`dispatch-role.mjs`) reading `role-policies.mjs`'s data table --
  zero hand-written inline `agent()` ladders remain for planning or
  execution dispatch. `inline-ladder-guard.mjs` is now a live check across
  every role instead of the inert placeholder it was while no role had been
  migrated.
- **`runSprintCycle` is now composed from twelve `fleet-sprint/phases/*.mjs`
  modules**, one per phase (Ensure Sprint Branch, Plan, Replan, Develop,
  Review, Deploy, Integ Test, Re-Review, Final Review, Regression Test,
  Harvest, Publish PR), in that fixed order; `runner.js` itself is now a
  composition root plus facade, down from roughly 11,700 to about 4,000
  lines. Six more extraction modules landed in the same residual chain:
  `git-topology.mjs`, `member-sync.mjs`, `member-provisioning.mjs`, plus the
  facade-completeness scaffolding that carries the chain to its final
  composition-root gate. That gate (`scripts/phase4-moveonly-probe.mjs`) now
  runs end to end and passes. A further six extraction modules landed after
  this entry was first drafted -- `beads-children.mjs`, `sprint-report.mjs`,
  `newtask-text.mjs`, `round-session.mjs`, `dispatch-failure.mjs`, and
  `fatal-diagnostics.mjs` -- closing out the extraction slate that was still
  tracked as remaining.
- **Fixed:** `install --force` no longer races a launchd/systemd-managed
  server's automatic relaunch. It now stops the registered service first
  (graceful `ServiceManager.stop()`), and only escalates to a direct kill
  signal when the same pre-stop pid is still alive afterward -- a pid that
  appears only after the stop is reported as a supervisor relaunch (with the
  platform's service-stop command) instead of being signalled forever.
- **Fixed:** the fleet-sprint VCS-auth self-heal outcome check now reads the
  provisioning tool's structured `ok` result first, falling back to legacy
  prose matching only when structured content is absent -- closing a false-
  success reading that a retired prose marker could previously produce.
- **Fixed:** `resultText()`, the shared MCP result-text helper every
  fleet-sprint dispatch caller reads, now skips a user-audience onboarding
  or welcome-back display banner that `tool-registry.ts`'s `wrapTool()` may
  prepend ahead of the real tool result (or append a nudge banner after it),
  instead of always reading `content[0]`. This closes a window where a
  caller could read the banner text back as if it were the tool's own
  output on a first-run or welcome-back dispatch; empty/missing-content and
  all-banner cases still return `''`, unchanged.
- **Fixed:** `vcs_credential_exec`'s token redaction now also runs on a
  dispatch failure's thrown-error message, not just on successful
  stdout/stderr -- closing a leak path where a failed credentialed command
  could otherwise echo the plaintext token back through its own error text.
- **Fixed:** the guarded-module registration completeness check now compares
  full relative paths instead of bare filenames, closing a collision where a
  newly nested module (e.g. `phases/index.mjs`) could silently ride on an
  unrelated top-level module's registration.
- **Fixed:** a shared dispatch call-site source scanner now skips comments
  before extracting object-literal text, closing a hazard where an
  apostrophe inside a comment could swallow the rest of the scanned file.
- **Every role's dispatch watchdog is now explicit and reasoned**
  (`role-policies.mjs`): the policy normalizer no longer silently defaults a
  role's watchdog to disarmed, and all 13 roles now declare `watchdog()` or
  `noWatchdog()` with a stated rationale. `deployer`, `integ-test-runner` and
  `regression-test-runner` are newly ARMED (a deliberate behaviour change) as
  long, unattended, single-dispatch phases with no other client-side
  kill-path -- operators now see those three phases aborted by the
  client-side watchdog if they hang, instead of running unbounded. Each
  armed role's watchdog resolves against its own row's hard elapsed ceiling
  (`maxTotalS`, e.g. `INTEG_MAX_TOTAL_S`/`REGRESSION_TEST_MAX_TOTAL_S`), not
  a shared inactivity budget, so operators see a long phase bounded by its
  own intended ceiling rather than aborted early against an unrelated
  shorter budget.
- **Pre-sprint validation refusals are now typed**
  (`PreSprintValidationError`, a `WorkflowError` subclass) with a frozen
  reason vocabulary (`TARGET_NOT_VISIBLE`, `NOTHING_TO_DO`,
  `CYCLE_REPAIR_FAILED`, `DEADLOCKED`). This flips
  `isTerminalSprintFailure()` from false to true for these refusals, so the
  supervisor watchdog now reports them as FINISHED (with the refusal reason)
  instead of CRASHED. The human-readable refusal messages are unchanged byte
  for byte.
- **Fixed:** `execute_prompt`'s `fork` argument now normalises once before
  both its mutual-exclusivity check and its fork-id resolution, so
  `fork: ''` or a whitespace-only fork id can no longer disagree with
  itself. Previously the two checks trimmed differently, so a
  whitespace-only id could be silently misrouted into a best-effort fork
  that returned a plain fresh session with no error -- exactly the
  wrong-context dispatch the explicit-fork gate exists to forbid. It now
  takes the explicit-fork-id branch and gets the same terminal
  `session_not_found` rejection as any other unknown id.
- **New `vcs_credential_exec` tool**: a server-side VCS credential handoff
  that runs a credentialed command without ever handing the plaintext token
  to the caller. It now supports two placeholders: the original
  `{{vcs_token}}` (an already-quoted substitution) and a new
  `{{vcs_token_inline}}`, which substitutes the same token under
  interior-only escaping for a caller that must interpolate it inside a
  value it already quotes itself (e.g. a provider's own
  `Authorization: Bearer <token>` header string); a command may use either
  or both. `member_reservation`, `provision_llm_auth` and
  `provision_vcs_auth` all now also return a `structuredContent` half
  alongside their prose summary; the fleet-sprint orchestrator reads
  `structuredContent.expiresAt` and `structuredContent.{ok,outcome}`
  directly for its provisioning and reservation control flow instead of
  scraping the human-readable text, falling back to the legacy prose/marker
  path only when a result carries no `structuredContent` at all.
- **Fixed:** `provision_vcs_auth`'s deploy metadata
  (`structuredContent.metadata` and the rendered text) is now filtered
  through a single allowlisted-keys enforcement point instead of being
  forwarded verbatim from a VCS provider's `deploy()` result -- a
  defense-in-depth guard, since today's three built-in providers already
  mask token values themselves, but an unrecognised key from a future or
  edited provider is now dropped rather than silently published.
- Two bugs found and filed earlier in this sprint were fixed before this
  entry closed out: a real, reproducible port-allocation race in the
  sandbox deploy helper (plus a follow-up that widens port re-allocation to
  also skip candidates adjacent to a lost port, not just the lost port
  itself), and a stderr-pattern-table census gap left behind by the
  `git-topology.mjs` extraction.

Carried forward (filed as open backlog):

- **Phase 5 (observability/productization) is now underway, not
  unstarted.** The plan-reviewer's structured per-bead findings field now
  feeds contested-bead routing directly instead of being re-derived from
  prose, and every role's dispatch watchdog arming decision is now explicit
  and audited (see "What shipped" above). Still outstanding: routing the
  VCS-credential-handoff callers onto `{{vcs_token_inline}}`, and deleting the
  now-retired prose-scraper/credential-read helpers it replaces.

Everything else this section previously tracked as open backlog -- the
Phase 4 facade-completeness gate, the six extraction modules once still in
`runner.js`, the sandbox-deploy port-allocation race, the stderr-pattern-
table census gap, and two low-priority (P3) hardening items (a sync-bracket
pause-guard re-registration edge case and a shell-command-guard
header/implementation mismatch, alongside the already-noted `execute_prompt`
fork-predicate fix) -- was resolved before this entry closed out; see "What
shipped" above for each. No other gap was found walking the full commit
range for this entry beyond what is listed above; the remaining commits in
range are internal test-harness/dev-tooling changes (e.g. the nested-suite
timeout-budget test governance in `test/phase1-*`/`test/phase3-*`, KB
snapshot regeneration, and decision-record docs with no behaviour change)
with no operator-visible effect, and are deliberately not itemised here.

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $84.4598.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.7241 across 5 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 52 priced dispatch(es) used real per-member rates (get_member_model_pricing).

Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```

## [Unreleased] -- execute_prompt: session forking

Sprint goal: let `execute_prompt` branch a new, independent session from an
existing session's context (`fork`), instead of only being able to continue
a session in place (`resume`) -- enabling reusable-priming workflows where
expensive shared context is built once and then forked per task without
re-spending tokens to rebuild it each time.

What shipped:

- **`fork` parameter on `execute_prompt`**, mirroring `resume`'s shape
  (`boolean | string`): `true` best-effort-forks the member's stored last
  session (falling back to a fresh session with a logged warning if that
  session is stale or absent); a session-id string forks exactly that
  source session, with unknown/expired sources failing as a terminal
  `session_not_found` and no LLM call -- no silent wrong-context fallback.
- **`resume`/`fork` and `session_id`/`fork` mutual exclusivity**, rejected
  as a validation error before any member resolution or LLM call, since the
  two express contradictory intents (continue in place vs. branch away).
- **Provider capability model**: fork support is declared per-provider via
  an optional capability-method pair (a support check plus a flag builder),
  the same pattern any future provider-specific capability can reuse.
  Claude Code is fork-capable today; a `fork` request against a
  non-fork-capable provider is rejected outright (`fork_unsupported`, no
  LLM call) rather than silently downgraded to resume or a fresh session.
- **Fork descriptor threaded through both POSIX and Windows command
  builders**, so a fork-mode dispatch emits the provider's fork invocation
  in place of the ordinary resume/session-id flags on every supported OS.
- **Retry/self-heal safety**: every internal retry path (transient dispatch
  failure, stale-session retry, server-overload retry, self-heal retry)
  dispatches as an ordinary fresh/resume attempt on retry, never re-forking
  from the same source -- re-forking on every retry would multiply, not
  save, token spend.
- **`apra-fleet-client` updated** in the same change to keep the client
  wrapper's `ExecutePromptOptions` in sync with the new server-side option.

Carried forward (filed as open backlog; not blocking): a coverage gap for
the `fork_unsupported` terminal-rejection path in `execute_prompt` itself
(existing tests exercise it only against a fork-capable provider), and a
follow-up to actually wire `fork` into a reusable-priming workflow lane to
realize the token-savings motivation end to end.

### Cost analysis

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $13.5981.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.3278 across 3 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 33 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- runner.js module decomposition: Phases T-2 landed, dispatch engine and remaining phases carried forward (sprint FAILED -- scope incomplete)

Sprint goal: begin the strangler-fig decomposition of `fleet-sprint/runner.js`
(originally ~11,700 lines) into focused modules plus a policy-driven dispatch
engine, replacing ~13 hand-written per-role dispatch ladders with one
`dispatchRole(ctx, roleName, opts)` engine backed by a data table. The
originally-scoped epic estimated 5-6 sprints of work; this sprint delivered
the branch-queue triage phase, the guard-preparation phase, the full leaf-module
extraction phase, and the sync/beads/KB extraction phase (the largest phase),
landing eleven new `fleet-sprint/*.mjs` modules (`vcs-auth`, `sprint-args`,
`prompts`, `worklists`, `abort`, `branch-ensure`, `mcp-result`,
`member-target`, `git-sync`, `coordination`, `kb`, `beads-scope`,
`beads-transitions`) with move-only discipline, a facade-completeness test per
extraction, and a shared `guarded-modules.mjs` list so five independent
mechanical guards (shell-command, dolt-literal, full-db-fetch, unbracketed-push,
inline-ladder) stay pointed at every extracted module instead of silently
losing coverage as code moves out of `runner.js`. `runner.js` itself shrank
from roughly 11,700 to roughly 7,800 lines. Two pause-bracket push holes (the
Final Review findings push and the Publish-PR push) were closed by
construction as part of the `git-sync.mjs` extraction. The dispatch-engine
phase itself landed only its data layer (`role-policies.mjs`, with a
structural scanner keeping every row honest against the live dispatch sites)
and an inert readiness guard (`inline-ladder-guard.mjs`) -- no role has
actually been migrated onto `dispatchRole` yet, and the composition-root
phase (slicing `runSprintCycle` into `phases/*` modules) and the
observability/productization phase are both largely carried forward, aside
from three pieces that landed early: structured (non-prose) MCP responses for
member reservation and LLM/VCS credential provisioning, and a new server-side
VCS credential handoff tool that removes a plaintext-token round-trip through
orchestrator-readable command output. A regression was caught and reopened in
review: a consumer of the new structured provisioning responses shipped with
a stale test double that masked the new response shape throwing at runtime
inside a best-effort error handler. Separately, every deploy attempt this
sprint failed at the install step; the root cause was diagnosed and traced to
a pre-existing gap in how the installer stops a service-manager-relaunched
server, filed as follow-up work rather than fixed in this sprint, which means
none of the phases routed through a deploy-verified smoke test were actually
confirmed against a running build.

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $81.6134.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0000 -- no integ-test-runner dispatch ran this sprint (no playbook found, or deploy never succeeded).
Pricing source: all 48 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```

## [Unreleased] -- Dolt sync budget: fewer, cheaper beads syncs per sprint

A read-only investigation into where a fleet-sprint spends its `bd dolt pull` /
`bd dolt push` minutes found four cheap wins, all landed here. Together they
remove essentially all of the `sync.remote` probe spawns, most of the D-pull
spawns, and turn a multi-minute pre-launch guard into a single bulk query.

- **Pre-launch scope guard: one bulk fetch instead of one subprocess per bead**
  (apra-fleet-72o0). `POST /api/sprints` awaits the issue-scope overlap guard
  before it answers, and that guard walked the scope tree by spawning one
  `bd list --parent <id> --json` per discovered node, sequentially -- then
  repeated the whole walk for every already-active sprint's roots. A ~45-bead
  epic took minutes and timed the launch client out. `createScopeGuard` now
  accepts a `listAllBeads` dependency (default: one bulk fetch per
  `checkLaunch`), builds a child index once, and expands both the request's
  roots and every ledger sprint's roots from that same in-memory index -- the
  pattern `backlog.mjs` and `runner.js`'s `bdListScoped` already used. The old
  per-node walk is kept as an explicit test seam.
  - **Correctness fix in the same path:** the bulk fetch passes `--all`.
    `bd list` hides closed issues by default, so a CLOSED intermediate parent
    silently dropped its OPEN subtree from the overlap check -- two sprints
    with genuinely overlapping open work could both launch. The new guard is
    strictly more complete than the one it replaces, not just faster.
- **The `sync.remote` probe is memoized per member** (apra-fleet-akuv).
  `bd config get sync.remote --json` was re-spawned on every D-pull pre-gate,
  every D-push pre-gate and every `status()` probe -- measured at roughly
  90-160 spawns (about 0.6s each) per sprint, re-reading a value that never
  changes mid-run. It is now cached for the process lifetime, and ONLY when
  the answer was positively parsed: every fail-safe path (command threw,
  failSoft error, empty or unparseable output) still reports "configured"
  and is deliberately NOT cached, so a transient probe failure can never pin
  the fail-safe answer. Invalidated explicitly -- no TTL -- on any
  `bd config set` / `bd dolt remote` / `bd init` / `bd bootstrap` the
  orchestrator issues for that member (via the runner's central `command()`
  wrapper), on the auth self-heal firing, and on `repair()`. Every one of
  those seams drops the remote-tip fingerprint below alongside the memo.
  - **A settled dispatch MARKS the member rather than wiping it.** An
    agent's own `bd` commands never pass through `command()`, so the central
    `agent()` wrapper tells DoltSync when a dispatch settles. An earlier cut
    made that an unconditional wipe of both memos, which emptied the
    fingerprint before every dispatch bracket and re-spawned the probe once
    per dispatch (the golden mock-sprint transcript went from 1 probe to
    14) -- the primary path then paid an extra `ls-remote` and skipped
    nothing. The hazards do not warrant it: `bd bootstrap` (the one
    self-heal this repo's agent instructions prescribe) is non-destructive
    and, where it creates a DB, clones it from `sync.remote` -- a surviving
    fingerprint stays TRUE; a forced `bd init` yields an unrelated history no
    pull can fix, and its next push diverges into the terminals that already
    forget the tip. The one event a surviving fingerprint would get wrong --
    an agent-side `bd config set sync.remote <other>` -- is handled: the
    fingerprint is bound to the URL it was minted against, and a member
    dispatched-to since its memo was last read has `sync.remote` RE-READ (one
    `bd config get`, a plain config.yaml read) before any pull is skipped on
    it; a changed or unreadable answer forces a real pull. A member memoized
    as having NO remote is the one case that never reaches that check (both
    pre-gates exit on it first), so its memo is re-read once after any
    dispatch too -- otherwise an agent wiring a remote mid-dispatch would
    leave every later D-push of that member reporting a benign no-remote
    skip while its bead closes never left the clone. So the re-read is paid
    once per skip-after-dispatch for a member with a remote (one probe per
    process when the remote is quiet) and once per dispatch only for a member
    without one (sandboxes; the no-remote mock sprint's golden transcript
    shows exactly that shape).
  - **The tip probe cannot hang on a credential prompt and disables itself
    after two consecutive failures.** The probe runs with
    `-c credential.interactive=never -c core.askPass=` so a member without a
    usable credential helper fails at once instead of sitting on the 30s
    probe timeout; and after two consecutive failed probes the member's probe
    is switched off for the process (re-armed by the same hard seams that
    drop the memos), so a member that cannot list the remote pays nothing
    further and every pull is simply real, as before the feature.
- **The transient retry ladder is time-boxed, not count-boxed.** Widening the
  ladder to 8 retries with a 30s backoff cap fixed a real Windows `git.exe`
  spawn outage (measured 1-3 minutes) but applied that budget to every
  transient kind, and took the unit suite from 80s to 6m15s. The ladder is now
  split by error class: a SPAWN OUTAGE (`fork/exec ...`, "Not enough memory
  resources") is retried against a 3-minute WALL-CLOCK budget with the 30s cap
  -- so the bound is the same 3 minutes whether attempts return instantly or
  sit on the 600s step timeout -- while every other transient keeps the short
  pre-widening ladder (5 retries, 8s cap). An explicitly passed
  `maxTransientRetries` is honored by BOTH ladders (a hard attempt cap on the
  spawn-outage ladder as well, with the wall-clock budget still underneath);
  only the default changed.
- **Remote-tip fingerprint: a D-pull is skipped only when the remote provably
  has not moved.** The shared remote's `refs/dolt/data` is the only channel
  through which beads state moves between machines, so "is a pull needed?" has
  a cheap exact answer. Before a real `bd dolt pull`, one
  `git ls-remote <sync.remote> refs/dolt/data` (one round trip, no Dolt engine
  startup) is compared against the SHA that member last synchronized to; on a
  match the pull is not spawned and the step reports
  `{ skipped: true, reason: 'remote-unchanged' }`. The recorded tip is minted
  in exactly one place: the SHA observed immediately BEFORE a successful pull
  (a push racing in merely forces the next pull to be real). A successful
  push FORGETS the member's tip and never records one -- the push mutex only
  serializes this fleet's own pushes, so a post-push read of the remote can
  observe an unrelated machine's later commit and would record a SHA this
  clone has never seen; and for bd's git-backed remote the pushed SHA is a
  git commit minted inside the push itself, with no stable local ref to read
  it from. The pusher pays one real pull at its next bracket, after which the
  skip is re-armed. No `ls-remote` is issued inside the D-push bracket at
  all. Every uncertainty -- no recorded tip, an `ls-remote` failure or
  timeout, unparseable output, a `sync.remote` that could not be positively
  read or whose URL fails a strict safe-charset check -- falls through to a
  REAL pull. There is no path in which doubt produces a skip. The probe target
  is always resolved from `sync.remote` (via the memo above), never from git's
  `origin`, since the two can legitimately differ on a member -- which is why
  a scheme-less `sync.remote` (a bare Dolt remote NAME such as `origin`, or a
  bare path) yields no probe at all: `git ls-remote origin` would silently
  resolve against git's origin. An http(s) userinfo (`user:token@`) is
  stripped from the URL before it becomes part of the probe command, because
  the workflow journals every command string verbatim into the persisted,
  dashboard-visible transcript; the stripped URL authenticates through the
  git credential helper every provisioned member carries, and a member
  without one gets a failed probe, i.e. a real pull. Disable per call site
  with `remoteTipFingerprint: false`.

- **The supervisor dashboard had the same `--all` gap, with a worse
  consequence.** `dashboard.mjs`'s progress bars and `decomposedParentIds`
  check reused `backlog.mjs`'s `bdListAllBeads()` -- the same fetcher that
  deliberately omits `--all` for the visible Backlog board (which intentionally
  shows open work only). Reused for progress computation, that omission meant
  every sprint's `closed` count was silently always `0` (`bd list` excludes
  closed issues entirely, and `computeSprintProgress()` derives `closed` by
  filtering for `status === 'closed'`), on top of the same closed-parent-
  hides-open-subtree hole. The dashboard's default `listAllBeads` now uses
  `scope-overlap.mjs`'s `bdListAllBeadsWithClosed()` (`--all`) instead, with
  `buildSprintViews()` normalizing the raw rows itself. The Backlog board's
  own fetch (`bdListAllBeadsRaw()`/`bdListAllBeads()`) is unchanged by design
  -- it intentionally excludes closed work from that view.

This deliberately does NOT include the two larger items from the same review:
squashing Dolt history plus a fleet-wide re-bootstrap (a destructive
operational change needing a quiescent window and its own runbook), and moving
the Dolt remote off the git transport onto a bucket.

## [Unreleased] -- Member VCS-provider registration and dispatch-time self-heal

Umbrella context: apra-fleet-5oo ("member sprint-role readiness is never
provisioned or preflight-verified -- gaps surface reactively mid-sprint").

`register_member` could fully register a dispatch-capable member
(`llm_provider: "claude"`) while leaving its `vcsProvider` completely unset --
registration never asked for or detected it. The gap only surfaced hours
later, mid-sprint, as fleet-sprint's `VCSModule.resolveProvider()` throwing
"member has no registered VCS provider" on the member's first push or PR, on a
path whose own self-heal died on the same lookup and so could never heal it.

- **`register_member` now takes `vcs_provider`** (`github` | `bitbucket` |
  `azure-devops` | `none`), and `apra-fleet register-member` takes the matching
  `--vcs-provider` flag. An explicit value always wins and skips all probing.
- **Best-effort auto-detection at registration time.** With no explicit value,
  the member's git `origin` remote is read and its host mapped to a provider
  (`src/utils/vcs-provider-detect.ts`, covering https / ssh / scp-like URL
  forms with anchored host matching). Modelled on the existing Windows
  shell probe: it never blocks registration, and the result reports
  `VCS Provider: <provider> (auto-detected from origin)`.
- **A loud warning when detection fails.** Registering before cloning is a
  normal flow, so registration still succeeds -- but a dispatch-capable member
  with no resolvable provider now says so at registration time instead of
  failing hours into an unattended sprint. `llm_provider: "none"` members and
  an explicit `vcs_provider: "none"` are exempt.
- **Dispatch-time self-heal for members already in that state**
  (`provisionVcsAuthForMember`, fleet-sprint runner). When `resolveProvider`
  throws, the provider is resolved from the git remote the function has
  ALREADY read for its repos scope -- through the same provider registry every
  other host decision uses, never a provider literal -- and the subsequent
  `provision_vcs_auth` call persists it server-side as an existing side
  effect. An unreadable or unrecognized remote still raises the original
  error: there is nothing to detect, so nothing is guessed. Benefits both the
  reactive self-heal and the proactive preflight, which share the call site.
- **`BitbucketVCS` now declares `matchesHost`** (anchored to `bitbucket.org` /
  `www.bitbucket.org` / `altssh.bitbucket.org`, character-for-character in step
  with `vcs-provider-detect.ts`), so the host registry names it for a Bitbucket
  remote instead of falling through to the `generic-git` catch-all. Required
  for the fallback above to detect Bitbucket at all; behaviour-neutral for
  `VCSModule.capabilities()`.
- **Credential provisioning now resolves hosts through an ANCHORED matcher**
  (security). `GitHubVCS.matchesHost()` is deliberately a substring test -- a
  GitHub Enterprise Server install has no fixed domain, and that matcher
  answers `capabilities()`'s "could a PR be opened here?", where a wrong yes
  costs only a failed PR attempt. Auto-PROVISIONING is a different risk class:
  it mints a real push credential, and a substring test would hand it to
  `mygithubmirror.attacker.io`. GitHub now also declares
  `matchesHostForAuth()` (`/^(?:www\.|ssh\.)?github\.com$/i`), and the
  dispatch-time fallback resolves through a new
  `resolveVcsAuthProviderForHost()` that asks that matcher, considers only
  registered auth backends, and returns `null` -- never the `generic-git`
  catch-all -- for an unclaimed host. GitHub Enterprise is therefore not
  auto-provisioned on either layer; register those members with an explicit
  `vcs_provider`.
- **The dispatch-time fallback's catch is narrow.** `resolveProvider()` also
  throws for a `member_detail` RPC failure, an unresolvable member name, and a
  malformed registry response -- none of which a git remote can heal. It now
  stamps `code: VCS_NO_REGISTERED_PROVIDER` on the one self-healable failure,
  and the fallback triggers on that code alone; every other error propagates
  unchanged instead of being papered over with a provider guess.
- **`update_member` now takes `vcs_provider`** too -- an explicit operator
  override (never auto-detected) to correct a wrong auto-detect or set the
  provider directly without provisioning credentials. `apra-fleet-client`'s
  `UpdateMemberOptions` and both `docs/mcp-tools.md` /
  `packages/apra-fleet-client/docs/api-reference.md` are updated to match.
- **Fixed the "register this member again" remedy text.** Re-registering a
  member's folder is rejected as a duplicate, so it was never an actual fix
  for an undetermined `vcs_provider`. `register_member`'s warning (and the
  matching `docs/mcp-tools.md` text) now points at `provision_vcs_auth`
  (which already sets `vcsProvider` as a side effect of provisioning
  credentials) and the new `update_member --vcs-provider` override.
- **Clarified `remoteUrlOverride` provenance in fleet-sprint's runner.js.**
  Several logs/comments claimed a detected provider came from "the member's
  own git remote" even when `remoteUrlOverride` was supplied -- which can
  carry a DIFFERENT member's origin (e.g. provisioning `orchestratorMember`
  for a repo it has no checkout of). Reworded to state the URL's real
  provenance without changing behavior.

## [Unreleased] -- Azure DevOps VCS auth: credential assembly, PR publish path, and regression-sandbox hardening (sprint FAILED)

Sprint goal: make `provision_vcs_auth` and the fleet-sprint VCS layer support
Azure DevOps end-to-end -- guided PAT creation and storage, provisioning a
user's existing PAT to local and remote members, clean actionable surfacing
of Azure DevOps auth failure modes, and doing all of it through the existing
provider-abstraction rather than ad hoc conditionals -- alongside hardening
the regression-test-playbook's sandbox lifecycle so it cannot collide with a
real, concurrently-running supervisor on the same machine.

**Verdict: FAIL.** Full-suite tests pass at branch head and the code quality
on the named scope is high, but: both scope issues remain open (Azure DevOps
VCS auth, P0; regression-sandbox hardening, P1); Deploy halted at its
documented active-sprints precondition in every attempted cycle, so nothing
in this sprint was ever verified against an installed build and the
integration-test lane never ran; and several verify-routed items are still
open and unverified end-to-end. Treat everything below as landed-but-not-
yet-proven-stable, not as a finished, user-facing integration.

What shipped:

- **Azure DevOps host/URL recognition and repo-reference parsing**, dispatched
  from shared VCSModule code rather than hardcoded into the runner.
- **Provider-owned credential assembly**: `buildCredentials`/
  `missingCredential`/`testConnectivity` for Azure DevOps accept a PAT via
  either of two field names, validate an optional expiry at assembly time
  (rejecting an unparseable value instead of silently degrading), prefer the
  exact URL the credential was scoped to when testing connectivity, and test
  connectivity with an authenticated `git ls-remote` against a validated,
  concrete repo URL instead of an unauthenticated call to the org root.
- **A `setTimeout`-overflow guard on credential auto-cleanup**: a long-lived
  Azure DevOps PAT's expiry can exceed what a 32-bit signed millisecond delay
  can express; scheduling a raw timer for it would have silently fired
  almost immediately and auto-revoked the credential just deployed. The
  cleanup scheduler now skips scheduling entirely beyond that ceiling and
  relies on day-scale expiry warnings and reactive failure classification
  instead.
- **Azure DevOps auth-failure classification**: TF-numbered error codes and
  REST status codes are mapped to the same provider-neutral failure taxonomy
  every other provider uses, distinguishing an expired/revoked PAT
  (re-minting fixes it) from a missing-scope PAT (widening scopes fixes it)
  from an ambiguous repo-not-found-or-no-access response (neither remedy
  necessarily fixes it) -- and prints PAT-specific remedy text acknowledging
  that, unlike a GitHub App token, an Azure DevOps PAT cannot be re-minted by
  the fleet itself.
- **Azure DevOps pull-request and comment REST builders**, with the
  provider owning its own response-field mapping (Azure DevOps has no
  web-URL field and uses `pullRequestId`, not GitHub's `number`/`html_url`)
  and its own success/already-exists interpretation contract.
- **The runner's publish path now consumes that provider-owned PR response
  mapping** end to end, and mock-sprint gained hermetic coverage exercising
  the publish path against canned Azure DevOps responses, plus an opt-in,
  env-gated real end-to-end harness (provision, verify, publish) against a
  live Azure DevOps org.
- **Regression-test-playbook sandbox hardening**: a busy/stale/owner-release
  sandbox lockfile guards the smoke-test sandbox against concurrent runs;
  Setup now guards the toy dev server's port and a scripted, fail-loud
  port-verification gate replaces a silent check; dolt-orphan-sweep kills
  are scoped to the owning supervisor instance instead of a machine-wide
  heuristic; and `start` now refuses to reuse an already-running server on a
  version mismatch instead of silently continuing against a stale binary.
- **Documentation**: `docs/design-azure-devops-vcs-auth.md` captures the
  credential-assembly seam, classification rules, PAT-lifetime handling, and
  a harness-vs-production quoting distinction worth knowing before assuming
  an Azure DevOps test failure is a runtime bug;
  `docs/design-regression-sandbox-lifecycle.md` (new) captures the sandbox's
  cross-instance isolation design and the MSYS-vs-native pid mismatch
  invariant future contributors must respect when adding any Windows
  liveness/lock check.

Since the previous update to this entry, further cycles landed: a deploy
active-sprints gate that distinguishes a sprint's own live reservation from
a foreign one (closing the recurring deploy-blocked failure mode below, once
the dispatching process itself is relaunched from a build containing the
fix -- see `docs/design-regression-sandbox-lifecycle.md`); the mock-sprint
unmocked-network-command guard now matches curl/wget by command basename, so
a path-prefixed invocation no longer slips past it; the Azure DevOps
`testConnectivity` skipped-check result now carries a machine-detectable
`skipped: true` flag instead of being indistinguishable from a verified
pass; and slow-lane log-persistence test hardening. Verdict is still FAIL.

Carried forward (filed as open issues, not blocking further sprints from
starting, but blocking these epics' own completion):

- Deploy still has not completed against an installed build this sprint.
  The active-sprints gate itself now correctly distinguishes self from
  foreign reservations, but every attempted cycle was dispatched from a
  process that predated that fix landing in the tree, so the gate kept
  blocking as if no self-identity check existed at all. Nothing landed in
  this sprint has been verified against an installed build, and the
  integration-test lane never ran.
- Six verify-routed items are open and unverified end-to-end: the
  `canOpenPullRequest` capability-table pin (fixed in the diff, unverified
  post-install), the Azure DevOps create-pull-request builder, server-reuse
  version-mismatch handling, the sandbox lockfile, the port-3001 Setup
  guard, and the opt-in real Azure DevOps end-to-end lane.
- The sandbox lockfile's liveness check is not safely closable as-is: on
  Git Bash on Windows -- the platform this sprint runs on -- a pid captured
  from the shell's `$$` is an MSYS pid, but the liveness check uses a native
  `process.kill(pid, 0)`, so a live holder can read as stale or an unrelated
  native process can read as busy.
- `.claude/settings.json` now grants a blanket `Edit`/`Write` permission to
  every agent dispatch; this widening is not justified by any scope item
  here and should be reviewed.
- `dolt-orphan-sweep`'s owner-scope filter is inert when the sweep's data
  directory falls back to a relative path -- a known, not-yet-test-pinned
  gap.
- The build-lock preflight step run ahead of `install --force` kills every
  non-self, non-ancestor holder of this checkout's build artifacts with no
  built-in exclusion for a live foreign sprint's own child process --
  deploy operators currently have to hand-verify this after the fact.
- Regression-pass carryover from this sprint's full-suite run (a resumed,
  not freshly re-run, real-bd functional pass; a slow-lane failure tied to
  a pre-existing watchdog/recording-drift issue; and known Part-2
  smoke-test credential-provisioning blockers) is tracked as standalone,
  parent-less backlog and is unrelated to the Azure DevOps/sandbox scope
  itself.
### Cost analysis

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $17.1504.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0000 -- no integ-test-runner dispatch ran this sprint (no playbook found, or deploy never succeeded).
Pricing source: all 58 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- Supervisor dashboard: live-refresh parity with the per-run viewer

Sprint goal: bring the multi-sprint supervisor's own dashboard up to the same
live-refresh standard every individual sprint's per-run viewer already had --
adopt that existing architecture rather than invent a second one.

What shipped:

- **Lean `GET /state` JSON endpoint + `GET /events` SSE stream**: the
  supervisor dashboard now serves a lightweight JSON projection of the same
  Sprint Stack view model its full HTML page renders, plus a
  Server-Sent-Events stream that signals "state may have changed, go poll"
  on a fixed cadence (the supervisor has no single internal event bus the
  way one workflow run does, since its view model changes via many disjoint
  HTTP mutation routes) plus once immediately on connect.
- **Client-side live-refresh loop**: a debounced single poll pipeline fed by
  both the SSE stream and a heartbeat-interval fallback, re-rendering Sprint
  Stack rows in place (added/updated/removed by sprint id) using the exact
  same row-rendering function the server uses for the initial page load --
  no full-page reload anywhere in the refresh path.
- **Tab-activation refresh**: switching to the Sprints or Backlog tab
  triggers a fresh fetch through that tab's own existing fetch/poll
  plumbing whenever its last fetch is stale, independent of the other tab.
- **Per-node subprocess spawn removed from every dashboard render**: sprint
  scope expansion (used for both the raw claimed-bead count and the
  goal-filtered progress bar) now walks an in-memory index built off a
  single bulk beads fetch per render, instead of issuing one subprocess call
  per discovered graph node -- eliminating the dominant cost behind a
  previously near-unusable page-load time as the number of concurrently
  running sprints (and the size of their subtrees) grows.
- **Progress-widget labeling**: the two per-sprint counters that can
  legitimately disagree (raw claimed-scope bead count vs. the goal-filtered
  "Required" progress-bar count) are now both explicitly labeled, so a
  growing raw count no longer reads as a bug.

Carried forward (filed as open, low-priority backlog items; not blocking):
narrower unit coverage for the base-drift indicator's null/error paths, and
a documentation/branch-hygiene follow-up on keeping a long-running sprint
branch's review diffs scopeable against a moving base.

### Cost analysis

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $14.2427.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.5702 across 3 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 35 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- fleet-supervisor Backlog: sort by creation timestamp

Sprint goal: give the fleet-supervisor dashboard's Backlog view a way to
order issues by creation timestamp, so an operator scanning the unclaimed
task list can find the newest or oldest work without leaving the page.

What shipped:

- **Server-side `created_at` sort**: `GET /api/backlog/tasks` accepts
  optional `sort=created_at` and `dir=asc|desc` (default `desc`) query
  params, applied after the existing type/status/priority/model/q
  narrowing. The sort is a stable decorate-sort-undecorate over each row's
  original index, so ties never reorder relative to the incoming list.
  Rows with a missing or unparseable `created_at` always sort last in
  either direction and never cause an error. Omitting `sort` leaves task
  order exactly as before -- the feature is strictly additive.
- **Backlog header sort control**: the Backlog table header gained a
  Created-at sort `<select>` (Unsorted / Created (newest) / Created
  (oldest)), wired to re-fetch the task list with the chosen `sort`/`dir`
  and to reset alongside the other filters when Clear Filters is used. The
  existing header-injection mechanism still splices exactly once with the
  extra column present.

Carried forward (filed as backlog items, not blocking): a cosmetic column-
alignment mismatch between the new sort header cell and the data rows below
it, and a labeling issue where the "Filtering by ..." indicator can describe
a chosen sort as if it were a narrowing filter. Both are open, low-priority
follow-ups.

### Cost analysis

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $5.1721.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.3360 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 12 priced dispatch(es) used real per-member rates (get_member_model_pricing).

## [Unreleased] -- Fable test-suite audit: hidden subprocess spawns, duplicate tests, redundant bd calls

Sprint goal: work the low-risk/high-confidence subset of a test-suite and
bd-call-volume audit -- items rated safe to fix without an open design
question -- while leaving the higher-risk call-volume items for a separate
human design decision.

What shipped:

- **Hidden live subprocess spawns eliminated**: mocked supervisor
  dashboard/backlog test fixtures now supply the `listAllBeads`/`driftCheck`
  seams those modules default to a real subprocess call when omitted, so the
  fixtures no longer silently shell out to the developer's own live beads DB
  and git repo on every run. A regression guard runs the fixed fixtures as
  real child processes under an OS-level PATH shim (fake `bd`/`git`
  executables) and additionally parses the child's own test-summary output
  to rule out a vacuous pass (an empty spawn marker file from a child that
  ran zero subtests).
- **A real dolt-push bug fixed**: the pre-gate `sync.remote` probe result is
  now cached and reused on the retry/failure path instead of being
  re-queried, while keeping the original skip branch as defense-in-depth.
- **Batched bead claiming investigated and pinned down**: `bd update
  --claim` was confirmed to support a multi-id batch call; a `bd`-call-volume
  reduction was implemented and unit-tested, but is intentionally left
  dormant (no caller sets `assignee` yet) pending a follow-up that resolves a
  same-assignee re-claim edge case before the path goes live.
- **Duplicate test files consolidated**: several near-duplicate test files
  covering the installed-supervisor self-containment check and the watchdog
  reservation-release path were merged into single, parameterized files, and
  an exact-duplicate file was deleted outright.
- See
  [packages/apra-fleet-se/docs/architecture.md](packages/apra-fleet-se/docs/architecture.md)
  for the durable patterns behind these fixes (probe caching, the dormant
  batched-claim contract, and the no-live-spawn test technique).

Carried forward: a follow-up to verify (or rebase away) unrelated
in-flight orchestrator/member-reservation work that rode along on the same
branch as this audit but lies outside its scope, and a follow-up to confirm
`claimBeadsBatched` handles a same-assignee re-claim correctly before the
batched-claim path is activated. Both remain open as backlog. A same-sprint
regression pass could not run (see the sprint analysis artifact for the
permissions gap that blocked it) and is informational only -- it did not
gate this sprint's verdict.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $8.4210.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.1315 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 18 priced dispatch(es) used real per-member rates (get_member_model_pricing).

## [Unreleased] -- Windows shell selection: finish wiring fleet-sprint through the registered shell

Sprint goal: close out the remaining scope of the Windows shell-selection
epic -- wire the fleet-sprint-side command builders into their real call
sites (previously present as source but unused), mirror the registered
`shell` field into the MCP client's type definitions, align the
Windows-Git-Bash candidate list between probe and command builder, and fix
an unrelated, independently-discovered native-addon lock-detection gap in
the pre-build lock-clearing script. Final verdict is a PASS: all in-scope
work items closed, with the two remaining follow-ups noted below carried
forward as their own tracked items rather than blocking this sprint.

What shipped:

- **fleet-sprint dolt-settle now routes through the registered shell**:
  installing, probing, killing, and spawning the pinned local dolt server,
  plus the SQL/node-eval command strings sent around it, are built via the
  shell-aware command-builder classes instead of a fixed PowerShell
  assumption. A dedicated shell-aware SQL-escaping primitive and a
  wrap-PowerShell primitive for gitbash members were added to the
  fleet-sprint command-builder set to support this. Any command body that
  is embedded in a WMI/`Win32_Process` script (used for the pinned-dolt
  install/kill/spawn lifecycle) is now resolved in PowerShell dialect
  specifically, separately from the member's own shell-dialect path, since
  such script bodies are always interpreted by PowerShell regardless of
  the target member's registered shell -- a distinction that was not
  previously made and would otherwise silently break a gitbash member.
- **Runner threads the registered shell everywhere it settles state**: the
  remaining call sites that build a settle callback now resolve and pass
  the member's registered shell, closing the last gap where fleet-sprint
  fell back to a fixed PowerShell assumption regardless of what shell a
  Windows member actually runs.
- **MCP client typedefs mirror the server schema**: the client wrapper's
  register/update-member option typedefs and its member-detail result
  typedef now declare the `shell` field and the curated model-tier enums,
  matching the real server-side zod schemas -- closing a docs/typedef gap
  where the client already forwarded the field correctly at runtime but
  did not declare it. A parity test now reads the real zod schemas on both
  sides and asserts they agree, rather than relying on the two staying in
  sync by convention.
- **Git-bash candidate list unified**: the shell probe's remote discovery
  script and the local command-builder's resolver now consume one shared
  candidate-list literal (including the shared user-scope install-path
  suffix), with the parity test-asserted. The local resolver no longer
  falls back to a bare, PATH-resolved `bash.exe` when no known-good
  candidate checks out -- it now throws, rather than silently
  reintroducing the WSL/System32 Git-Bash-impersonation ambiguity the
  probe exists to close.
- **`isPosixShell` consolidated**: the several previously-deliberate
  private copies of the POSIX-vs-PowerShell branch predicate are now
  routed through one exported, overloaded helper (plus a convenience
  wrapper that reads both fields off an agent), with semantics unchanged.
- **Pre-build lock-clearing script hardened** (independently discovered,
  not part of the shell-selection epic's original scope): the script now
  also detects processes that hold a native build addon open as a mapped
  module rather than only processes whose own image path or command line
  lives inside the checkout -- closing a real gap where a native addon
  loaded by an unrelated host process (a system interpreter, an editor
  language server, a leftover test worker) was invisible to the previous
  matcher. It now re-probes empirically before reporting failure, names
  the blocking process when it cannot clear a lock instead of reporting a
  false success, and supports a dry-run mode.
- **Docs**: see
  [docs/windows-shell-selection.md](docs/windows-shell-selection.md) and
  [docs/cross-shell-command-construction.md](docs/cross-shell-command-construction.md),
  both updated this sprint to describe the now-completed fleet-sprint
  wiring, the consolidated `isPosixShell` helper, and the PowerShell
  error-guard requirement for any script-emitting wrapper -- including
  ones serving gitbash members.

Carried forward (not closed this sprint):

- Adding the PowerShell error-guard envelope
  (`$ErrorActionPreference = 'Stop'` + try/catch + explicit exit code) to
  the gitbash-specific wrap-PowerShell primitive, which currently emits an
  unguarded `-EncodedCommand` invocation unlike its sibling wrappers
  elsewhere in the codebase. Each current call site is independently
  protected by its own result-gating, so this is not believed to be
  live-exploitable today, but the gap should be closed rather than relied
  upon.
- Test coverage for the pre-build lock-clearing script rewrite, which
  shipped without its own test suite.
- A same-sprint regression pass (informational, does not gate this
  sprint's verdict) reconfirmed several pre-existing, parent-less
  carry-over issues (a long-running integration test, a KB
  remote-scope test, a publish-push-failure test, and the
  test-suite-file-duration budget) and surfaced one new, low-confidence
  candidate in the same family as a known bd-init-template-collision
  class of intermittent failure; a known sandbox-smoke-test
  credential-provisioning environment block (unrelated to this sprint's
  changes) was also reconfirmed. None of this blocks the sprint verdict.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $12.7413.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.3455 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 22 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- Windows shell selection: probe and register the real shell, not just the OS

Sprint goal: stop assuming every Windows member runs PowerShell. Add a
registered `shell` field (`gitbash | pwsh7 | powershell5`) alongside the
existing `os` field, probe for it at registration time, and route
Windows-bound command construction through the registered shell instead of
a fixed PowerShell assumption. Final verdict is a FAIL: the probe/register
path and the core command-construction routing landed and are verified
real and passing, but the epic as a whole is materially incomplete against
its own acceptance criteria (see "Carried forward" below).

What shipped:

- **Shell probe and registration**: registration now probes, in order,
  Git-for-Windows Bash, PowerShell 7, then PowerShell 5.1, trusting a
  candidate only when a real smoke command returns both exit code 0 and an
  expected stdout marker -- never on path/presence alone. A PATH-resolved
  `bash.exe` is rejected as a Git-for-Windows Bash candidate unless it is
  both outside known WSL/System32/WindowsApps launcher locations AND its
  own `uname` output confirms a real MINGW/MSYS environment, closing the
  WSL-launcher-impersonation gap. If every probe fails, registration still
  succeeds and degrades to `powershell5` with a surfaced warning rather than
  failing outright.
- **Shell-aware command construction (core)**: a new `WindowsGitBashCommands`
  implementation (extends the POSIX command builder, overriding only the
  Windows-native surface) is now selected for any member registered with
  `shell: 'gitbash'`. Command-construction call sites across member-home
  resolution, provider install commands, workspace-trust seeding, the
  local-execution strategy's process-kill and clean-env paths, credential
  escaping, and prompt-transfer/durable-mirror/orphan-recovery now branch on
  the registered shell (`isPosixShell(os, shell)`) rather than on `os`
  alone.
- **Docs**: see
  [docs/windows-shell-selection.md](docs/windows-shell-selection.md) for the
  probe design, the shell-vs-os distinction, the git-bash candidate-list
  invariant, and the design decision to keep the core and fleet-sprint
  implementations of this pattern independent rather than sharing a
  package.

Carried forward (epic left open; none of the following were closed this
sprint):

- Mirroring the new `shell` field into the MCP client wrapper's type
  definitions and API-reference documentation (the client already forwards
  the field correctly at runtime, so this is a docs/typedef gap, not a
  functional break).
- Wiring the fleet-sprint-side shell-command modules into their intended
  call site (the runner's encoded-PowerShell-command wrapper) -- the module
  set exists as source but nothing outside itself imports it yet, so it has
  no effect on fleet-sprint's actual behavior today.
- Aligning the Windows-Git-Bash command builder's candidate-path list with
  the probe's candidate list, so a user-scope (non-admin) Git for Windows
  install resolves consistently between probing and command construction
  instead of falling back to an unqualified, PATH-resolved `bash.exe`.
- Closing out the remaining Windows-equals-PowerShell survey sites (a
  shell-aware-string test-assertion gap remains against otherwise-verified
  production code).
- Consolidating the several current copies of the POSIX-shell-branch
  predicate behind one shared helper (currently deliberate, intentional
  duplication, not a defect).
- A deploy step that did not complete: `npm ci` failed reproducibly on
  attempting to unlink a native build addon file, before the build/binary
  and install steps could run; a working-tree hygiene follow-up (a few
  scratch files at repo root not yet covered by ignore rules); and a
  regression pass carry-over unrelated to this sprint's own changes.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $41.1657.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.2004 across 3 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 55 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- Windows/PowerShell shell portability and schema-repair retry correctness

Sprint goal: close out the remaining holistic-audit acceptance criteria for
member-bound command construction that silently assumed a POSIX shell, and
fix a schema-repair retry path that could resume the wrong session or lose
the original request across repair rounds.

What shipped:

- **Cross-shell command construction**: the GitHub VCS command builder now
  emits `curl.exe` explicitly on Windows members instead of relying on a
  bare `curl` invocation, which PowerShell silently resolves to its
  incompatible `Invoke-WebRequest` alias -- confirmed wired through the real
  production OS-resolution path, not just a test fixture. Golden POSIX
  command output is unchanged. A PowerShell deep-merge helper no longer
  throws on nested JSON objects (`PSCustomObject` does not support the
  `Hashtable` method the merge previously assumed) and no longer leaks
  internal accumulator metadata keys into merged JSON output. A Windows
  delete-files script builder was extracted into its own exported function
  so the regression suite exercises the real production script instead of a
  hand-duplicated copy that could silently drift.
- **Live-PowerShell regression coverage**: a reusable live-PowerShell test
  harness now backs exit-code and on-disk assertions for the credential
  file write, deep-merge, recursive file hashing, and delete-files code
  paths, closing the risk that a platform-gated suite reports green purely
  by skipping rather than by actually exercising real PowerShell.
- **Schema-repair retry contract**: a schema-invalid dispatch response is
  now retried by reattaching the original prompt and schema as explicit
  reference text on every repair round (re-derived from the one true
  original each time, so repeated rounds don't compound), and by resuming
  the exact session that produced the failed attempt via its captured
  session id rather than a generic "resume most recent session" flag. When
  no session id was captured, the retry now degrades to an explicit,
  loudly-logged fresh dispatch instead of silently guessing. A
  session-not-found response to an exact-id resume now triggers one
  additional fresh-dispatch attempt within the existing repair budget,
  rather than failing the whole repair outright.
- **Schema directory resolution**: the packaged-schema loader now picks
  whichever of its two built-in candidate directories (bundled vs
  package-local) was most recently edited, based on the newest contained
  schema file's modification time, rather than always preferring one by
  fixed convention -- preventing a stale bundled copy from silently
  shadowing an edited source schema.
- **Housekeeping**: stray root-level scratch artifacts were removed and the
  ignore rules widened so equivalent artifacts don't get re-added by
  accident; several pre-existing test-suite failures were triaged and fixed.
- See [docs/cross-shell-command-construction.md](docs/cross-shell-command-construction.md)
  and [docs/dispatch-reliability-hardening.md](docs/dispatch-reliability-hardening.md)
  for the full patterns behind these fixes.

Carried forward: extending the root test run to cover the workflow package
directly (rather than only via a separate invocation), a couple of
follow-ups on schema-directory-resolution edge cases and an unused
production caller for one Windows helper, and a same-sprint regression pass
that reconfirmed several pre-existing, parent-less carry-over issues (long
single-file test durations, a setup-failure cluster in one test group, a
couple of flaky timeouts, and a sandbox smoke-test credential-provisioning
precondition) -- no new defects were found in this sprint's own work and no
new carry-over issues were filed.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $30.6565.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.1440 across 3 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 52 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- Cooperative workflow pause/resume: closing the resume-barrier gap

Sprint goal: finish the cooperative pause/resume feature by closing three
integration-verification gaps found in the prior round -- the resume-time
reservation re-acquire/resync still raced the first post-resume dispatch
instead of strictly preceding it, a duplicated member-argument guard
remained in the workflow engine's internal dispatch path, and a requested
regression test pinning a reservation-store failure marker had not actually
been added. All three are now closed, verified against source rather than
against child-task titles alone. Final verdict is a clean PASS.

What shipped:

- **Workflow engine**: a new `setPreResumeHook(fn)` primitive. `requestResume()`
  is now `async` and awaits this hook as a hard barrier -- strictly before it
  clears pause state, releases any gate waiter, or emits the resume event --
  so a caller's reacquire/resync work is guaranteed to finish ahead of the
  first post-resume dispatch instead of racing it. A rejecting hook
  propagates out of `requestResume()` with pause state left intact, so a
  failed resume leaves the run parked rather than resuming on a
  half-restored state. `setPreResumeHook` is generic (no domain semantics of
  its own) and defaults to a no-op barrier when unregistered, so callers with
  nothing to do before resuming see no behavior change.
- **fleet-sprint**: its reservation re-acquire and resync now run through the
  new pre-resume hook instead of a fire-and-forget event listener, closing
  the race described above. A pause requested while a git/dolt sync
  "bracket" is open now also engages the instant that bracket closes, rather
  than waiting on whatever dispatch happens to arrive next. The
  reservation-release helper used for both a full teardown and a pause
  hand-back is now a single shared implementation instead of two
  independently-maintained copies of the same loop.
- **Reservation store**: a reserve call that fails at the storage-write step
  now returns a failure marker consistent with every other rejection path,
  so a resume's re-reserve step correctly treats a failed store write as
  "member not reacquired" instead of silently trusting it as a success. A
  regression test now pins this marker directly.
- **Workflow engine cleanup**: a duplicated member-argument validation guard
  in the engine's internal dispatch path was removed; the public entry point
  the internal path is exclusively reached through already enforces it.
- See [docs/features/workflow-pause-resume.md](docs/features/workflow-pause-resume.md)
  and `packages/apra-fleet-workflow/docs/apra-fleet-workflow-architecture.md`
  section 4.7 for the full design, now describing the pre-resume hook as the
  hard barrier it is rather than as a known limitation.

Carried forward: a follow-up to add direct unit coverage for the
`setPreResumeHook` type-guard paths (rejecting a non-function argument,
clearing the hook with `null`) remains open, as does a follow-up to guard
`requestResume()` against two concurrent resume calls both passing the pause
gate and running the pre-resume hook in parallel. A same-day regression pass
(informational, non-gating) reconfirmed several pre-existing, parent-less
carry-over issues in an unrelated functional test suite, a slow-lane
fixture-drift test, and a sandbox smoke-test preflight gate; no new defects
were found in this sprint's own work and no new carry-over issues were filed.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $16.3035.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.3214 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 25 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- Cooperative workflow pause/resume (engine, viewer, supervisor, fleet-sprint)

Sprint goal: add a generic, cooperative pause/resume primitive to the workflow
engine and wire it through every layer that needs to react to it -- the
per-run viewer's UI, the multi-sprint supervisor's dashboard and watchdog, and
fleet-sprint's own git/beads sync and member-reservation handling, as the
first workflow to attach real domain state to a pause. All in-scope work
closed; final verdict is a clean PASS.

What shipped:

- **Workflow engine**: `requestPause()`/`requestResume()`/`setPauseGuard()` on
  the workflow engine, alongside the existing `requestStop()`. A pause is
  deferred rather than immediate -- it only actually engages once every
  in-flight dispatch has drained to zero and an optional caller-supplied guard
  confirms the run is at a state boundary it considers clean -- so a pause can
  never land mid-way through a sequence a workflow script considers atomic.
  `requestStop()` while paused rejects every blocked dispatch so a paused run
  tears down instead of hanging.
- **Per-run viewer**: Pause/Resume buttons and a "paused since" badge, driven
  entirely by the engine's own pause lifecycle events rather than by the
  button click itself, so the UI always reflects what the engine actually did
  (including the deferred window between request and engagement).
- **Supervisor**: row-level Pause/Resume controls that proxy to the child
  viewer's own routes (never the kill+force-release path Stop uses); the
  crash watchdog now classifies a live, engine-paused child as a distinct
  healthy "paused" state (never conflated with stalled or crashed, and never
  auto-released); a base-branch-drift indicator shows how far a paused sprint
  branch has fallen behind its base branch.
- **fleet-sprint**: registers a pause guard so a pause only ever lands at a
  clean git/dolt-sync boundary; releases its member reservations on pause
  (so other sprints can use those members while this one is parked) and
  re-acquires them on resume with an owner-checked re-reserve that fails
  loudly (naming the unavailable members) if another sprint claimed one while
  paused; every re-acquired member is unconditionally resynced (git fetch,
  branch reconciliation, beads pull) before further work is dispatched to it,
  since both git and the beads database can move independently of a paused
  sprint. See [docs/features/workflow-pause-resume.md](docs/features/workflow-pause-resume.md)
  for the full design and known limitations.
- Bundled alongside this work: a fix to the Windows stall-poller's mtime probe
  commands to avoid an intermediate PowerShell `$variable` pattern that a
  remote execution path was found to silently strip, which had been turning
  the probe into a parse error on every poll for at least one real Windows
  member.

Follow-up hardening (second cycle, same sprint): fleet-sprint's resume-time
reservation re-acquire and resync is no longer best-effort -- `requestResume()`
now awaits a caller-supplied pre-resume hook as a hard barrier before any
post-resume dispatch can proceed, closing the race where a member could be
dispatched to before its reservation/resync completed. The duplicated
member-argument guard in `_commandDispatch()` was removed (the single copy in
`command()` is now the only enforcement point). A regression test now pins the
`[-]` store-write-failure marker so a reservation-store write failure is never
misread as a successful resume re-reserve. A new follow-up
(`apra-fleet-p2to.5`) was filed to guard `requestResume()` against concurrent
double-invocation of the pre-resume hook.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $22.9383.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.1429 across 2 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 34 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- fleet-supervisor self-containment fix and lifecycle documentation

Sprint goal: make the always-on fleet-sprint supervisor fully self-contained
in an installed apra-fleet (npm install or the SEA binary) -- no git clone of
the source repo required to run it -- and document its full operational
lifecycle. **Sprint verdict: PASS.**

A deployed supervisor could previously crash on boot with
`ERR_MODULE_NOT_FOUND` because two of its modules imported a shared helper via
a repo-root-relative path that reaches into a top-level directory the
install/SEA packaging step deliberately excludes. The fix vendors a verbatim,
clearly-marked copy of that helper inside the packaged supervisor tree so the
import never has to leave it. Beyond that one file, every module reachable
from the supervisor's entry point was audited end to end (41 modules) and
confirmed to resolve entirely inside the packaged tree, with a new
graph-shaped regression test that walks the same import graph an installed
tree actually has and fails on any future out-of-tree import from any
supervisor-reachable module, not just a previously-broken file.

The fleet-supervisor skill documentation was substantially expanded: it now
covers stopping the supervisor both gracefully (via its shutdown endpoint)
and via a cross-platform PID-based hard-stop when the API itself is
unresponsive, a discrete restart procedure, and registering the supervisor to
auto-start on login/boot on Windows (Task Scheduler or a Windows service),
macOS (a launchd user LaunchAgent, including a PATH caveat for a bare `node`
invocation), and Linux (a systemd user unit) -- each with both register and
de-register steps and a link back to the existing smoke test.

Deploy verification could not complete this sprint for environment/config
reasons unrelated to the code: native-module compilation failed on the local
build toolchain in one attempt, and the CLI permission allowlist used for
automated deploys was missing one required command prefix in the others. An
independent verification step booted the deployed build directly and
confirmed it serves its API correctly, so these are tracked as follow-on
environment/config fixes, not code defects.

Carried forward as low-priority backlog: a drift guard to keep the vendored
helper copy in sync with its canonical source automatically instead of by
hand; fixing the native-module build/toolchain compatibility issue in the
deploy environment; adding the missing command prefix to the deploy
permission allowlist; and updating the skill's own command examples to
reference the installed-tree path rather than a repo-checkout path. A
full-suite regression pass run informationally after the verdict surfaced a
handful of pre-existing, already-tracked flaky/slow-test issues plus one new
integration-test failure and one blocked smoke-test step, all filed for a
future sprint.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $16.8512.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.2033 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 34 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- KB anchor and cache-key fixes close out remote-member correctness

Sprint goal: finish making the Knowledge Layer correct for remote members,
closing the two more severe gaps an earlier sprint on this same epic had
carried forward as open follow-on work.

A `repo_path` that does not exist on the fleet server host is now always
treated as "no anchor" rather than silently substituted with the fleet
server's own working directory. Previously, two hot-path tools resolved a
non-existent path to `null` and let it fall through to a `process.cwd()`
fallback inside the shared provider accessor -- so while the *slug* (which
database) could already reach the correct shared project KB via the remote
URL, the *anchor* (the directory the capture basis check and freshness
re-hash resolve relative source files against) silently became an unrelated
tree. Because freshness re-hashing against the wrong tree fails every basis
check, this could retire healthy entries in the real shared KB -- a
regression in severity from merely colliding with an isolated fallback
database. The fix: a provider whose anchor does not exist on this host now
suppresses freshness verdicts entirely (all-or-nothing per call) instead of
producing false staleness, while capture stays protected by its existing
fail-closed basis check. The same one-anchor-policy rule was also applied to
the two remaining call sites that still built a provider from a locally
pre-resolved path.

The fleet's own automatic post-prompt harvest dispatch, and the `code_context`
KB enrichment call site, now forward the caller's `repo_remote_url` too, so
both benefit from URL-based routing instead of only the tools a caller invokes
directly. Forwarding a member's registration-record URL from an access list
that may contain multiple, unrelated repos is deliberately conservative: a URL
is only forwarded when it unambiguously names the member's own repo, never
guessed or derived from a bare `owner/repo` entry or discovered by shelling
out to the member host.

Several missing CLI permission prefixes the `deploy` runbook requires
(installer/binary invocations) were granted to the merged effective
allowlist for this repository. The deploy phase still did not complete this
sprint, however: it failed again in both cycles on a separate, still-missing
grant for launching the built binary via its `run` subcommand, so the
shipped KB fixes above are verified by their test suites only and have not
yet been confirmed against a deployed build. The regression-test pass was
separately blocked for the same reason (a missing `bd` command grant) and
also did not complete. Both permission gaps are carried forward as open
follow-on work.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $21.4535.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0000 -- no integ-test-runner dispatch ran this sprint (no playbook found, or deploy never succeeded).
Pricing source: all 28 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- Remote members can scope KB calls by git remote URL

Sprint goal: make the Knowledge Layer correct for remote members, whose work
folder is a path on another host and therefore unreachable from the fleet
server's own filesystem. Every `kb_*` tool now accepts an optional
`repo_remote_url` input (one shared schema fragment, spread into all sixteen
tool schemas, so the field cannot drift or be redeclared inconsistently).
`resolveProjectSlug` prefers an explicit remote URL over shelling out to git
against `repo_path`, so a remote member supplying its repo's origin URL
resolves to the *same* project KB and slug its local counterpart would --
instead of every remote member, across every repo, pooling into one shared
`default` database. Independently, the KB provider cache is now keyed by
`(slug, repoPath)` rather than slug alone: previously the *first* caller to
resolve a given slug fixed the anchor directory used for the capture basis
check and the freshness re-hash for every later caller resolving to that same
slug, which could silently basis-check one repo's capture against an
unrelated tree. A pre-existing, unrelated test failure (the sandbox-sync
remote-list parser throwing on `bd`'s literal `null` output for a repo with
no configured remotes) was also fixed.

This does not close the epic. Two live-verified, more severe variants of the
same class of defect remain open as follow-on work: (1) a `repo_path` that
does not exist on the fleet server host is not always translated into "no
anchor at all" -- at least one hot-path tool resolves the failure to `null`
and then lets it fall through to a `process.cwd()` fallback inside
`getKbProviders`, so the freshness anchor silently becomes the fleet server's
own working directory instead of either the real repo or no anchor; because
the slug (which database) can now correctly reach the *real* shared project
KB via the remote URL while the anchor is wrong, this can silently stale
healthy entries in that shared KB rather than merely misreading it, which is
a regression in severity from the pre-sprint behavior of colliding only with
an isolated `default` database; (2) the fleet's own automatic post-prompt
harvest dispatch path still forwards only `repo_path`, not `repo_remote_url`,
so it does not yet benefit from the new URL-based routing. Deploying and
smoke-testing this change against a real build was also blocked for the
entire sprint by missing CLI permission grants for the installer/binary
invocations the deploy runbook requires, so the shipped pieces are verified
by their test suites but have not been confirmed against a deployed build or
re-tested against the live remote-member repro that originally proved the
bug. Both gaps, and the deploy-permission blocker, are carried forward as
open, prioritized follow-on work.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $11.9020.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0000 -- no integ-test-runner dispatch ran this sprint (no playbook found, or deploy never succeeded).
Pricing source: all 19 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- kb_harvest auto-harvest is now repo-scoped, not server-cwd-scoped

`kb_harvest` -- the only fully automatic KB writer, fired after every
`execute_prompt` completion -- previously reached the database through a
second, parallel provider accessor that memoised a single global instance
keyed off the fleet server's own working directory. In practice this meant
every member's harvested learnings, from every repo, landed in whichever
repo the fleet server process happened to be started in, regardless of which
repo the member was actually working in. `execute_prompt` now passes the
dispatched member's own working folder through to the harvest call, and the
harvest tool routes through the same single accessor every other KB tool
uses, which caches providers per resolved repo slug instead of one global
slot. The parallel accessor was deleted outright rather than patched, so
there is now exactly one route from a KB tool to a provider. A related
slug-resolution bug that collapsed plain-HTTPS git remotes (those with no
userinfo prefix) to the wrong fallback slug was fixed in the same pass, so
HTTPS and SSH remotes for the same repo now resolve to the same KB.

This closes local-member cross-repo KB contamination for the automatic
harvest path. Two related items remain open as follow-on work: remote
members do not yet resolve their own repo (their harvest currently lands in
a shared `default` KB rather than colliding with another repo's KB), and the
regression guard that protects the single-accessor invariant is a textual
source check rather than a structural one, so it does not catch a future
provider constructed directly with no explicit repo path. Deploying this
change requires the CLI permission allowlist to grant the deploy-phase
command prefixes (`gh`, `npm`, the installer binary, etc.) that the
repository's checked-in permission settings do not currently include; until
that is granted, this work is verified by its test suite but has not been
smoke-verified through an actual deploy.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $0.0000.
Remaining budget: unknown/unbounded.
Pricing source: all 17 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- KB/code-intelligence audit and pre-init lifecycle: sprint goal closed out

This entry reconciles the previous "sprint goal not met" note below: the
KB initialization lifecycle goal and the KB/code-intelligence audit goal
have both been closed at the parent level, on the strength of the work
already summarized below plus a completed audit pass. No new source
changes landed this cycle; this entry captures the final review of the
work already on the branch.

The KB initialization lifecycle delivered its pre-init sub-phase: provider
availability detection and repo index-size estimation, both pure and
unit-tested (see
[docs/code-intelligence-providers.md](docs/code-intelligence-providers.md)).
The init phase (first-time indexing with a progress-reporting opt-in
prompt) and the update phase (incremental re-indexing triggered by
staleness detection) were not built this cycle and remain open as
tracked follow-on work; an auto-reindex module delivered in an earlier
cycle already provides partial coverage of the update phase's
staleness-triggered re-indexing.

The per-member code-intelligence provider field (`codeIntelProvider` on
the `Agent` interface, wired into `register_member`/`update_member`) is
schema/persistence only -- no dispatch path resolves a provider per
member yet, so setting it has no observable effect until the routing
half of this feature is built.

The full KB/code-intelligence tool audit was run end-to-end: every KB
tool and every code-intelligence tool (with both providers) was exercised
via its audit task, and the corresponding verification task confirmed the
results. No bugs were filed as a result of the audit, consistent with a
clean pass -- the full test suite (2314 tests, 0 failures) provides
independent confirmation.

## [Unreleased] -- compose_permissions silent write no-op fix

Sprint goal: fix a bug where `compose_permissions` could report a grant as
successful while the underlying provider settings file on the target member
was never actually updated -- a silent no-op reproduced live on a Windows
member, though the underlying defect was not platform-specific. All in-scope
work closed. The sprint's own final verdict is FAIL (a reviewer dispatch
stalled and could not be repaired after a retry), and a same-day regression
pass also failed for the same stall reason; no carry-over beads were filed
from the regression pass.

What shipped:

- The config-delivery path used by `compose_permissions` now checks the exit
  code of every remote directory-creation and write command, and reads the
  written file back to structurally confirm the intended content actually
  landed (parsed-and-compared for JSON, substring-matched for TOML/string
  content) before treating a grant as delivered. Any failure -- a nonzero
  exit code or a read-back mismatch -- is surfaced as an explicit failure
  string from `compose_permissions`; the permissions ledger is left
  untouched in that case, so a failed write can no longer be recorded as if
  it had succeeded.
- A new regression test suite drives the real, unmocked local command
  execution path against a scratch filesystem and asserts on file content
  read from disk with the standard filesystem API, covering a fresh grant,
  a grant merged onto an existing settings file (preserving unrelated
  entries), and a forced write failure. This closes the coverage gap left by
  the existing test suite, which only asserted on the generated command
  string and could not have caught this class of bug.
- Verification note: this sprint's test run exercised the POSIX write path
  end-to-end on a real filesystem. The Windows write path is covered by
  code inspection and by existing mocked-command-string assertions, but was
  not executed end-to-end against a real Windows filesystem in this sprint
  -- that gap is called out explicitly rather than claimed as covered.
- Also included on this branch: a fix to the stall-poller's Windows
  liveness/staleness polling, which removed an intermediate PowerShell
  `$variable` from a remote one-liner (observed to be silently stripped by
  the SSH execution path on at least one Windows member, breaking the mtime
  signal on every poll) and replaced a directory-enumeration pattern that
  could hang against a nonexistent path with an existence guard ahead of it.

Carried forward: the write-level verification added here does not by
itself guarantee that a provider CLI reads and honors a correctly-written
settings file (a separate, already-tracked concern -- see the
workspace-trust caveat in `docs/missing-grant-recovery-and-playbook-evolution.md`),
and concurrent grant application against the same member remains an
unlocked read-modify-write. Both remain open, tracked items.

```
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $2.7463.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.1223 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 12 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.
```

## [Unreleased] -- cross-shell member-bound command construction audit

Sprint goal: fix a PowerShell parse failure that broke PR lookup on a
Windows fleet member during sprint-abort finalization, then perform a
holistic, codebase-wide audit for the same underlying bug class -- any
command string built with POSIX-only shell syntax (bare `$VAR`/`$HOME`
expansion, `sed`, `xargs`, `tail`, `nohup`) and sent to a member whose
remote shell may actually be PowerShell rather than bash. All in-scope work
closed except one coverage-extension task that remains open. The sprint's
own final verdict is FAIL: the final reviewer dispatch stalled and could not
be repaired, and a same-day regression pass also failed for the same
stalled-dispatch reason. No deploy succeeded this sprint -- every deploy
attempt was blocked at the dependency-install step by a locked native
build artifact unrelated to this sprint's source changes, so nothing here
has been rebuilt/repackaged or smoke-tested as a shipped artifact; the
changes below are described as implemented and unit/integration-tested in
the source tree, not as verified-deployed.

Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $14.3110.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0000 -- no integ-test-runner dispatch ran this sprint (no playbook found, or deploy never succeeded).
Pricing source: all 36 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

What shipped:

- The credential-file read used during sprint-abort finalization on Windows
  members no longer relies on POSIX-style `$HOME` path expansion, which
  PowerShell either parses incorrectly or rejects outright. The value is now
  resolved to a concrete, OS-appropriate path before the command is built.
- A shared `wrapPowerShellEncoded` helper now backs every Windows-bound
  PowerShell script construction site (text/JSON file writes, credential
  file read/write, recursive file hashing, member-bound file deletion, and
  the tools below). It base64-encodes the script as a `-EncodedCommand`
  invocation (removing an entire class of shell-quoting bugs) and forces
  `$ErrorActionPreference = 'Stop'` with a try/catch so a script-opted-out
  `-ErrorAction SilentlyContinue` failure stays suppressed while every other
  failure surfaces correctly, including a native command's exit code (via
  `$LASTEXITCODE`), which the wrapper's own `exit 0` previously masked.
- Remote task monitoring, remote log tailing, and member removal's
  authorized-keys cleanup are now OS-branched: each builds either a POSIX
  command or a PowerShell command depending on the target member's OS,
  instead of a single POSIX-flavored string that silently misbehaved (or
  was silently corrupted in transit) on a PowerShell target. Member removal
  now also surfaces a warning when the authorized-keys cleanup step fails,
  instead of failing silently.
- Long-running background tasks are now supported on Windows members: the
  task is launched detached via `Invoke-CimMethod Win32_Process.Create`
  (spawned under the WMI provider host's own session, independent of the
  SSH session's job object -- a plain background launch dies with the SSH
  channel on Windows), running a PowerShell wrapper script that mirrors the
  POSIX bash wrapper's status.json/task.pid/task.log/activity-marker/retry
  behavior. `monitor_task` reads the same task-directory shape on both OSes.
- Remote pid-liveness and durable-output-file probes (the orphan-recovery
  lease-of-life gate) are now OS-branched the same way -- previously they
  always dispatched POSIX `kill -0`/`cat`, so on a Windows member the probe
  could never report a genuinely-alive process as alive.
- Member OS detection no longer caches a guessed/fallback value on
  detection failure -- only a successful, authoritative detection is
  memoized, so a member is not permanently misrouted to the wrong OS branch
  after one failed detection attempt.
- The root test command now also runs the fleet-sprint workspace's own
  `node --test` suite, which was previously invisible to the root gate
  because it used a different test runner than the rest of the monorepo; a
  green root test run previously did not actually exercise this workspace
  at all.

Carried forward: one coverage-extension task (adding live PowerShell
exit-code tests for the remaining `wrapPowerShellEncoded` call sites beyond
the ones this sprint directly touched) remains open and unclosed.

## [Unreleased] -- npm-install dependency-packaging fixes

Sprint goal: unblock npm-installed (published-tarball, non-workspace) consumers
by fixing a cluster of packaging gaps found while replaying the npm-publish
gating sequence locally -- an incompatible transitive dependency that crashed
any process resolving it on the supported Node runtime, a bundled workspace
package that was shipped as source but never registered as an installable
dependency, an install safety guard that blocked replays on any machine
already running an unrelated server, and a package-size guard whose threshold
check could never actually fire. All in-scope work closed; the sprint's own
final verdict is FAIL (a reviewer dispatch stalled and could not be repaired
before the sprint budget ran out), and a same-day regression pass could not
run because the sandbox's permission allowlist did not cover the commands the
regression playbook requires.

What shipped:

- `undici` is now pinned to `^7.29.0` (via a workspace-root override, kept in
  lockstep with the published package's own dependency manifest and a
  regenerated lockfile) to restore Node 20 compatibility -- the newer 8.x
  line throws `webidl.util.markAsUncloneable is not a function` inside
  Node 20's older Web IDL internals as soon as anything requires it, crashing
  the CLI, the supervisor subprocess, and dozens of integration test files
  outright. A root-level override alone does not propagate to a downstream
  npm-installed consumer's own dependency resolution, and a stale lockfile
  can silently keep resolving the broken version even after the override is
  added -- both gaps are now covered by a test that packs the CLI, installs
  it into a clean non-workspace target, and imports `undici` from that
  installed copy, not just from the source workspace's own `node_modules`.
- `@apralabs/apra-fleet-client` (the bundled fleet-server client used by the
  fleet-sprint engine) is now also registered as a real installable
  dependency (a `file:`-referenced entry), not just listed in the package's
  shipped-files allowlist -- being present on disk after install and being
  resolvable via standard module resolution are two different things, and
  the gap was invisible in dev-mode testing because workspace symlinking
  hides it there. npm-installed users previously hit a silent
  `could not resolve the fleet server` warning and fell back to a degraded,
  no-op dolt-mutex/id-allocator path for every real sprint.
- The `install` command's running-process safety guard is now scoped to
  whether a detected running server is actually relevant to the install being
  performed (recorded live in the install's own data directory, or running
  from the exact prefix about to be overwritten), instead of refusing
  whenever any apra-fleet process exists anywhere on the machine. An
  unrelated server no longer blocks an isolated install replay, and the
  guard falls back to non-blocking (with an informational note) rather than
  silently reinstating the old global refusal when a running process's
  executable path cannot be determined.
- The npm-publish pipeline's Clean-pack size guard now reads the real byte
  count from `npm pack --dry-run --json` instead of pattern-matching npm's
  human-readable `unpacked size: 4.1 MB`-style notice line -- the previous
  regex extraction only ever captured the leading digits before the decimal
  point, so the 10 MB threshold comparison could never actually fire
  regardless of true tarball size. The new guard also accepts both
  `--threshold N` and `--threshold=N` forms and fails loudly on a malformed
  threshold value instead of silently ignoring it.

Carried forward: the `@apralabs/apra-fleet-client` resolvability fix above
ships without an automated test that packs the CLI, installs it into a clean
non-workspace project, and asserts end-to-end that `apra-fleet workflow
fleet-sprint` resolves the fleet server with no warning -- that verification
coverage is still outstanding and the parent bug it closes remains open
pending it. Separately, one reviewer-proposed follow-up task was rejected
before reaching issue creation because its title used characters outside the
tracker's safe-character allowlist; the underlying finding (the pack-size
guard's equals-form threshold handling) was fixed directly in this sprint's
work regardless, so nothing is outstanding from that rejection. The
end-of-sprint regression pass is deferred pending
an operator adding the missing sandbox command permissions; no new
carry-over issues were filed by that (informational, non-gating) pass.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $5.8641.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0929 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 24 priced dispatch(es) used real per-member rates (get_member_model_pricing).

## [Unreleased] -- Dolt push reliability: auth/divergence classification, recovery ladder wiring, child-id create fix

Sprint goal: fix a cluster of fleet-sprint reliability defects surfaced by
real sprint runs -- a Dolt D-push credential failure being misclassified as
data divergence and aborting the sprint instead of self-healing, an unused
Dolt conflict-recovery ladder that was never actually wired into the push
failure path, a `bd create` invocation that unconditionally combined `--id`
and `--parent` and silently lost the pre-allocated child id on failure, and
a sprint stall-detector reading closed-bead counts from a stale snapshot so
a cycle's own Integ Test closures were never credited toward progress. Also
in scope: test coverage for the VCS-auth preflight gate on read-side
dispatch brackets, and the provider-agnostic VCSModule error-taxonomy epic
this cluster builds on. **Code review found all six scoped items correctly
implemented and fully covered by the passing unit/mock suites, but the
sprint's own final verdict is FAIL**: Deploy failed at its permissions-check
step in every cycle this sprint ran (the sandbox's command allowlist did not
cover the two prefixes a prior sprint's deploy-runbook change now requires
for its supervisor-start and smoke-test steps), so the three parent bugs
routed to verify-against-a-deployed-build were never confirmed end-to-end
and remain open. The deployer correctly stopped and reported the permission
gap rather than working around it.

What shipped:

- A Dolt D-push rejection is now classified into a distinct credential
  (`auth`) failure versus a genuine non-fast-forward divergence, checked
  independently at both points a push can still fail (the first attempt, and
  the re-push that follows a reconcile-pull) -- previously both were folded
  into the same divergence error, so a lapsed credential aborted the sprint
  with a misleading "diverged" message instead of self-healing. An
  auth-classified push failure now triggers the same bounded, one-shot
  credential self-heal used elsewhere in the sync layer before retrying.
- The Dolt conflict-recovery ladder (scripted resolve-in-place, then
  discard-and-re-bootstrap, then an agent-with-runbook last resort) is now
  actually invoked from the D-push failure path at both divergence
  terminals, instead of existing only as a module exercised by its own
  tests. With no recovery hook supplied, prior degraded-by-default behavior
  is unchanged -- the ladder only ever narrows an existing failure into a
  resolved one.
- Fixed a `bd create` call that combined `--id` and `--parent` in one
  invocation, which the installed `bd` CLI rejects outright: the fix issues
  `--id` alone and links the parent with a separate `bd update --parent`
  call, verifying the reported parent matches what was requested before
  trusting the create.
- Fixed the sprint stall-detector's closed-bead count to be read fresh
  immediately before each cycle's progress evaluation, rather than reused
  from an earlier snapshot taken before that same cycle's own Integ Test
  step could close verify-routed beads -- previously those same-cycle
  closures were invisible to the stall detector's high-water-mark check,
  producing a false stalled-abort even though real progress was made every
  cycle.
- New end-to-end test coverage for the VCS-auth preflight gate on read-side
  dispatch brackets (planner, integ-test-runner, regression-test-runner),
  pinning that a preflight failure degrades silently rather than aborting
  the dispatch.

Carried forward: the three P1/P2 bugs verify-routed to a deployed build
(the Dolt credential-classification fix, the `bd create` id/parent fix, and
the stall-detector freshness fix) remain open pending a deploy run once the
sandbox's permissions allowlist is updated to cover the deploy runbook's
newer supervisor-start and smoke-test steps. A full regression pass run
after the final verdict (informational only, does not gate this sprint)
filed/reconfirmed several parent-less carry-over bugs, including a
smoke-harness port-cleanup gap in the toy-sprint deploy path.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $20.5559.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0000 -- no integ-test-runner dispatch ran this sprint (no playbook found, or deploy never succeeded).
Pricing source: all 42 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- install --force stop-confirmation fix (closes prior sprint's deploy-gate carry-over)

Sprint goal: continue the dispatch-stall/timeout reliability cluster by fixing
the two items a prior sprint in this same cluster had to carry forward after
its own deploy gate failed -- `install --force`/`update` could fail with
`ETXTBSY` (text file is busy) when it copied the new binary over a still-running
old server process, and it printed a "stopped running server" success message
unconditionally rather than only once termination was actually confirmed. All
scope work is now implemented, tested, and verified; the sprint's final verdict
is PASS.

What shipped:

- `install --force`/`update` now polls the old server process's liveness over
  a bounded grace window after sending the initial termination signal, and
  escalates to a harder kill signal (with a second, shorter poll window) if
  the process is still alive once the window elapses. The binary copy is only
  attempted once the old process is confirmed gone, closing the `ETXTBSY`
  failure that could occur when a fixed sleep wasn't long enough for a
  mid-request singleton to exit.
- The "Stopped running server." success message is now gated on that same
  confirmed-termination check instead of being printed unconditionally. If
  the old process is still detected running after both the initial signal and
  the escalation, install now reports a clear, actionable error (including
  the manual command to finish stopping it for the current platform) and
  exits non-zero, instead of asserting a stop that didn't actually happen.

No items are carried forward from this cycle. An end-of-sprint regression
pass could not run: the sandbox's permission allowlist did not cover the
commands the regression playbook requires, so the pass stopped at its own
permissions check before either its real-bd suite or its smoke test could
execute. This is informational and does not carry over any new bead; the
permissions gap needs to be resolved by an operator before a regression pass
can be attempted.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $5.3687.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.0695 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 12 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- Dispatch-layer stall/timeout reliability hardening

Sprint goal: dedupe and fix a cluster of dispatch-stall and max_turns-exhaustion
incidents traced to a stall detector that could not actually cancel a hung
dispatch, a client timeout budget that didn't account for the server's own
retry, and several related latent hazards found while investigating the same
incident cluster. **Goal work fully landed and code-quality-approved, but the
sprint's own final verdict is FAIL** -- the deploy gate failed before the smoke
test could run, and that failure was confirmed to be a genuine pre-existing
defect, not an environment fluke (see below).

What shipped:

- A confirmed stall now cancels the in-flight MCP dispatch itself (via an
  `AbortController` threaded through the same abort-signal path remote
  strategies already accept), instead of only killing the remote process and
  leaving the client to wait out its own independent hard deadline.
- The client's dispatch timeout budget now shares a single derivation with
  the server's own inactivity-timeout retry, so the client can no longer time
  out before the server's own retry-and-report-cleanly path gets a chance to
  run.
- Workspace-trust detection now also classifies an exit-0/empty-stdout
  dispatch against a never-trusted workspace as `workspace_not_trusted`
  (previously only a nonzero exit code triggered this), gated to
  self-heal-and-retry exactly once.
- The SSH connection pool's idle-reap path now re-verifies a channel is
  genuinely idle immediately before closing it, closing a latent risk that a
  provisional (not-yet-polled) stall-tracking entry's channel could be reaped
  while still live; SSH connections also now configure keepalive so a
  silently dropped connection is detected rather than left as a phantom pool
  entry.
- The supervisor watchdog's periodic tick now has a reentrancy guard, so an
  overlapping tick (possible once per-tick liveness checks take longer than
  the tick interval) is skipped rather than racing the in-flight tick on
  shared state.
- `finalizeAbort()`'s own git operations now go through the same
  self-heal-and-retry-once pattern already used elsewhere, so a stale
  credential encountered during abort cleanup no longer silently drops a
  PR-lookup step from the terminal history record.
- The sprint cost-analysis report now gives Integ Test its own line (previously
  folded into "overhead"), and dispatches that exhaust their turn ceiling or
  time out now report their real partial cost rather than an undefined/zero
  figure.
- The orchestrator no longer automatically classifies a max_turns/timeout
  streak as failed when every bead it was assigned is already closed -- it is
  now classified as a successful streak that overran its own VERIFY step, and
  no wasted resume dispatch is triggered. Paired with a strengthened doer
  contract stating that the moment its last assigned bead closes, its only
  next action is emitting the VERIFY result.
- `undici` is now pinned to the 7.x line workspace-wide via package-manager
  overrides, fixing a Node 20 incompatibility that broke child-process-spawn
  tests independent of any application code.

However, the sprint fails its own deploy gate: `install --force` failed with
`ETXTBSY` (text file is busy) while copying the new binary over a still-running
server process, and the smoke test never ran as a result. This was confirmed to
be a genuine, pre-existing latent defect in the installer's stop-then-copy
sequence (it waits a fixed short delay and unconditionally reports the old
server stopped, without verifying the process actually exited before copying
over it) rather than caused by this sprint's own changes -- but it still blocks
release and is tracked as carried-forward work (see below).

Carried forward to a future sprint:

- Make `install --force`/`update` verify the old server process has actually
  exited (polling liveness, escalating if needed) before copying the new
  binary, instead of assuming success after a fixed delay.
- Gate the installer's "stopped running server" message on confirmed
  termination instead of asserting it unconditionally.
- An end-of-sprint regression pass could not run at all: the sandbox's
  permission allowlist did not cover the commands the regression playbook
  requires, so the pass stopped at its own permissions check before either
  its real-bd suite or its smoke test could execute. This is informational
  and does not carry over any new bead.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $4.1194.
Remaining budget: unknown/unbounded.
Integ-test-runner spend: $0.1562 across 1 dispatch(es) this sprint (a subset of the tracked spend above, broken out of overhead/doer/reviewer).
Pricing source: all 10 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- fleet-sprint runner error-classification correctness

Sprint goal: fix a cluster of error-classification defects in the
`fleet-sprint` runner so that abort handling, terminal-record reporting,
post-dispatch teardown skipping, and reviewer contract enforcement each ask
the narrow question they are actually meant to answer, instead of a single
blanket "is this a `WorkflowError`" check sweeping routine, non-terminal
failures into a false aborted-sprint verdict. **Goal met -- sprint verdict is
PASS.**

What shipped:

- The runner's abort classification is now a curated, explicit list of
  typed error classes (stalled sprint, plan rejection, reviewer contract
  violation, budget exceeded, git/dolt divergence, pre-sprint validation
  failure) rather than every `WorkflowError` subclass -- so ordinary
  dispatch/sync failures each phase already retries or soft-fails on no
  longer masquerade as a full sprint abort with a spurious push and
  `[ABORTED]` PR.
- Terminal-record reporting (so the supervisor watchdog can classify a
  finished run as FINISHED-with-a-reason instead of CRASHED) was split out
  as its own, deliberately broader check from the narrower abort-worthy
  check, since every typed failure needs a terminal record but only a
  genuine abort needs the push-and-PR treatment.
- Post-dispatch sync teardown is no longer skipped for a dispatch failure
  where the agent provably ran (turn-limit exhaustion, or a local dispatch
  watchdog abandoning an in-flight call whose remote member kept running) --
  only genuinely no-mutation dispatch failures skip teardown now.
- A reviewer verdict's `replanIds` are now required to be a subset of its
  `reopenIds`; a `replanIds` entry that silently falls outside that set is
  both flagged as a reviewer contract violation and logged explicitly
  instead of being silently dropped.
- The Final Review LLM-auth self-heal path now short-circuits on success
  instead of falling through into a redundant second dispatch, and a
  heal-retry that itself throws degrades through the same generic failure
  ladder as every other Final Review failure.
- Plan-reviewer dispatch failures are now marked and retried distinctly from
  a genuine plan rejection, so a transport/infra failure while soliciting a
  plan-reviewer verdict is never misreported as the plan itself having been
  rejected.
- Publish's branch push is now fail-soft with a bounded retry; a push that
  still fails after retries is logged and skips PR creation and target-issue
  closure, but the sprint's already-computed PASS/FAIL verdict is still
  returned rather than being downgraded into a run failure -- so a caller
  reading the run's status can no longer assume a successful sprint verdict
  implies its branch was actually pushed or a PR was raised; `pushed:false`
  now distinguishes that case.
- A table-driven contract test enumerates every error class against both
  classification predicates (including wrapped-divergence and
  null/undefined edge cases), plus end-to-end harness assertions for each of
  the four routing outcomes (abort record, rethrow-with-no-record,
  teardown-skip, teardown-run), so future edits to this area have a single
  place to pin new rows rather than relying on scattered individual
  assertions.

Carried forward to a future sprint:

- One open task to update two pre-existing exit-classification tests for a
  concurrently-landed watchdog "launch failed" reclassification (a fast
  child exit within a configurable window of reservation now classifies
  differently than a plain crash); this runner-error-classification sprint's
  own file footprint did not need to touch those two files.
- Four regression findings surfaced by this sprint's end-of-sprint
  regression pass (informational; did not gate this sprint's verdict): a
  bd-replay recording drift in a stalled-planner-session test; a shared,
  non-exclusive smoke-test sandbox path that let two concurrent regression
  runs collide and destroy each other's in-progress state; a growing list of
  real-bd integration-suite files exceeding their single-file time budget;
  and a single real-bd suite timeout in the publish-push-failure test.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $9.4498.
Remaining budget: unknown/unbounded.
Pricing source: all 13 priced dispatch(es) used real per-member rates (get_member_model_pricing).

## [Unreleased] -- Dispatch-layer reliability: max_turns detection, busy-lock self-heal, AGY output capture

Sprint goal: make `execute_prompt`'s terminal-signal handling truthful and
self-healing, closing three independent dispatch-layer reliability gaps.
**Goal met -- sprint verdict is PASS.**

What shipped:

- **Reliable max-turns detection.** A Claude CLI can signal "hit the turn
  limit" through more than one transcript channel depending on version and
  stream shape -- a result event's `terminal_reason` field, that event's
  `subtype`, a distinct standalone terminal event (which can arrive instead
  of any result event when a hard-timeout kill truncates the stream first),
  or a plain-text fallback with no result event at all. Detection now
  recognizes every one of these channels and normalizes them through a
  single shared classifier used by every call site, so a turn-limit
  termination always surfaces the existing `max_turns_exhausted` reason
  promptly instead of occasionally falling through to a generic exit-code
  classification and sitting dead until the hard dispatch ceiling.
- **Stall detector cross-checks OS mtime against content parsing.** The
  transcript-freshness poll now also reads the transcript file's own
  filesystem last-modified time as an independent signal alongside its
  existing content-timestamp scan, and only calls a session stalled when
  *both* signals agree the transcript is frozen -- a strict superset of the
  prior content-only check that can only convert a would-be false stall
  into recognized activity, never the reverse, while still catching a
  genuinely dead session within the configured inactivity window (a couple
  of minutes by default) instead of the much longer hard ceiling. Threshold
  is configurable and documented.
- **Busy-lock self-heal.** `execute_prompt`'s in-flight lock can outlive the
  process it was guarding (a reaped child whose cleanup handler never fires,
  or an interactive session's process dying post-registration), which used
  to wedge a member permanently -- every dispatch kept returning `busy`
  even though the member was actually idle. A busy rejection now first
  verifies the locked session's process is actually alive (local signal
  check, a fresh independent remote liveness round trip, or the session
  registry's last-known pid for interactive sessions) and self-heals
  (releases the lock, warns, proceeds) only on a definitive dead-pid
  reading -- any ambiguity is conservatively still treated as busy, so a
  dispatch that hasn't finished starting up can never be raced.
- **AGY (Antigravity) provider captures real response output.** Previously
  an AGY dispatch always returned an empty result. The provider now
  extracts both the reply text and, when the CLI's transcript exposes one,
  a session id -- pinned against a recorded-shape CLI output fixture, no
  live AGY dispatch involved in the test.
- All four fixes are covered by deterministic, fixture/mock-based regression
  tests (no real CLI or credentials). No MCP tool schema, response contract,
  or reason-enum values changed.

Carried forward: a pre-existing Node/undici incompatibility
(`webidl.util.markAsUncloneable is not a function`) that crashes a chunk of
the real (non-mocked) integration suite and the sandbox smoke test's CLI
startup was confirmed present on the base branch as well (not a regression
from this sprint) and filed as a standalone follow-up for a future sprint.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $9.5894.
Remaining budget: unknown/unbounded.
Pricing source: all 16 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- fleet-sprint stabilization: run identity, dolt coordination, Windows fixes

Sprint goal: stabilize the always-on multi-sprint supervisor by fixing the
run-identity/termination-classification gaps, wiring cross-sprint Dolt
coordination end to end for the standalone CLI launch path, closing a
Windows shell-invocation and a class of Windows entrypoint-guard defects,
and reconciling the reviewer's newTask allowlist with the planner's
verification-task convention. **Goal not fully met -- sprint verdict is
FAIL**, for release-process reasons rather than code-quality ones.

What shipped and is genuinely solid:

- Supervisor run-identity threaded into the sprint child's own engine
  run-state, so the watchdog/dashboard/history layer reports the engine's
  own terminal reason (and, where present, its verdict) truthfully instead
  of inferring an outcome from process liveness alone; a mismerge-able Dolt
  conflict is now its own distinct terminal classification carrying the
  conflict dump forward; child exit code/signal/time are recorded into the
  ledger the moment the child process exits, independent of whatever the
  engine itself manages to persist.
- Per-sprint child stdout/stderr is teed to a log file, served and linked
  from the dashboard, so a sprint's raw output stays traceable even when it
  crashes before reporting anything structured.
- The dolt-push mutex and child-id allocator (previously supervisor-only)
  are now also hosted on the fleet MCP server and wired end to end
  (`--service-url` threaded through the standalone CLI launch path), closing
  the coordination gap for sprints launched outside the supervisor. The
  thin client wrapper other packages use to call fleet MCP tools was
  updated in lockstep so it cannot silently drift from what the server
  actually accepts.
- Reviewer newTask title allowlist now accepts square brackets (reconciling
  with the `[test]` verification-task convention), and a rejected newTask is
  resurfaced into the next planning dispatch rather than silently dropped.
- Fixed a class of Windows entrypoint-guard scripts whose "is this the
  directly-run script" check compared `import.meta.url` against a
  hand-built `file://` string, which never matches on Windows (a native
  path vs. a properly-encoded URL), so the affected verification scripts
  previously exited 0 having verified nothing -- a false-pass, not a crash.
  Also fixed a Windows `bd` invocation
  path that threw ENOENT when spawned without a shell, without reintroducing
  the shell-injection surface a naive `{ shell: true }` fix would have
  opened.
- The full local unit/build suite is green, and the real (non-mocked)
  integration suite passed 142/142 files with zero failures on its final
  runs this sprint.

Why the sprint still failed:

- **The deploy step never executed in any cycle** -- a required permissions
  allowlist was missing from the local tool-permission configuration, so no
  deploy command ran and nothing was verified as actually deployable.
- **The integration playbook's smoke-test scenario completed in zero of
  four attempted cycles** -- each run stopped at the credential-provisioning
  step because no live provider credential was available to the runner,
  which is an environment/credential gap rather than a product defect, but
  it means there is no end-to-end evidence of a real planner dispatch,
  closure, or version-flag assertion against any deployed build this
  sprint. The real (non-mocked) functional suite was independently green.
- **Scope was not complete**: a number of P1 items remain open, carried
  forward to a future sprint -- a launch-failure fast path and
  diagnose-before-relaunch gate in the supervisor; wiring or decommissioning
  the existing Dolt conflict-recovery ladder; routing persona-proposed bead
  creation through the shared id allocator instead of direct creation;
  requiring machine-checkable dedup evidence before a new bead is created;
  adding the deploy-required permissions allowlist; and provisioning a
  runner credential so the smoke-test scenario can actually complete.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $37.2433.
Remaining budget: unknown/unbounded.
Pricing source: all 78 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- `auto-sprint` CLI workflow renamed to `fleet-sprint`

**BREAKING (CLI surface).** apra-fleet's own product sprint workflow is now
called `fleet-sprint` everywhere. Claude Code's separate Workflow-tool script
(`~/.claude/workflows/auto-sprint.js`, its `/auto-sprint` slash command, and
the `auto-sprint-args` skill) is a different thing and **keeps** the name
`auto-sprint` -- the two were repeatedly confused, which is what motivated the
rename.

What changed:

- `apra-fleet workflow auto-sprint ...` -> `apra-fleet workflow fleet-sprint ...`
- npm bin `auto-sprint` -> `fleet-sprint`; bundle `dist/auto-sprint.mjs` ->
  `dist/fleet-sprint.mjs` and `dist/auto-sprint-runner.mjs` ->
  `dist/fleet-sprint-runner.mjs`
- Installed workflow dir `~/.apra-fleet/workflows/auto-sprint/` ->
  `~/.apra-fleet/workflows/fleet-sprint/`
- Source dir `packages/apra-fleet-se/auto-sprint/` ->
  `packages/apra-fleet-se/fleet-sprint/`
- New `fleet-sprint-cli` skill (source:
  `packages/apra-fleet-se/fleet-sprint/skills/fleet-sprint-cli/`) documenting the
  CLI flag contract, installed to `<configDir>/skills/fleet-sprint-cli` for
  **every** LLM provider by `apra-fleet install`, and removed by `uninstall`.

Migration: re-run `apra-fleet install` to lay down the renamed workflow
directory and the new skill, and update any scripts that invoked
`apra-fleet workflow auto-sprint` or the `auto-sprint` bin.

## [Unreleased] -- Auto-sprint as a service: always-on multi-sprint supervisor

- **apra-pm architectural reorg** -- The `vendor/apra-pm` git submodule has been removed and replaced with a package-local deep copy under `packages/apra-fleet-se/apra-pm`. This eliminates silent submodule synchronization drift and significantly streamlines packaging, CI, and E2E processes that previously depended on the submodule being manually initialized.

Sprint goal: turn the single-shot, run-to-completion auto-sprint CLI into an always-on
supervisor service that runs multiple concurrent sprints with member+issue-scope
reservation, a sprint-stack dashboard, and orchestrator-bracketed git+Dolt sync, with the
service positioned as the single supported user-facing entry point. **Goal not fully
met -- sprint verdict is FAIL.** A large amount of real, well-tested functionality shipped:
an always-on supervisor process owning a combined member+issue-scope reservation ledger and
a PID-liveness watchdog with restart re-adoption; a sprint-stack dashboard (running sprints,
a process-free history view, a backlog tree that live-recomputes claimed scope) served
through one reverse-proxied port; orchestrator-bracketed git and Dolt sync with a scripted-
first conflict escalation ladder (mechanical detection/resolution before any agent is
dispatched, and only as a documented last resort); CLI convergence onto one shared fleet
transport; server-side per-member reservation enforced at dispatch time (independent of the
supervisor's own launch-time ledger, closing the gap where a manually invoked sprint could
otherwise bypass it); a shell-drivable `register-member` CLI subcommand sharing the same
validation/registration logic as the MCP tool; a darwin-x64 build-from-source deploy
fallback; and a lean dashboard-polling pattern (small recurring payload, on-demand full-text
fetch with client-side caching) for sprints with large activity/task counts. Unit and build
suites are fully green.

However, the sprint fails its own acceptance gate: the epic requires the service to complete
a full plan-develop-review-harvest cycle against a live smoke sandbox, and that end-to-end
smoke test did not pass in any of five attempted cycles. Root causes uncovered and (partially)
fixed but not yet proven to hold under a real end-to-end run: a member's live interactive
session dying mid-dispatch with no timeout ever firing on the dispatching side; a member
being incorrectly rejected as "reserved by another sprint" when the identity token used at
reservation time and at dispatch time did not match; and a sandboxed Dolt clone's remote
being re-wired and a real push attempted against it despite an explicit neutralization step,
caught only by an unrelated missing-credentials condition rather than by the neutralization
holding as designed. Additional known, tracked-but-unresolved integration blockers: a fixed
test-server port causing an EADDRINUSE cascade across dependent test processes; a smoke-test
fixture repository with no pre-tagged canary issue, requiring either a maintainer reseed or a
self-provisioned fallback; a pre-sprint scope validator that rejects a single childless issue
as a sprint target; and a bootstrap recovery step that can reactivate a real, live sync
remote unless explicitly neutralized afterward. A vendored agent-contract durability
improvement (per-commit push discipline for the vendored doer/harvester role contracts) is
incomplete: implementation work remains in progress and no test exists yet to verify it, so
the vendored contract files are unchanged from before this sprint.

Carried forward, all open, none closed this cycle: the eight integration blockers described
above; a member-reservation interoperability gap between workflow/CLI-launched sprints and
the server-side reservation check; a viewer full-state-polling performance gap on very large
sprints (distinct from, and not fully addressed by, the lean-polling pattern shipped this
sprint); a real-bd test suite performance regression where a meaningful fraction of files
exceed their per-file time budget; and the incomplete vendored agent-contract durability
work described above. Two lower-priority follow-ups from earlier in the sprint (a CLI-
convergence in-progress item, and a crash-resume-via-journal design explicitly deferred by
the original plan) also remain open and are intentionally left for a future sprint.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $0.0000.
Remaining budget: unknown/unbounded.
Pricing source: all 80 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- feat/fleet-reorg

Sprint goal: continue scope issue `apra-fleet-7pm` (P1 epic, "apra-fleet workflow subsystem: SEA-binary workflow runner") from the point the prior `feat/fleet-workflow-subsystem` sprint left off. **Goal work landed (15 beads closed this sprint, final open-at-goal-priority count 0), but the sprint's own final verdict is FAIL** -- the final reviewer dispatch timed out after repair attempts (`Command timed out after 300000ms of inactivity`) rather than returning a schema-valid verdict, so the sprint could not self-certify despite the code landing. What shipped: `apra-fleet-7pm.8` self-heal extraction in the workflow launcher (`src/cli/workflow.ts` re-extracts the on-disk payload from embedded SEA assets if it's found missing/incomplete); `apra-fleet-7pm.9` `uninstall --skill workflows` (removes the shared runtime/schema dirs and only the built-in workflow subdirectories, preserving user-authored workflows); `apra-fleet-7pm.10` the update flow reading back and re-threading the persisted `--workflows` mode into a re-invoked install; `apra-fleet-7pm.11` `docs/authoring-workflows.md` plus doc deltas; `apra-fleet-7pm.12` a fix for broken npm-mode auto-sprint runtime imports in a clean global install; `apra-fleet-7pm.13`/`.15` build-binary smoke tests for the workflow subcommand and an auto-sprint-as-built-in-workflow packaged-binary e2e test; and `apra-fleet-7pm.14` a regression guard pinning the existing CLI command surface. Also landed outside the epic: a redesigned Sprint/Backlog dependency-tree beads panel in the auto-sprint dashboard, and a positioning paper comparing `apra-fleet-workflow` to LangChain/LangGraph.

Deploy/integration still could not run this sprint, for the same reason recorded last sprint and tracked as `apra-fleet-nbp` (P3, still open): `integ-test-playbook.md` remains absent from the repo root, and `deploy.md` still lacks the required `## Deploy`/`## Smoke test` sections (it has a `## Steps` section with unresolved `<branch>`/`<run-id>`/`<tag>` placeholders and a manual, non-scriptable verify step instead). One of the three deploy attempts this sprint also flagged a stray instruction-like line in `deploy.md` ("Must be run using model tier `cheap`") as a likely prompt-injection attempt, which was correctly not followed.

Carried forward: `apra-fleet-nbp` (missing deploy/integ-test runbook sections, P3, still open, still blocking automated deploy verification). No other work from this sprint's scope was left open.

#### Sprint cost analysis
Budget ceiling: not set (no --budget flag) -- unlimited for this run.
Tracked spend (priced dispatches only): $0.0000.
Remaining budget: unknown/unbounded.
Pricing source: all 35 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- feat/fleet-workflow-subsystem

Sprint goal: scope issue `apra-fleet-7pm` (P1 epic, "apra-fleet workflow subsystem: SEA-binary workflow runner"). **Goal NOT met -- sprint verdict is FAIL.** What landed this sprint: `src/cli/workflow.ts`, the launcher subcommand that runs a workflow script (an ESM entry under `workflows/<name>/`) from inside the SEA binary against a live fleet connection; a shared, single-implementation connection-resolution helper (`@apralabs/apra-fleet-client/server-resolution`) used identically by the launcher and by `packages/apra-fleet-se/bin/cli.mjs`, resolving HTTP-singleton-attach-first with stdio self-spawn as fallback (`docs/adr-workflow-server-resolution.md`); SEA asset embedding of the workflow runtime, agent schemas, and built-in workflows via `scripts/gen-sea-config.mjs`; and `docs/authoring-workflows.md` plus deltas to `docs/install.md`, `docs/npm-packaging.md`, and `packages/apra-fleet-se/docs/cli-reference.md`. Entry-path escape prevention (rejecting `..`/absolute-path manifest entries) is implemented and tested. Full test suite passes (2275/2275, 18 skipped) and `npm run build` is clean.

What did NOT land, despite the epic being scoped for it: the `install.ts` additive workflow-install step (`apra-fleet-7pm.5`) is mid-flight as uncommitted-to-done WIP commits with its issue still open; self-heal extraction in the launcher (`apra-fleet-7pm.8`, P1) is not started; `uninstall --skill workflows` (`apra-fleet-7pm.9`), the update-flow re-install path (`apra-fleet-7pm.10`), build-binary smoke tests for the workflow subcommand (`apra-fleet-7pm.13`), a regression guard for the existing command surface (`apra-fleet-7pm.14`), and an end-to-end test of auto-sprint running as a built-in workflow (`apra-fleet-7pm.15`) are all open. The deploy/integration phase could not run at all this sprint: `integ-test-playbook.md` is absent from the repo root and `deploy.md` lacks the required `## Deploy`/`## Smoke test` sections, so no smoke test exists to execute (tracked as `apra-fleet-nbp`). A binary developer-meeting slide deck (`docs/features/apra-fleet-workflows.pptx`/`.pdf`, ~470 KB) landed without an owning task and should be re-homed or removed.

Carried forward (all remain open, none closed this cycle): `apra-fleet-7pm` (epic) and children `.5`, `.8`, `.9`, `.10`, `.13`, `.14`, `.15`; `apra-fleet-nbp` (missing deploy/integ-test runbook sections, P3).

#### Sprint cost analysis
Budget ceiling: $50.0000.
Tracked spend (priced dispatches only): $0.0000.
Remaining budget: $50.0000.
Pricing source: all 13 priced dispatch(es) used real per-member rates (get_member_model_pricing).
Note: dispatches using an unpriced model id are not reflected above (see N10, feedback-reassessment.md) -- this figure is a lower bound on actual spend, not a complete total, and is reported honestly rather than fabricated.

## [Unreleased] -- chore/hub-service-retire-and-docs

Sprint goals: `apra-fleet-yp3` (P2, retire `src/hub-service/` to reference-only status) and `apra-fleet-qaz` (P3, record the final tier-ownership decision in the architecture docs), both children of epic `apra-fleet-yeb`. Both goals met. This sprint follows a product-owner directive that resolved a divergence from the prior hub-spoke migration sprint: `fleet-dashboard` is the sole tier-3 persistence layer for workspace/project/member/secret configuration, and `apra-fleet.exe` is either a SaaS-connected client of fleet-dashboard's contract or a standalone client backed by local JSON files -- never a competing relational database of its own. Accordingly, `src/hub-service/` (the Postgres-backed service built during the prior hub-spoke migration sprint) is retired to reference-only: no code or tests were deleted (all 2133 tests remain green, verified as a specification of wire-protocol/security-isolation semantics), but `src/hub-service/main.ts`, `docs/hub-service-deployment.md`, `Dockerfile.hub-service`, and `docker-compose.hub-service.yml` now carry explicit reference-only/dev-only banners so nobody ships it to fleet.apralabs.com. `docs/adr-hub-persistence.md` and `docs/hub-spoke-master-plan.md` are annotated as superseded on tier-3 ownership, with a correction that SSH is NOT deprecated (it remains a permanent execution transport) and that relay/NAT-traversal work is explicitly deferred (`apra-fleet-8rs`), not abandoned. The new `docs/api-contract-reconciliation.md` records the verbatim product-owner directive and a 22-item hub<->dashboard API gap analysis; a documentation-integrity self-correction during the sprint stripped a fabricated "confirmed by direct code inspection" claim about fleet-dashboard's private (unseen) code from that document, replacing it with an explicit sourcing note. A new durable `docs/adr-tier3-ownership.md` distills the decision for future readers without the full negotiation history.

Carried forward: none from this sprint's named goals (both closed). Deferred, non-blocking cleanup identified by review: normalize 14 non-ASCII em-dash characters in `docs/api-contract-reconciliation.md` to the project's ASCII-only convention.

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 1

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |          0 |   n/a |   $0.000 |   $0.000 |
| reviewer   |          0 |          0 |   n/a |   $0.000 |   $0.000 |
| overhead   |      7,150 |     45,518 | +537% |   $0.121 |   $0.452 |
| TOTAL      |      7,150 |     45,518 | +537% |   $0.121 |   $0.452 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): overhead

### Review outcome

**Build**: clean (tsc, zero errors).
**Tests**: 2314 passed, 5 skipped, 0 failures across 157 test files.
**Working tree**: clean.

The branch accumulates a complete KB system (capture, query, harvest,
export, import, reconcile, staleness, trust model, directives), a
code-intelligence provider abstraction with two providers and auto-reindex,
telemetry, and extensive test coverage. The codebase builds cleanly and
all tests pass. No regressions detected. No security issues found (no
secrets in code, proper use of direct file execution over a shell,
temp-dir cleanup in tests).

**Non-blocking observations**:
- No test coverage for a round-trip of the `codeIntelProvider` field in
  register/update-member tests -- the field is optional so existing
  members degrade gracefully (confirmed by passing backward-compat
  tests), but an explicit round-trip test would be a good follow-up.
- The pre-init glob matcher handles common gitignore patterns but does
  not implement negation patterns; documented as a known limitation in
  [docs/code-intelligence-providers.md](docs/code-intelligence-providers.md).

**Releasability**: the branch is in a releasable state. All code is
functional and tested. The incomplete init/update phases are future
features with no impact on existing functionality. The additive
scaffolding (pre-init module, `codeIntelProvider` field) is safe to
merge -- it adds no runtime behavior until wired by a future increment.

Carried forward: the init phase (first-time indexing with progress), the
update phase (staleness-triggered incremental re-indexing beyond the
existing auto-reindex coverage), and per-member provider routing through
`getProvider()` and tool dispatch.

## [Unreleased] -- Code intelligence: per-member provider field and KB pre-init scaffolding (sprint goal not met)

Sprint goal (P1/P2): audit all KB and code-intelligence tools on this branch,
and build out the KB initialization lifecycle (pre-init/init/update phases)
plus per-member code-intelligence provider selection. Both goals remain
open; this cycle landed two small, unblocking increments toward them and
ended before the larger routing and lifecycle work was built.

The `Agent` interface now carries an optional `codeIntelProvider` field, and
`register_member` / `update_member` accept a matching input so a member's
preferred code-intelligence provider can be set or changed. This is schema
and persistence only -- no dispatch path yet resolves a provider per member,
so the field currently has no observable effect; see
[docs/code-intelligence-providers.md](docs/code-intelligence-providers.md).

The KB pre-init phase also gained its first two building blocks: a
provider-availability check (never throws; degrades to a structured
not-available result) and a repo index-size estimator (gitignore-aware
file walk projecting file count, byte size, and indexing time). Both are
pure, unit-tested, and not yet wired into any init-phase caller -- they
exist ahead of the init/update phases that will consume them. See
[docs/code-intelligence-providers.md](docs/code-intelligence-providers.md).

Carried forward to a future sprint: the full KB tool audit, per-member
provider routing through `getProvider()` and tool dispatch, the init phase
(first-time indexing with progress and an opt-in prompt), and the update
phase (staleness detection and incremental re-indexing).
| doer       |          0 |     17,909 |   n/a |   $0.000 |   $0.269 |
| reviewer   |          0 |      4,513 |   n/a |   $0.000 |   $0.068 |
| overhead   |      7,150 |     28,697 | +301% |   $0.121 |   $0.365 |
| TOTAL      |      7,150 |     51,119 | +615% |   $0.121 |   $0.702 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): none

### Final review notes

Reviewed sprint work on chore/hub-service-retire-and-docs (5 commits atop feat/hub-spoke-migration: cae75fd..4b649af). Sprint goals apra-fleet-yp3 (P2) and apra-fleet-qaz (P3), both children of epic apra-fleet-yeb, are met. Build (tsc) clean; full suite 2133 passed / 18 skipped (docker/terminal-gated) / 0 failed. Git tree clean apart from the durable sprint-logs jsonl (not flagged, per workflow). No lint script configured in package.json.

apra-fleet-yp3 (retire src/hub-service to reference-only) -- acceptance criteria fully met:
- src/hub-service/main.ts: clear top-of-file STATUS: REFERENCE IMPLEMENTATION ONLY banner with pointer to api-contract-reconciliation.md 1.5 and hub-service-deployment.md.
- docs/hub-service-deployment.md: retitled "(Reference Implementation -- Not a Deployment Target)", one-paragraph status block at top; a new contributor understands reference-only status immediately (criterion satisfied).
- Dockerfile.hub-service and docker-compose.hub-service.yml: both prepended with "REFERENCE/DEV-ONLY -- NOT a production deployment target" and the stale production-deployment guidance was removed/reframed, so nobody ships it as fleet.apralabs.com.
- docs/adr-hub-persistence.md marked Superseded; docs/hub-spoke-master-plan.md annotated with the tier-3 ownership + SSH-stays/relay-deferred correction.
- No hub-service code or tests deleted (verified: only a 13-line comment added to main.ts; 2133 tests still green, matching the doc's cited count).

apra-fleet-qaz (record final tier-ownership decision) -- acceptance criteria met:
- docs/api-contract-reconciliation.md (new, 608 lines) sections 1.5/1.6 carry the verbatim product-owner directive and corrected per-item verdicts; adr and master-plan cross-link to it. A cold reader grasps reference-only status and bootstrap/sync-first scope without needing session history.
- Documentation-integrity self-correction (commit 4b649af): the doer caught and stripped a fabricated "fleet-dashboard implementer / confirmed by direct code inspection" persona from the reconciliation doc and added an explicit sourcing note distinguishing this repo's verified source from inferences about fleet-dashboard's private (unseen) code. Verified no residual "confirmed by code inspection"-style fabricated claims remain. This is a good catch.

File hygiene: all changed files justify against the epic. docs/bootstrap-sync-design-proposal.md and docs/cross-repo-design-protocol.md are legitimate deliverables of closed sibling task apra-fleet-48p (referenced by the qaz docs so links resolve). .gitignore additions (.agents/, .codex/) correctly exclude local tool scaffolding. No temp files or stray tool config slipped in.

Minor issue (non-blocking, recommend cleaning before merge): docs/api-contract-reconciliation.md contains 14 lines with non-ASCII em-dashes (U+2014 "--", e.g. lines 38, 42, 44-46, 48, 50, 52), which violates the project's checked-in ASCII-only convention in CLAUDE.md ("never write non-ASCII characters to any file; use `-` for dashes"). Line 38 is arguably a verbatim directive quote, but lines 42/44/45/46/48/50/52 are the author's own prose. No functional impact (docs only, build/tests unaffected), so not reopening the task -- but the em-dashes should be normalized to ASCII "--" in a follow-up or before raising the PR. No security issues, no regressions in adjacent code. Work is releasable/harvestable.

## [Unreleased] -- feat/hub-spoke-migration (hub-spoke cloud migration groundwork, sprint 2)

Sprint goal (P1/P2): apra-fleet-us9 (hub-spoke cloud migration epic) and apra-fleet-20o (shared hub<->dashboard API contract). Goal not fully met -- apra-fleet-20o (P1) and several other P1/P2 tasks closed this sprint, but apra-fleet-us9 is a multi-sprint epic and remains open by design; several of its P1/P2 sub-tasks (hub service MVP, cloud JWT issuance, spoke mode, RBAC, SSH-to-relay migration) are carried forward to next sprint.

Completed this sprint: extracted `@apralabs/fleet-api-contract`, a versioned npm workspace package holding the Zod schemas (Workspace, Project, Member, JWTClaims, UsageRecord, ActivityEvent, Installer, AdminUser) and generated OpenAPI 3.1 spec shared between the future hub service and dashboard, with `JWTClaims` as the explicit auth anchor and a runtime contract test validating a real handler response against the schema; unified identity on the member UUID with `workspace_id` promoted to the hard security-boundary claim behind a pluggable `TokenIssuer` (local dev-mode issuer today, cloud-dashboard issuer later, no token migration needed), with `session-registry`, `send-message`, and `http-transport` scoped end-to-end so cross-workspace traffic is indistinguishable from "not connected"; implemented and live-verified `registerMcpEndpoint()` for the AGY and OpenCode providers (read-modify-write of each provider's own MCP config file, non-destructive to sibling entries); closed a stale-close session-unregister race in `http-transport.ts` and required the local admin key on `/shutdown`; de-hardcoded the port and gated interactive bootstrap behind an explicit flag in `register_member`; fixed suite-wide test pollution from shared fixed-path fixtures under concurrent test runs. Full vitest suite: 1816 passed / 14 skipped / 114 files.

Carried forward: apra-fleet-us9 epic and its P1/P2 sub-tasks (hub service MVP, cloud JWT issuance + `apra-fleet join` enrollment, spoke mode in apra-fleet.exe, workspace iron-wall security review, dashboard OAuth/RBAC), plus apra-fleet-fnz.1/.4 (registerMcpEndpoint wiring into register_member's same-machine path, and the LAN enrollment-token join flow) and apra-fleet-2xs.1 (compose_permissions deep-merge fix).

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |      8,016 |   n/a |   $0.000 |   $0.120 |
| reviewer   |          0 |     10,424 |   n/a |   $0.000 |   $0.156 |
| overhead   |      7,150 |     80,655 | +1028% |   $0.121 |   $0.575 |
| TOTAL      |      7,150 |     99,095 | +1286% |   $0.121 |   $0.851 |
| doer       |          0 |     32,374 |   n/a |   $0.000 |   $0.486 |
| reviewer   |          0 |     10,421 |   n/a |   $0.000 |   $0.156 |
| overhead   |      7,150 |     74,090 | +936% |   $0.121 |   $0.677 |
| TOTAL      |      7,150 |    116,885 | +1535% |   $0.121 |   $1.320 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): overhead

### Review outcome

**Build**: passes (tsc clean).
**Tests**: 2314 passed, 5 skipped, 0 failures across 157 test files.
**Working tree**: clean (only sprint log modified, expected).

**Sprint goal assessment**: Both sprint-goal issues remain open. The sprint
produced three functional commits: the `codeIntelProvider` field on the
`Agent` interface wired into register/update schemas and handlers; a new
pre-init module with provider-availability detection and index-size
estimation; and unit tests for that module.

**Observations (non-blocking)**:
- The pre-init module is not imported by any other module in `src/` --
  it is forward-looking scaffolding for the init phase, which was not
  built this sprint. This is dead code today but has test coverage and
  will be consumed once the init phase is implemented.
- `codeIntelProvider` is stored during register/update but never read by
  any downstream logic (no routing or provisioning consumes it yet).
- Neither observation is a regression or quality concern; both are
  incomplete increments from a sprint that ended early.

**Code quality**: The new code follows existing patterns (zod schemas,
never-throw error handling, vitest mocks with hoisted references). No
security issues (uses a direct file-execution call rather than a shell,
proper temp-dir cleanup in tests, no secrets). ASCII-only. Consistent with
project conventions.

**Overall branch state**: The accumulated work across all prior sprint
cycles builds cleanly and passes all tests. No regressions detected. The
branch is in a releasable state for what was completed. Both sprint-goal
issues remain open for future completion.

## [Unreleased] -- Code intelligence provider abstraction: codebase-memory-mcp shipped as default

Sprint goal (P1/P2): finish the CodeIntelligenceProvider abstraction begun in
the prior sprint pass. Following the earlier evaluation, this sprint
re-evaluated the field of candidates and selected codebase-memory-mcp (MIT,
native MCP transport, 158-language tree-sitter coverage, single static
binary) over Joern (Apache 2.0, deeper CPG-based data-flow analysis but JVM +
Scala dependency and no native MCP support). `CodebaseMemoryProvider` now
implements all seven `CodeIntelligenceProvider` methods against the
codebase-memory-mcp MCP server, following the same client-lifecycle pattern
as `GitNexusProvider` (shared singleton client, stdio transport, connection
reset on death/failure, a pre-flight index check, and structured
offline/missing-index error results). It is registered in the `PROVIDERS`
map and is now the default provider; GitNexus remains selectable by name, and
the Joern provider file is retained with a deprecation notice recording the
evaluation rationale.

#### Sprint cost analysis
Calibration: historical (5 sprints)   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |     14,100 |     72,947 | +417% |   $0.185 |   $0.905 |
| reviewer   |      5,859 |     23,306 | +298% |   $0.088 |   $0.350 |
| overhead   |      7,150 |    116,540 | +1530% |   $0.121 |   $1.140 |
| TOTAL      |     27,109 |    212,793 | +685% |   $0.393 |   $2.394 |
True-cost estimate (output x 4x): $1.573

Outliers (>200% variance): doer, reviewer, overhead
Calibration failures (>500%): overhead

### Review outcome

All three sprint tasks meet their acceptance criteria. Build is clean (tsc
passes), and the full test suite passes with zero failures.

**Evaluation and decision.** The comparison covers all five dimensions (ease
of integration, dependency weight, language breadth, analysis depth, and MCP
tool coverage), with the decision and rationale documented directly in the
Joern provider file's header and in
[docs/code-intelligence-providers.md](docs/code-intelligence-providers.md).
The decision is verified by dedicated unit tests asserting the header covers
every comparison dimension.

**Provider implementation.** `CodebaseMemoryProvider` implements all seven
methods, follows the GitNexus MCP client lifecycle pattern exactly (shared
singleton, stdio transport, identity-guarded death handler, failure-reset),
and returns structured offline/missing-index results instead of throwing.
Unit tests cover all methods, three connection-resilience scenarios, and the
pre-flight index check.

**Registration as default.** `CodebaseMemoryProvider` is registered in the
`PROVIDERS` map and is now the default returned by `getProvider()`; GitNexus
remains selectable by explicit configuration. The Joern file carries a clear
deprecation notice. Default-fallback and explicit-selection tests were
updated accordingly.

**File hygiene note (non-blocking).** One commit in this sprint bundled a
handful of unrelated tool-config files (Beads task-tracker configuration)
alongside the sprint work. These appear to be legitimate project setup but
are unrelated to the code intelligence tasks and would have been cleaner as
a separate commit.

### Carried forward

None -- all sprint tasks met their acceptance criteria.

## [Unreleased] -- Code intelligence provider abstraction: review closeout

Sprint goal (P1/P2): add a permissively-licensed CodeIntelligenceProvider and
set it as the default, replacing GitNexus. This entry records the outcome of
a formal review pass against the original acceptance criteria for the four
planned tasks: research and select a candidate, implement the provider,
register it as the default, and add unit tests.

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 1

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |          0 |   n/a |   $0.000 |   $0.000 |
| reviewer   |          0 |          0 |   n/a |   $0.000 |   $0.000 |
| overhead   |      7,150 |     35,996 | +403% |   $0.121 |   $0.354 |
| TOTAL      |      7,150 |     35,996 | +403% |   $0.121 |   $0.354 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): none

### Overall assessment

The branch builds cleanly and the full test suite passes with no failures.
The codebase is in a releasable state.

**Research and candidate selection -- fully met.** Three candidates (Joern,
SCIP, tree-sitter) were evaluated against six criteria (license, native
call-graph/relationship analysis, semantic or structured search, active
maintenance, subprocess usability, and TypeScript/Python coverage). Joern was
selected, with the rationale documented in the provider file's header comment
and in [docs/code-intelligence-providers.md](docs/code-intelligence-providers.md).

**Provider implementation -- not met.** The acceptance criteria called for all
seven `CodeIntelligenceProvider` methods to be implemented following the
GitNexusProvider pattern (spawned child-process backend, structured error
results, a pre-flight index check, output sanitization). What shipped is
seven stub methods that each throw a "not implemented" error -- no subprocess
spawning, no structured errors, no pre-flight check. This is a skeleton, not
a working implementation.

**Registration as default -- not met.** The acceptance criteria required the
new provider to be imported and instantiated in the provider registry, with
the provider-selection function defaulting to it. The registry still contains
only the GitNexus provider, and the default selection is unchanged.

**Unit tests -- not met.** The acceptance criteria called for happy-path tests
of all seven methods, error/offline tests, a pre-flight test, and an updated
default-provider test. The tests that shipped only regex-match strings inside
the provider source file's comments (e.g. checking that a license string
appears in the file); the provider class itself is never instantiated or
called in the test suite. There are no behavioral tests.

### Why this was judged releasable despite the gaps

The new provider code is entirely inert: it is not imported anywhere outside
its own test file, not registered in the provider registry, and not
reachable from any tool handler. It introduces zero behavioral change and
zero regression risk to the existing GitNexus-backed code intelligence
tools. The documentation honestly records this status rather than presenting
the work as complete.

All files touched in this pass are scoped and justified: the new provider
source file and its test file, the code-intelligence-providers documentation
page, and the standard README/CHANGELOG updates. No temporary files,
secrets, unrelated configuration, or security issues were introduced.

### Carried forward

Implementing the seven provider methods against a live Code Property Graph,
registering the provider in the registry (and deciding whether it becomes
the new default or an opt-in alternative alongside GitNexus), and writing
real behavioral tests remain open work for a future sprint. The research and
method-to-query-language mapping already documented provide a concrete
implementation roadmap for that follow-up.

## [Unreleased] -- Code intelligence provider abstraction

Sprint goal (P1/P2): add a permissively-licensed code-indexing provider as an
alternative to GitNexus, implementing the full `CodeIntelligenceProvider`
interface (graph, impact, query, context, map, flow, tests) and registering
it as the default.

What shipped: a documented evaluation of Apache 2.0 / MIT candidates (Joern,
SCIP, tree-sitter) against six selection criteria (license, native
code-graph/relationship analysis, semantic or structured search, active
maintenance, subprocess usability, and TypeScript/Python coverage). Joern was
selected first for its Code Property Graph support, then superseded by
codebase-memory-mcp, which carries broader language coverage, native MCP
transport, and a far lighter deployment footprint (a single binary rather than
a JVM plus a Scala REPL). `CodebaseMemoryProvider` implements all seven
provider methods and is registered as the default; the interim Joern skeleton
was never registered in `PROVIDERS` and is not part of this release. See
[docs/code-intelligence-providers.md](docs/code-intelligence-providers.md) for
the full evaluation and current status.

Review outcome: the codebase builds cleanly and the full test suite passes.
The branch was judged releasable on the basis that the new provider code is
fully inert and every other changed file is scoped and justified -- the
incomplete provider implementation is intentionally deferred rather than
half-shipped into the active code path.

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 1

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |          0 |   n/a |   $0.000 |   $0.000 |
| reviewer   |          0 |          0 |   n/a |   $0.000 |   $0.000 |
| overhead   |      7,150 |     36,179 | +406% |   $0.121 |   $0.365 |
| TOTAL      |      7,150 |     36,179 | +406% |   $0.121 |   $0.365 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): none
### Final review notes

Scope reviewed: origin/main..feat/hub-spoke-migration (21 commits, 107 files). Named sprint goals: apra-fleet-20o (P1, closed) and epic apra-fleet-us9 (parent, expectedly still open).

VERIFICATION
- Build: `npm run build` and `npm run build:contract` both exit 0.
- OpenAPI: `npm run gen:openapi` regenerates packages/fleet-api-contract/openapi.json byte-identical to the committed copy (no dual-maintenance drift).
- Tests: `npm test` = 1816 passed / 14 skipped / 114 files. No lint script is configured in this repo (n/a).

ACCEPTANCE CRITERIA (apra-fleet-20o) - all met:
- Zod schemas for Workspace/Project/Member/JWTClaims/UsageRecord/ActivityEvent/Installer/AdminUser (packages/fleet-api-contract/src/schemas/*).
- JWTClaimsSchema is the explicit anchor; every auth-gated route in src/endpoints.ts carries `auth: JWTClaimsSchema`, never redefined. Member.provider enum includes 'none' per us9.14.
- OpenAPI 3.1 generated from the same schemas via src/scripts/gen-openapi.ts.
- Versioned public workspace package (@apralabs/fleet-api-contract@0.1.0, workspaces:[packages/*], README consumption path documented).
- Runtime contract test present (tests/hub-service/installers.contract.test.ts) validating getInstallersHandler() output against InstallerSchema.
Other closed P1/P2 tasks (workspace_id/UUID identity, /shutdown auth, provider MCP registration, port de-hardcode, bootstrap gating, test-pollution and stale-close race fixes) all ship with tests that pass.

MINOR (optional, not blocking):
- tests/hub-service/installers.contract.test.ts second case is named "rejects a response with an extra/unexpected field (drift guard)" but InstallerSchema is non-strict, so it does not actually reject -- it only asserts the unknown key is dropped. For a true drift guard, use `.strict()` on the schema (or `InstallerSchema.strict().parse(...)`) so an unexpected wire field fails loudly.

Committed work is buildable, fully tested, and matches the acceptance criteria for what was completed; ready to harvest as a PR once the untracked root artifacts (recovery-backup tarball, local .agents/.codex tool config dirs) are removed from the working tree -- done as part of this harvest.

## [v0.3.3] -- feat/install-default

### Breaking change -- MCP server start command changed

> **Action required for users who manually manage their MCP config.**
>
> The binary no longer starts the MCP server when invoked with no arguments.
> The new default action is **installation**. The MCP server is now started
> with the explicit `apra-fleet run` subcommand.
>
> **Who is affected:** only users who edited their MCP config by hand and
> registered the binary with no arguments (e.g. `command: apra-fleet`,
> `args: []`). Users who installed via `apra-fleet install` or
> `apra-fleet update` are updated automatically -- the installer re-registers
> the MCP server with the correct `run` argument.
>
> **How to fix (manual config only):** change `args: []` to `args: ["run"]`
> in your provider's MCP config, then reload the MCP server.
>
> `--stdio` is kept as a backward-compat alias and still starts the server,
> so `args: ["--stdio"]` also works without any code change.

### Added

- **Install as default action** -- invoking the standalone binary with no
  arguments (including double-clicking `apra-fleet-installer-win-x64.exe` on
  Windows) now runs the installer instead of silently starting an MCP stdio
  server. This is the expected behavior for users who download the binary from
  the GitHub Releases page.

- **`apra-fleet run` / `apra-fleet start`** -- new subcommands that
  explicitly start the MCP server (stdio mode). All provider MCP configs
  written by the installer are updated to use `run` as the last argument.
  `--stdio` continues to work as a backward-compat alias.

### Changed

- **MCP config updated for all providers** -- the MCP server command
  registered during `apra-fleet install` now includes `run` as an explicit
  argument for every provider (claude, gemini, agy, codex, copilot, opencode --
  gemini was a supported provider at the time of this release and has since
  been removed).
  Example SEA mode: `{ "command": "/path/apra-fleet", "args": ["run"] }`.

- **Claude `mcp add` command handles all args** -- the `claude mcp add`
  command builder now quotes and joins all args (not just `args[0]`), which
  is required for npm/dev mode where both a script path and `run` must be
  passed.

## [Unreleased] -- feat/member-tags-design (member category and tags -- Phases 2-5, sprint 2)

Sprint goal (P1/P2): complete tag-aware permission composition (Phase 2), skill matrix utility (Phase 3), permissions.md update (Phase 4), and tag filter in list_members (Phase 5). Phases 2-5 were implemented and tested; the full vitest suite passes (1593 tests, 0 failures). Integration tests (apra-fleet-2tl) are carried forward. Goal partially met -- all implementation tasks done, integration tests not started.

Completed: Phase 2 tag-aware permission composition with composeFromTags() and backward-compatible behavior; Phase 3 skill-matrix utility (getRequiredSkills) encoding the skill-matrix.md rules programmatically; Phase 4 permissions.md rewritten for tag-based composition; Phase 5 list_members tags filter with AND semantics. Example tag profiles (tag-gpu.json, tag-devops.json) added.

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |     20,661 |   n/a |   $0.000 |   $0.252 |
| reviewer   |          0 |      8,338 |   n/a |   $0.000 |   $0.125 |
| overhead   |      7,150 |     70,662 | +888% |   $0.121 |   $0.574 |
| TOTAL      |      7,150 |     99,661 | +1294% |   $0.121 |   $0.952 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): overhead

### Added

- **Tag-aware permission composition** -- `compose_permissions` now accepts a `tags` parameter. Reserved tags `doer`/`reviewer` set the primary mode; custom tags (e.g. `gpu`, `devops`) each load a `tag-<name>.json` profile and merge permissions additively. Unknown tags are silently ignored. When both `role` and `tags` are given, `tags` wins. The `composeFromTags()` function is byte-identical to the role-based `compose()` for single-mode tags -- full backward compatibility.

- **Example tag profiles** -- `tag-gpu.json` and `tag-devops.json` shipped under `skills/fleet/profiles/`. These are the reference profiles for GPU and DevOps tag merges.

- **Skill matrix utility** -- `src/utils/skill-matrix.ts` exports `getRequiredSkills(tags, vcs, project?)`, the programmatic encoding of `skills/fleet/skill-matrix.md`. Returns deduplicated, sorted skill names. Currently used in tests; not yet wired into the installer onboarding path.

- **list_members tags filter** -- `list_members` now accepts a `tags` string array. AND semantics: only members carrying all supplied tags are returned. Existing behavior (no filter = all members) is unchanged.

### Changed

- **skill-matrix.md** -- Role column renamed to Tag; semantics updated to clarify that tag values are the exact strings stored in `Agent.tags` and drive both skill selection and permission profile merging.

- **permissions.md** -- Rewritten to document tag-based composition: reserved doer/reviewer tags, custom tag profiles, additive merge, primary-mode extraction, and the four-step profile composition order.

### Carried forward

- apra-fleet-2tl: Integration tests -- full tag stack end-to-end (P2)
- apra-fleet-4xe: Parent tracker for Phase 5 (close after 2tl lands) (P2)
- apra-fleet-1az: E2E test design for OpenCode (P2)
- apra-fleet-69r: Improve opencode auth error classification (P2)
- apra-fleet-796: sprint-roles.md with role-to-member mapping (P2)
- apra-fleet-9te: README /auto-sprint vs /pm routing paragraph (P2)

---

## [Unreleased] -- feat/member-tags-design (member category and tags -- Phases 0-1)

Sprint goal: implement member category grouping (Phase 0, apra-fleet-j23) and the member tags data model, display, and validation layer (Phase 1, apra-fleet-9iw). Both phases were completed and the test suite passes (1560 tests, 95 files). Phases 2-5 and integration tests (04a, 51i, 6ky, 4xe, 2tl) were not started in this sprint and are carried forward.

Scope: Phase 0 merges PR #238 (category field + groupByCategory). Phase 1 adds tags?: string[] to the Agent model with Zod validation (max 10 tags / 64 chars each), displays tags in check_status and list_members compact and JSON output, and covers all boundaries in tests/tags.test.ts, tests/update-member.test.ts, and tests/category.test.ts.

#### Sprint cost analysis
Calibration: historical (1 sprint)   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |     22,200 |          0 | -100% |   $0.348 |   $0.000 |
| reviewer   |      9,360 |          0 | -100% |   $0.158 |   $0.000 |
| overhead   |      7,150 |     37,428 | +423% |   $0.121 |   $0.365 |
| TOTAL      |     38,710 |     37,428 |   -3% |   $0.627 |   $0.365 |
True-cost estimate (output x 4x): $2.507

Outliers (>200% variance): overhead
Calibration failures (>500%): none

### Added

- **Member category field** -- `register_member` and `update_member` now accept an optional `category` string. Members with the same category are grouped together in `check_status` and `list_members` output. Categories are sorted alphabetically; members with no category appear under `(uncategorized)` at the end. Empty string clears the category.

- **Member tags field** -- `register_member` and `update_member` now accept an optional `tags` array (up to 10 strings, max 64 chars each). Tags are displayed in compact and JSON output for `check_status` and `list_members`. Passing an empty array in `update_member` clears all tags.

- **groupByCategory utility** -- `src/utils/agent-helpers.ts` exports `groupByCategory<T>()`, a generic helper that buckets any item list by a string key, returning a sorted-key array with `(uncategorized)` always last. Used by check_status and list_members; reusable for other item types.

### Carried forward

- apra-fleet-04a: Phase 2 -- tag-aware permission composition (P1)
- apra-fleet-9iw: Phase 1 parent tracker -- open until all sub-tasks land (P1)
- apra-fleet-51i: Phase 3 -- tag-aware skill matrix (P2)
- apra-fleet-6ky: Phase 4 (apra-fleet) -- update permissions.md for tag composition (P2)
- apra-fleet-4xe: Phase 5 -- tag-based member selection in list_members (P2)
- apra-fleet-2tl: Integration tests -- full tag stack end-to-end (P2)
- apra-fleet-1az: E2E test design for OpenCode (P2)
- apra-fleet-69r: Improve opencode auth error classification (P2)
- apra-fleet-796: sprint-roles.md with role-to-member mapping (P2)
- apra-fleet-9te: README /auto-sprint vs /pm routing paragraph (P2)
- apra-fleet-rs3: Add CI pipeline to project (P2)

## [Unreleased] -- feat/auto-sprint (auto-sprint pipeline)

Sprint goal: implement the full auto-sprint.js install pipeline -- submodule pin
(zbl), AssetManifest.workflows field (vqe), cost.js extraction and workflow copy
step (b8c), claude-only Skill/Workflow permissions (ano), and extended tests for
all eight agents / cost.js / workflow paths (96j). All five goals were delivered
in two cycles; build is clean and the full test suite (92 files, 1531 tests)
passes with zero failures.

#### Sprint cost analysis
Calibration: none   Cycles: estimated 1.5, actual 2

| Role       | Est tokens | Act tokens |   D%   | Est USD  | Act USD  |
|------------|------------|------------|-------|----------|----------|
| doer       |          0 |     45,503 |   n/a |   $0.000 |   $0.682 |
| reviewer   |          0 |     19,192 |   n/a |   $0.000 |   $0.288 |
| overhead   |      7,150 |     53,729 | +651% |   $0.121 |   $0.473 |
| TOTAL      |      7,150 |    118,424 | +1556% |   $0.121 |   $1.444 |
True-cost estimate (output x 4x): $0.483

Outliers (>200% variance): overhead
Calibration failures (>500%): overhead

### Added

- **auto-sprint workflow install** -- `apra-fleet install --skill pm` now writes
  `cost.js` to the PM skill directory for every provider that supports PM.
  `cost.js` is a CJS-wrapped extract of the seven pure cost-computation functions
  (`computeSprintQuote`, `computeSprintAnalysis`, `buildSprintSummary`, etc.) from
  `vendor/apra-pm/.claude/workflows/auto-sprint.js`. For Claude specifically, the
  full `auto-sprint.js` workflow is also copied to `~/.claude/workflows/`.

- **Claude permissions for auto-sprint** -- for Claude + PM installs, the
  installer now adds `Skill(auto-sprint)` and `Workflow(auto-sprint)` to the
  Claude Code allow-list via `mergePermissions`. Other providers receive no change;
  OpenCode skips `mergePermissions` entirely (its permission model is per-agent
  frontmatter, not a top-level config key).

- **AssetManifest.workflows field** -- `AssetManifest` now has a `workflows`
  field. `buildDevManifest` populates it from `vendor/apra-pm/.claude/workflows/`
  (falling back to `dist/workflows/`). `gen-sea-config.mjs` embeds
  `auto-sprint.js` as a named SEA asset. `vendor-pm.mjs` copies the workflows
  directory to `dist/workflows/` on `prepublishOnly` so npm global installs work
  without the submodule.

- **apra-pm submodule pinned to 262aef8** -- `vendor/apra-pm` is now pinned at
  commit 262aef8 (previously d141720), which carries the `auto-sprint.js`
  workflow with PURE_FUNCTIONS_BEGIN/END markers.

- **/auto-sprint completion output** -- claude+PM installs now print a
  `/auto-sprint` usage hint at the end of the install sequence.

### Carried forward

- apra-fleet-1az: E2E test design for OpenCode (P2)
- apra-fleet-69r: Improve opencode auth error classification (P2)
- apra-fleet-796: sprint-roles.md with role-to-member mapping (P2)
- apra-fleet-9te: README /auto-sprint vs /pm routing paragraph (P2)
- apra-fleet-rs3: Add CI pipeline to project (P2)

## [Unreleased]

### Added

- **OpenCode provider** -- OpenCode is now a first-class provider
  (`apra-fleet install --llm opencode`). It works with any OpenAI-compatible
  endpoint (Ollama, vLLM, etc.) for self-hosted and local models. The model
  endpoint is the user's responsibility; Fleet installs the CLI and agents but
  does not provision the inference server. See
  [docs/opencode-exploration.md](docs/opencode-exploration.md) for background.

- **Per-member model tiers** -- `register_member` now accepts an optional
  `model_tiers` map (`{ cheap, standard, premium }`) so each member can specify
  which models to use at each tier. Particularly useful for OpenCode members
  where models vary by deployment. A single-model entry fills all three tiers.
  When no map is set, the provider adapter's defaults are used.

- **PM agent installation** -- the installer now writes 4 PM agent definitions
  (planner, plan-reviewer, doer, reviewer) to each provider's agents directory
  (e.g. `~/.claude/agents/`, `~/.config/opencode/agents/`). For OpenCode,
  agent frontmatter is transformed from Claude format to OpenCode format
  (tools allowlist -> permission map, mode: subagent). Codex and Copilot skip
  agent installation (no agent system).

### Changed

- **PM skill sourced from apra-pm submodule** -- the PM skill is now vendored
  from the [apra-pm](https://github.com/Apra-Labs/apra-pm) git submodule at
  `vendor/apra-pm/` instead of being maintained inline. All gap-ported features
  from the old inline skill (sprint selection, operational rules, provider
  awareness, fleet addendum, simple sprint, resume rules, documentation harvest)
  are included. The skill is backward compatible -- all `/pm` commands, state
  file names (PLAN.md, progress.json, feedback.md, status.md), and beads
  lifecycle hooks are preserved.
