# Recorded Toolchain: Giving an Installed Service Its Own Absolute Paths

## The problem

An installed fleet-supervisor runs as a background service (a systemd unit, a
macOS launchd job, a Windows scheduled task), not as a foreground shell
process. A service manager hands its child process a minimal, often
PATH-less or shell-config-free environment -- it does not source the
operator's `.bashrc`/`.zshrc`, so a Node.js runtime installed through a
version manager (nvm, fnm, volta) and a globally-installed `bd` are both
invisible to it, even though the interactive shell that installed
fleet-supervisor could see both perfectly well. Left unfixed, every sprint
launch from the installed service fails at spawn time with something that
looks like a random, unrelated failure rather than a missing-PATH problem --
the exact opposite of loud and diagnosable.

The fix: resolve both binaries' **absolute paths** once, at install time
(when the installer's own shell environment is a reliable source of truth),
record them, and thread that recording through every later place that would
otherwise do a PATH lookup.

## Lifecycle: resolve once, record, read many times, re-validate at boot

**Resolve (install time).** The installer asks Node.js for its own absolute
interpreter path (`node -p process.execPath`) rather than trusting `which`/
`where` -- this is what makes a version-manager shim resolve to the real
interpreter underneath rather than to the shim script itself. `bd`'s path
comes from a platform-appropriate lookup (`where`/`which`). Both probes are
injectable (exec function and platform), so both the win32 and POSIX branches
are exercisable without a real node or bd anywhere. An unresolved node is
non-negotiable: it is surfaced as a fatal install error, because the
supervisor cannot serve a single sprint without one. An unresolved `bd` is
recorded as absent rather than failing the install -- `bd` is not a hard
fleet-se prerequisite the installer enforces, so a missing `bd` degrades
gracefully everywhere downstream instead of blocking installation.

**Record.** The resolved paths are written into the supervisor's own JSON
config as a `toolchain` block (`{ nodePath, nodeVersion, bdPath, bdVersion,
recordedAt }`), alongside -- but fully independent of -- the config's other
settings. A write here never touches unrelated settings, and unrelated writes
(e.g. a later `--project-dir` change) never clobber this block; the two are
treated as orthogonal fields in the same file, not a single all-or-nothing
record.

**Read.** Every reader goes through one shared config-reading module, never
opening the config file directly. Reading validates strictly on exactly one
field -- `nodePath` must be present, a string, non-blank, and an absolute
path -- because that is the one value a caller hands straight to a process
spawn. Every other field (`nodeVersion`, `bdPath`, `bdVersion`, `recordedAt`)
is passed through as-is. Any failure mode (file missing, malformed JSON, no
`toolchain` key, `toolchain` not an object, `nodePath` missing/blank/
non-string/relative) degrades to the same shape: `toolchain: null` plus a
distinguishable, human-readable `reason` string -- never a thrown error. A
config file that predates this feature, or a foreground dev run with no
config file at all, is expected to hit this path and must not break startup.

**Use.** Two independent consumers thread the recorded path through, each
with its own fallback philosophy appropriate to how critical that binary is:
- The sprint-runner resolver treats a recorded, validated node path as a
  hard, non-skippable tier (see `sprint-runner-resolution.md`): if it is
  configured but does not check out, resolution throws rather than silently
  falling through to a PATH lookup that cannot succeed on exactly the service
  that needed this tier.
- The `bd` invocation helper treats a recorded `bd` path as a soft override
  it prefers when present, degrading quietly to a plain PATH lookup when it
  is absent or broken -- `bd` failures are not fatal to a sprint launch the
  way a missing Node.js runtime is.

**Re-validate at startup.** Because a recording can go stale for reasons the
operator is not present to fix (a version manager removed that release, the
checkout moved, the machine was reimaged), the supervisor re-probes both
recorded binaries once at boot, before it does anything with them. This
validation module has one job and one contract:
- It reads the recording only through the shared config-reading module --
  never the raw config file.
- It never throws. Every failure mode (nothing recorded at all, a malformed
  recording, an absent binary, an unprobeable binary, a too-old node) becomes
  a `problems` entry, never a crash -- a supervisor must be able to boot,
  report on its own toolchain, and still serve the page an operator would use
  to fix whatever is wrong.
- "Nothing recorded" is explicitly not a problem: it means a pre-feature
  install or a foreground dev run, and both are legitimate. The report says
  so (`configured: false`, no `problems`) rather than pretending something is
  broken.
- The pass/fail signal (`ok`) tracks **node health only** -- node is the one
  binary the sprint-runner resolver hard-fails a launch over the instant it
  is configured but unusable, so it is the only condition serious enough to
  gate a single top-level verdict. A broken `bd` recording is real and always
  gets its own, separately worded `problems` entry (never conflated with a
  node problem), but it does not flip `ok`, because the `bd` invocation
  helper already tolerates a broken recording by falling back to PATH. Two
  machine-readable booleans (`nodeOk`, `bdOk`) expose that same node-vs-bd
  distinction directly, so a consumer never has to recover it by
  substring-matching prose in `problems`.
- Both probes run concurrently (not sequentially) since they are fully
  independent of each other -- this bounds the worst-case validation wall
  clock to one probe's own worst case rather than the sum of both, which
  matters because this validation runs before the supervisor has bound the
  port an operator would use to fix the very setting being validated.
- Exactly one operator-facing fix line is defined for this whole module, so
  every surface that reports a toolchain problem (console log at boot,
  health endpoint, dashboard header) shows the same sentence rather than each
  inventing its own restatement.

**Surface.** The startup validation report is computed once and handed to
every surface that wants it -- the health endpoint and the dashboard header
both render the *same* report object, reusing its own `problems`/`fixLine`
text rather than each hand-copying a literal. The dashboard escapes every
path and version string it renders (paths and `bd`/node output are
effectively free-form operator/environment-controlled text, not something to
trust as pre-sanitized HTML).

## The bd-is-a-node-script problem: PATH-prepending

A recorded `bd` is almost always an npm-installed script starting with
`#!/usr/bin/env node` -- not a native binary. `env node <script>` only works
if `node` itself resolves on **whatever PATH the process invoking `bd`
inherited**. A PATH-less/minimal service environment (the exact environment
this whole feature exists to route around) has no `node` on it at all, so
running the recorded `bd` directly fails with `env: node: No such file or
directory` (exit 127) -- even though the recording is perfectly correct and
the interpreter it names would work fine if only it could be found. Recording
`bd`'s own absolute path alone does not fix this: the *script* was found, but
the *interpreter its shebang line asks the OS to find* still is not.

This surfaces at three independent call sites, all fixed the same way rather
than three different ways:
- The supervisor's own `bd` invocations (`exec-bd.mjs`'s `execBdSync`/
  `execBdAsync`) -- the supervisor process itself shells out to `bd` for the
  worklist backlog, scope-overlap checks, etc.
