# Sprint-start member prep and the stray fleet-process sweep

Before a sprint's first dispatch, every sprint member goes through a
per-member prep pass: verify/provision LLM auth, sweep stray fleet processes
left by an earlier sprint, and report a git-pull and beads-pull status line.
This exists because an operator was previously expected to do all of this by
hand, and it doesn't scale: a sandbox supervisor left running on a remote
Windows member by a prior sprint was still there when the next sprint tried
to launch on it. Every user launching sprints onto remote members hits this
same class of problem, so it belongs in the product.

## Member Prep: four steps, reported per member

Member Prep runs once per member, at sprint start, before any role
dispatch. Per member it reports one result line for each of:

1. **LLM auth** -- verify/provision.
2. **Stray-process sweep** -- remote members only (see below).
3. **G-pull** (git) -- a report line, not a second fetch: the start-of-sprint
   branch step already fetches and checks out every sprint member
   immediately after Member Prep runs, and failing loudly there already
   covers this. Issuing a redundant fetch here would double the git dispatch
   count of every sprint run for no added safety.
4. **D-pull** (beads) -- Member Prep extends the same D-pull mechanism every
   dispatch already uses (the pre-dispatch beads sync) to run for every
   sprint member up front, rather than re-implementing a second path. Without
   this, a member with no early dispatch in a cycle could otherwise go
   unpulled for a while.

### Auth: local members are a structural no-op, and must be read as one

`provision_llm_auth` is a no-op for local members (they share the operator's
own host session, which only an interactive login on that machine can
refresh) -- it reports success with a distinct "skipped, local member"
reason rather than a real provisioning result. Member Prep treats that
specific reason as explicitly NOT successful provisioning, matching the same
ordering rule the reactive self-heal path already uses elsewhere. Getting
this backwards is not a theoretical risk: an earlier revision of this
feature called `provision_llm_auth` unconditionally for every member and
treated the local no-op response as success, which made every local-member
sprint -- the single most common configuration -- abort at Member Prep
before its first dispatch, on every run. The auth check therefore only ever
proactively provisions members the engine can positively identify as
**remote**; local/relay/unknown members get a logged skip and no call at
all, because `list_members` cannot report a real status for them either (a
local session can only be checked reactively, by letting one real dispatch
fail and classifying the error -- which remains the only mechanism for
those members).

## The stray-process sweep

A machine-wide process scan followed by a kill is dangerous by nature, so
the design is a set of predicates that must ALL hold before a single process
is killed, built as a pure decision function plus an injected execution
seam -- every predicate is unit-testable without a real process existing
anywhere.

1. **Remote members only.** For anything not verifiably remote (local,
   relay, or unknown locality) the sweep may only report candidates, never
   kill. The local machine hosts the production fleet server, the
   supervisor, and possibly the operator's own session -- killing there is
   never safe to automate.
2. **Only processes fleet itself started**, identified by more than a
   process name. A name-only match is never sufficient evidence; evidence
   must be a path or flag marker actually observed on the command line.
3. **Only when the parent process is gone.**
4. **Never a process listening on the member's production fleet or
   supervisor port.** The sweep hardcodes no port of its own -- the caller
   supplies the production port set.
5. **Only when the process is older than a minimum-age bound.** A process
   that is too young, or whose start time could not be established, is
   reported but never killed. This is what stops the sweep from killing a
   process a *different*, concurrently-starting sprint just launched on the
   same member seconds ago: such a process can satisfy every other predicate
   (daemonized, parent gone) before it's had time to do anything a later
   pass would recognize as itself.
6. **Every kill is logged** with pid, command line, start time, and the
   reason the process was selected.
7. **Never a process that is still answering HTTP on a port it holds.**
   Predicate 4 is only as good as a *static* port list; this one asks the
   port itself. See below -- it is armed by default.

### The liveness probe is armed by default (DECIDED)

This is settled, single behaviour. Every sweep pass arms the liveness
predicate; only an explicit `"livenessProbe": false` in the target's sweep
config turns it off. A config that never mentions the option is **armed**.

