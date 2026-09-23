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

### Generic by design

The sweep module knows no process names, paths, or ports of its own -- the
evidence markers and the production port set are inputs supplied by the
caller. This is also what makes "never kill by name alone" mechanically
checkable rather than a convention to trust: only the caller knows which
paths and flags it actually put on a command line, so the module cannot
smuggle in a name-only shortcut even if a future edit tried to.

## Known gaps carried forward (deferred, not silently dropped)

These were filed as low-priority follow-ups rather than blocking the initial
feature, and remain open by design:

- **The sweep config surface exists but nothing wires it end to end.** A
  direct CLI launch can pass `--sweep-config` (markers plus production
  ports) through to Member Prep, but the supervisor's own sprint-launch
  argument builder has no passthrough for it yet, so a sprint launched via
  the supervisor -- the path that motivated this feature in the first place
  -- still ships the sweep dormant (no markers, no production ports, so
  nothing ever matches).
- **A sweep probe or kill failure currently aborts the whole sprint.** Only
  the auth failure path was specified as a hard, pre-first-dispatch abort;
  a sweep-side failure propagating the same way was not a deliberate design
  choice and needs an explicit decision.
- **Kill-dispatch labeling.** Internal logging for a sweep kill still uses a
  "probe" label even when the action taken was a kill, not just an
  enumeration -- a readability gap, not a correctness one.
- **Auth-unreachable vs auth-missing.** An offline/unreachable remote member
  is currently reported the same way as one with a genuinely missing LLM
  credential ("LLM auth cannot be provisioned"), which conflates two
  different operator actions (fix connectivity vs. provision a credential).