- The startup validator's own re-probe of the recorded `bd` path
  (`toolchain.mjs`'s `validateRecordedToolchain()`) -- probing the recorded
  `bd` directly, under a node-less PATH, would report a perfectly good
  recording as a broken `bd`.
- The spawned **sprint child's** own `bd` calls (`spawner.mjs`'s
  `spawnSprint()`) -- fixing which interpreter the child process itself runs
  under (the CONFIGURED tier, above) does not fix what the child inherits as
  *its own* environment: the child shells out to `bd` independently, and
  without this fix its first `bd` call fails with the identical exit 127,
  the very failure mode this whole feature exists to eliminate, just one
  process hop later.

**The one chosen strategy, used at all three sites:** prepend
`dirname(nodePath)` to the child/probe's own search path, rather than
invoking `bd` as `<nodePath> <bdPath>`. This works identically whether the
recorded `bd` is a shebang script (its own `env node` lookup now finds the
recorded node on the amended PATH) or a real native binary (the PATH addition
is inert -- a native binary never shells out to `env`) -- without any call
site having to sniff which kind `bdPath` actually is. The alternative
(`<nodePath> <bdPath>` as the invocation itself) would only work for the
script case and would actively break a native-binary `bdPath` (a native
ELF/Mach-O binary cannot be run as an argument to `node`).