Each candidate that has survived every other predicate gets a second
dispatch: one plain HTTP GET per port it still holds. *Any* HTTP status at
all spares it -- the probe never inspects the body and requires no
particular status code, so it assumes nothing about a target's own health
endpoint. `path` and `timeoutMs` are overridable
(`"livenessProbe": { "path": "/healthz", "timeoutMs": 1500 }`).

**The probe speaks HTTP only -- it cannot vouch for a non-HTTP listener.**
A port that *refuses* the connection is treated as dead and stays killable,
exactly as before. A port that *accepts* the TCP connection but never speaks
HTTP back -- a database server, for example -- is neither answered nor
refused: this predicate has no way to tell whether it is alive, so the
candidate is SPARED fail-safe, the same direction as an ordinary
`unevaluable` spare, but counted in its own `tcpAliveNoHttp` bucket on the
sweep result rather than folded into `unevaluable` (a single candidate is
never counted in both). Member Prep prints its own
`sweep -- LIVENESS TCP-ALIVE-NO-HTTP` line naming the member and how many
candidates were spared this way, distinct from the `LIVENESS UNEVALUABLE`
line below -- "the probe could not be evaluated" and "the probe was
evaluated and found something alive it cannot confirm over HTTP" are
different findings with different fixes, so they are never narrated alike.
A target that wants such a daemon protected from an armed sweep must give it
a matching `productionPorts` entry, or an HTTP health endpoint this probe
can actually ask -- otherwise it survives an armed pass only because it was
spared, not because the sweep understood it.

**Telling "refused" apart from "accepted but silent" is a distinct
transport-status field, not inferred from the HTTP outcome.** Both outcomes
produce the identical "no HTTP response" result, so each probe result line
carries its own transport-status alongside the HTTP status: POSIX reads it
straight off curl's own exit status (already free -- refused vs. timed-out/
accepted-then-silent are different curl exit codes), and the win32 branch
asks the same question explicitly with its own bounded TCP connect attempt
after `Invoke-WebRequest` has already given up. A candidate can hold more
than one socket answering the same pid:port key (bound to more than one
address); results for the same key are combined **by precedence, never
last-wins** -- answered beats tcp-alive-no-http beats refused -- so a more-
alive sibling result can never be downgraded by a less-alive one reported
for the same candidate in the same pass.

**The win32 TCP question must construct its socket with an explicit address
family.** `New-Object System.Net.Sockets.TcpClient` with no constructor
argument defaults to an IPv4-only socket under Windows PowerShell 5.1 /
.NET Framework -- the actual shell every dispatch to a Windows member runs
under, not `pwsh`/.NET Core, where the parameterless constructor is family-
agnostic and this bug cannot be observed. Connecting that IPv4-only socket
to an IPv6 literal throws; the throw lands in the probe's own catch and gets
reported as REFUSED -- the one transport outcome this predicate still treats
as "nothing is listening here" and therefore killable. Left unfixed, a live
IPv6-bound listener on Windows would be killed as dead: the exact failure
this predicate exists to prevent, reintroduced through the one branch that
never runs in a same-family dev-box test. The address family is resolved in
JavaScript from the already-validated probe host (bracketed literal ->
IPv6, unbracketed -> IPv4) before being interpolated into the dispatched
PowerShell, never inferred by the socket library on the member.

**Why armed rather than opt-in.** The predicate can only ever *spare*: there
is no input that makes it select a process the other predicates had not
already selected, so arming it cannot cause a wrong kill, only prevent one.
The hole it closes is also not enumerable in advance -- a supervisor started
on a non-default port, or a sprint child's `allocateFreePort()` viewer port,
can never appear in a static `productionPorts` list, and both are daemonized
so the parent-gone predicate is satisfied from the moment their launcher
exits. That static list was the only thing standing between a live process
and a kill. **Opt-in was rejected**: it leaves that hole open for exactly
the targets that do not know to ask, and it cannot be made loud honestly --
warning "this sweep may kill a live process" on every un-armed sprint would
be an advisory that never blocks.

