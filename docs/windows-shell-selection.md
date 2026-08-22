# Windows shell selection: probing the real shell instead of assuming PowerShell

## The problem this replaces

Prior to this feature, every Windows member was assumed to run PowerShell,
both implicitly (the only Windows `OsCommands` implementation existed) and
via ad-hoc raw-PowerShell strings scattered outside that abstraction
(member-home path resolution, provider install commands, the fleet-sprint
runner's own encoded-command wrapper). PowerShell's own semantics
(false-success on non-terminating errors, `$OFS` array-splitting,
CLIXML-wrapped stderr, alias collisions such as `curl`) made this assumption
a disproportionate source of live-discovered bugs. A registered member's OS
being `windows` was never actually evidence its interactive/login shell was
PowerShell -- a large share of real-world Windows dev machines run
Git-for-Windows Bash as the default shell.

## The `shell` field: finer-grained than `os`

The member schema now carries an optional `shell` field --
`'gitbash' | 'pwsh7' | 'powershell5'` -- alongside the existing `os` field.
`os` answers "what platform is this," `shell` answers "what interpreter
actually executes the command strings we send it." Code that branches
command construction for a Windows member must branch on `shell` (via the
`isPosixShell(os, shell)` predicate), not on `os === 'windows'` alone --
`os === 'windows'` with `shell === 'gitbash'` is a POSIX command-construction
target, byte-identical in shape to a Linux/macOS member. This is the key
delta from the general cross-shell guidance in
[docs/cross-shell-command-construction.md](cross-shell-command-construction.md),
which predates this feature and still frames every branch point as an
`agent.os` check -- that guidance remains correct as a POSIX-vs-PowerShell
framing, but any Windows-specific call site should now resolve through the
registered `shell`, not `os`, wherever the member's actual shell has been
probed and recorded.

## Probe order and trust rule

At registration and on update, a Windows member is probed in this order and
the FIRST candidate that actually proves itself working is registered:

1. **Git-for-Windows Bash** (`gitbash`)
2. **PowerShell 7** (`pwsh7`)
3. **PowerShell 5.1** (`powershell5`) -- final fallback

A candidate is only trusted when a real smoke command against it returns
BOTH exit code 0 AND an expected marker in stdout. Presence or path
existence alone is never sufficient -- a `bash.exe` file existing at a path,
or a `pwsh` binary being resolvable, proves nothing about whether it
actually runs. If every probe fails outright, registration still succeeds
and degrades to `powershell5` with a surfaced warning, rather than failing
the whole registration -- an unprobeable environment should not block a
member from joining the fleet, but the degraded state must be visible to
whoever registered it, not silently assumed.

### WSL/System32 bash.exe disambiguation

`bash.exe` is not a unique identifier for Git-for-Windows Bash: WSL ships
its own launcher at `%SystemRoot%\System32\bash.exe` (and a
WindowsApps-shimmed variant) with the same binary name but entirely
different semantics. A candidate resolved from PATH is rejected by BOTH its
path (known WSL/System32/WindowsApps launcher locations are excluded
up front) AND its runtime behavior (`uname` output must indicate a real
MINGW/MSYS environment, not the Linux subsystem) before it is trusted as
`gitbash`. Checking only one of the two would let a WSL launcher masquerade
as Git-for-Windows Bash, reintroducing the exact ambiguity the probe exists
to eliminate.

## Invariant: probe and command-builder must share one git-bash candidate list

The shell probe's Git-Bash discovery step checks the two Program Files
roots, `Program Files\Git\usr\bin`, `%LOCALAPPDATA%\Programs\Git\bin\bash.exe`
(the default location for a user-scope, non-admin Git for Windows install),
and any additional binary PATH resolves to via `Get-Command bash.exe -All`.
The Windows-Git-Bash command builder that constructs actual command strings
for an already-registered `gitbash` member must probe the identical
candidate set when it re-resolves the bash executable path at command-build
time -- not a narrower subset. If the two lists diverge, a member whose only
working Git-for-Windows Bash install lives at a candidate the probe checks
but the builder doesn't (the user-scope `%LOCALAPPDATA%` install is the
concrete case) probes and registers successfully as `gitbash`, but then has
every actual command sent to it built against a bare, PATH-resolved
`bash.exe` fallback -- silently reintroducing the WSL/System32 ambiguity the
probe was built to close, for exactly the member the probe is supposed to
protect. Keeping both candidate lists in one shared source, or otherwise
enforcing they can't drift apart, is a correctness requirement, not
stylistic tidiness.

## Design decision: core and fleet-sprint implement this pattern independently

Both apra-fleet core (compiled TypeScript binary) and fleet-sprint plus its
supervisor (open, user-copyable `.mjs` source) need the same underlying
capability: build member-bound command strings appropriate to the member's
actual registered shell instead of a fixed PowerShell assumption. These are
implemented as two separate, structurally-parallel implementations rather
than one shared package, for two reasons:

1. **Different distribution models.** Core ships as a compiled TypeScript
   binary; fleet-sprint and supervisor ship as plain `.mjs` source a user
   copies directly. A shared workspace package would force build/versioning
   coupling across two distribution models that otherwise have none.
2. **fleet-sprint is meant to stay apra-fleet-agnostic**, an existing repo
   convention independent of this feature. A shared package risks smuggling
   apra-fleet-specific concepts into code that is supposed to work
   standalone.

Each side extends a POSIX base class and overrides only the Windows-native
surface that actually differs (credential path root, PID capture, and
similar primitives) -- the same "extends the POSIX implementation, override
only what's Windows-specific" shape on both sides, even though the two
implementations share no code. If fleet-sprint/supervisor are ever packaged
as listeners served directly by the core binary, unifying the two at that
point is a mechanical merge of two structurally-identical implementations,
not a redesign.

**Current state**: the core-side implementation is wired into the real
command-construction call sites. The fleet-sprint-side module set exists as
source but is not yet imported by anything outside itself, and the runner's
production PowerShell-encoding call site has not yet been switched over to
it -- so on the fleet-sprint side, today, this is a structural design
decision realized in file layout, not yet a behavior change. Treat the
fleet-sprint module set as unwired until its call site is actually
switched.

## Known deliberate duplication: `isPosixShell`

The `isPosixShell(os, shell)` predicate that decides whether a member's
outbound commands should be built as POSIX or PowerShell currently exists as
multiple separate copies across the call sites that need it (a shared
exported helper plus several private copies with slightly different
signatures), each carrying a comment that the duplication is intentional for
now rather than accidental drift. This is a known, deliberate short-term
state, not a defect -- but a future consolidation behind one exported helper
with one signature is expected, since multiple independently-maintained
copies of the same predicate is exactly the kind of thing that silently
diverges over time even when each copy is correct today.