**Case-correct key, always.** The search-path variable is spelled `PATH` on
POSIX and `Path` on Windows. A plain object spread (`{ ...process.env }`)
throws away `process.env`'s case-insensitive lookup, so writing `env.PATH`
unconditionally on Windows creates a **second**, all-caps variable holding
only the prepended entry -- silently dropping every real entry the OS-spelled
`Path` still carried. `src/supervisor/lib/child-path-env.mjs` (`pathEnvKey()`/
`prependToPathEnv()`) is the one shared implementation that resolves the
actual key first, so every call site prepends onto the SAME variable the
child/probe will actually consult, never a shadow copy.

**Prepend, never replace.** Every existing search-path entry is preserved,
in order, behind the new one -- this fixes `node` resolution without taking
away anything the process already had.

## Why two different fallback philosophies for node vs. bd

This is the one deliberate asymmetry running through the whole feature, and
it appears at three of the layers above (the installer, the resolver tiers,
and the startup validator's `ok` gate) for the same underlying reason: a
missing or broken **node** leaves the supervisor with no way to launch a
sprint at all, so every layer treats it as a hard failure the moment it is
the thing that was supposed to be authoritative (an explicit override, or a
recording). A missing or broken **bd** is a degraded-but-still-functional
state -- sprints can still launch and most of the console still works with
`bd` unavailable -- so every layer treats it as "prefer the recording, fall
back to PATH, and say so" rather than a hard stop. Do not "fix" this
asymmetry by making the two binaries behave identically; it is intentional
and traces directly to how the rest of the system depends on each one.

## Invariants for future contributors

- The `toolchain` block and the config's other settings (e.g. `projectDir`)
  are independent in both directions: a bad `toolchain` must never flip
  `configured`/`projectDir` validity, and a bad/absent `projectDir` must
  never force `toolchain` to look unrecorded.
- Only the shared config-reading module ever opens the config file for this
  purpose. Every other module -- the startup validator, the resolvers -- goes
  through it, not around it.
- Version comparison for the minimum Node.js requirement is always numeric
  (major.minor.patch), never a string/lexicographic compare.
- The startup validator must remain side-effect-free beyond its two
  `--version` probes, and must remain fully injectable (exec function,
  platform, filesystem) so every branch (good recording, missing binary,
  too-old node, unprobeable bd, nothing recorded, malformed config) is
  exercisable without a real node, a real bd, or a real config file on disk.
- A probe that cannot complete (times out, or hits a transient spawn error)
  even after one bounded retry is worded distinctly from a probe that
  completed and found nothing usable -- these are different findings and an
  operator must never have to guess which one actually happened.
- **A shared "did this probe merely fail to complete, or did it genuinely
  find nothing" classifier must be checked against every exec shape it will
  actually see, not just the shape it was written against.** Node's
  synchronous child-process API (`execFileSync`) and its asynchronous one
  (`execFile`) do not necessarily populate the same error fields on a
  timeout kill -- a classifier written and tested only against one shape can
  silently treat the other shape's timeout as a genuine, non-retryable
  failure. The practical consequence: a probe that could not complete in
  time gets worded as "does not resolve to a usable runtime," the sentence
  reserved for a truly broken recording, and a launch is refused for a
  binary that is actually fine, just momentarily slow to answer under load.
  Any new caller of the shared classifier must state which exec shape it
  uses and add a case (or a repro) proving the classifier actually recognizes
  that shape's timeout, rather than assuming the existing tests cover it.