**What arming costs, and how that cost is surfaced.** An unevaluable probe
spares (the fail-safe direction, unchanged). So on a member with no `curl`
or `Invoke-WebRequest`, *every* candidate is spared and the stale sandbox
supervisor this feature exists to clear survives. That is the losing side of
this decision, and it is never silent: Member Prep prints its own
`sweep -- LIVENESS UNEVALUABLE` line naming the member, how many candidates
were spared unchecked, and both ways out (install an HTTP probe tool on the
member, or set `"livenessProbe": false` to accept kills that were never
checked for life).

**What arming does not buy: portless candidates are killed unchecked.** The
predicate can only ask a *port* whether anything is answering on it, so a
candidate holding no listening port gets no protection from it and is
selected on the other predicates alone -- exactly as it was before the
predicate existed. **Sparing it instead was considered and rejected**: a
portless process is the common shape of the stale stray this sweep exists to
clear (a supervisor that already released its port, an orphaned child), so
treating it as a fail-safe `unevaluable` spare would make an armed sweep a
near-total no-op. These kills are counted per candidate as `unprobeable` on
the sweep result -- never contingent on whether some unrelated candidate in
the same pass happened to hold a port -- and Member Prep prints its own
`sweep -- LIVENESS UNPROBEABLE` line for them, so "the liveness probe was
armed" can never be read as "every kill in this pass was checked for life".
The only lever a target has here is its sweep markers: a process the markers
never match is never a candidate at all.

**"Not armed" and "armed, nothing was live" are different results.** The
sweep result carries a `liveness` record (`armed`, `dispatched`, `checked`,
`spared`, `unevaluable`, `tcpAliveNoHttp`, `unprobeable`) and the phase summary line renders
each state distinctly -- including "armed but not dispatched because no
surviving candidate held a port to probe, so N were selected unchecked",
which must never be collapsed into "nothing survived, so there was nothing
to check". An operator never has to guess how much safety was applied to a
given set of kills. A malformed `livenessProbe` value is a hard error at
the same config/CLI boundary that rejects a malformed marker -- it never
silently disarms and never silently arms.

The full rationale, including the rejected alternative, lives in the
`LIVENESS PROBE: ARMED BY DEFAULT -- DECIDED` header section of
`fleet-sprint/phases/member-prep.mjs`.

### Portability: absolute start time, one shape for both OS families

Process start time is read as `etime` (the POSIX-standard elapsed-time
keyword present on both Linux procps and macOS/BSD `ps`) rather than the
GNU-only `etimes` extension that hard-fails on macOS -- a known trap an
earlier, adjacent script fell into. `etime`'s `[[dd-]hh:]mm:ss` format is
converted to an absolute start time in JavaScript against an injected clock.
Windows instead reads `Win32_Process.CreationDate` and converts it to epoch
seconds on the member. Both families therefore produce one record shape (an
absolute start time), so no caller has to branch on which OS produced it.

### Known limit: opaque Windows command lines

A dispatch to a Windows member is frequently delivered as
`powershell -EncodedCommand <base64>`, whose visible command line carries
none of the tokens encoded inside it. Such a process matches no marker and
is therefore left alone -- the fail-safe direction (the sweep under-kills
rather than over-kills). A caller that wants those trees swept must supply a
marker that survives the encoding, on the *outer* command line, since a
data-dir environment variable (the obvious marker) is passed to member
processes through the environment and never appears in argv at all, making
it unreadable to a command-line sweep by construction.

### Kill-command safety: POSIX special parameters are not variables

The shell-command-guard that blocks unresolved shell expansion in any
dispatched command string (see this repo's convention on resolving
`$VAR`/`~/`/backticks in JavaScript before dispatch, not relying on the
member's shell) originally matched named variables only. A POSIX shell
*special parameter* -- `$?` `$!` `$$` `$#` `$@` `$*` and `$0`-`$9` -- carries
the exact same cross-shell ambiguity (it is evaluated by whatever shell
actually runs the dispatch, which may be PowerShell, not POSIX) but starts
with a digit or punctuation rather than a letter/underscore, so the
named-variable pattern never saw it. The guard now flags these too, with two
deliberate exclusions so it stays a real signal: `$$` immediately followed by
`{` (a `${...}` template interpolation, not the shell pid), and a digit
immediately followed by another digit or a `.` (a dollar-amount literal like
`$5.00`, never a positional parameter, which is always exactly one digit).
Kill-command construction for the stray sweep carries a documented
`shell-guard-allow` carve-out for the one place it deliberately asks the
*member's own* shell to evaluate `$?` right after a `kill` it just ran in the
same dispatch -- the one case where special-parameter evaluation by the
target shell is intentional rather than a bug.

### Generic by design

The sweep module knows no process names, paths, or ports of its own -- the
evidence markers and the production port set are inputs supplied by the
caller. This is also what makes "never kill by name alone" mechanically
checkable rather than a convention to trust: only the caller knows which
paths and flags it actually put on a command line, so the module cannot
smuggle in a name-only shortcut even if a future edit tried to.

### Sweep failure does not abort the sprint (DECIDED)

This is settled, single behaviour -- not a choice a reader or an operator
still has to make. **A sweep failure never ends the sprint.** If the probe
command will not execute, the member has none of the supported
process-enumeration or listening-socket tools, or a selected pid's kill is
genuinely refused, the phase records a loud per-member
`sweep -- FAILURE` line naming that member and the specific cause, records
`{ status: 'failed', reason, error }` on the phase result, and CONTINUES --
to that member's remaining prep steps, to every other member, and on to the
sprint's first dispatch.

Read a FAILURE as **"this member was not scanned"**: never as "clean", never
as "skipped". Those are three distinct statuses and the phase reports them
as three. The sweep is hygiene, not a dispatch precondition, so an unswept
member still builds, tests and commits normally; the only cost is that a
leftover process from an earlier run may still be sitting there.

The containment is deliberately narrow: only `StrayProbeError` (and its
subclass `StrayProbeToolMissingError`) is caught. Any other error escaping
the sweep is an engine defect, not a member condition, and still propagates
and still ends the sprint.

**The auth policy is unchanged by this.** An unprovisionable LLM credential
still aborts before the first dispatch, because auth *is* a precondition for
dispatching to that member at all. The full rationale lives in the
`SWEEP-FAILURE POLICY -- DECIDED` header comment in
`fleet-sprint/phases/member-prep.mjs`, and the operator-facing statement of
the same policy is in the fleet-supervisor `SKILL.md` Member Prep section.

## Previously listed gaps, now closed

Nothing in this design is outstanding: every gap this section once carried
has been closed, and each is recorded below as current behaviour rather than
as an open item.

- **The sweep config is wired end to end.** The supervisor loads the sprint
  repo's own `.fleet/sweep-config.json` (or `FLEET_SE_SWEEP_CONFIG`) at
  startup and `buildSprintArgv()` forwards it to every sprint it launches as
  `--sweep-config`, which `bin/cli.mjs`'s `resolveSweepConfig()` parses back
  into the `sweepMarkers` / `sweepProductionPorts` Member Prep consumes. A
  supervisor-launched sprint therefore no longer reports "sweep skipped: no
  fleet-start markers configured". The marker/port data itself stays
  TARGET-owned (see `docs/generic-engine-boundary.md`): the engine knows no
  process names, paths or ports of its own, and a target that declares no
  config still gets the dormant-but-loud behaviour (a startup log line saying
  the sweep will stay dormant; a declared-but-malformed config fails the
  supervisor at startup instead of silently disarming the sweep).
  apra-fleet's own set lives in `.fleet/sweep-config.json`, and the safety
  reasoning behind each marker's `evidence` class is stated in that file's
  `_readme` -- in particular that a process shape whose live instances cannot
  be recognised from the command line (a sprint engine child on an
  OS-assigned viewer port) is declared `evidence: "name"`, which can never by
  itself get anything killed.

- **Kill-dispatch labelling.** A sweep dispatch now carries its kind, so a
  kill is labelled as a kill ("stray-process kill on `<member>`") rather
  than reusing the probe wording. The label is presentation only -- the kind
  never reaches the probe or kill command strings.
- **Auth-unreachable vs auth-missing.** A member the registry reports as
  offline now fails with a distinct unreachable error, raised *before* any
  `provision_llm_auth` call, whose text states it is not a credential
  problem. A genuinely missing credential still reports as unprovisionable.
  The two point at different operator actions: fix connectivity vs.
  provision a credential.
