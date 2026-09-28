# Sprint-Runner Resolution: Never Trust `process.execPath` Blindly

The always-on supervisor spawns each sprint as a child process running
fleet-sprint's CLI entry point. What Node.js binary that child is spawned
with is not as obvious as it looks, because the supervisor itself runs in two
very different shapes:

- As a plain `node bin/serve.mjs` process (dev mode, or a manually-started
  supervisor) -- here `process.execPath` genuinely is a real Node.js runtime,
  and using it to spawn the child is correct.
- As the installed single-executable binary's `supervisor` subcommand,
  running on an embedded Node runtime bundled into the binary itself -- here
  `process.execPath` points at the *binary*, not at a general-purpose `node`.
  Spawning `<binary> <path-to-cli.mjs>` fails immediately: the binary parses
  its own CLI flags and rejects the child script path as an unknown option.

A supervisor that defaults to `process.execPath` unconditionally works in the
first shape and silently breaks in the second -- and the break only surfaces
at sprint-launch time, not at supervisor startup, so it looks like a
random one-off failure rather than a structural one.

## Resolution order

The supervisor resolves which Node.js binary to spawn a sprint with, once
per process lifetime, through a fixed, three-tier order:

1. **An explicit operator override** (an environment variable naming a
   Node.js binary). Honored even if it resolves to a version below the
   minimum the workflow requires -- the operator named this interpreter
   deliberately, so a below-minimum override is surfaced as a version
   mismatch, never silently skipped in favor of a later tier.
2. **The current process's own execPath**, but *only* when this process is
   confirmed to be a real Node.js runtime and not a single-executable binary
   (checked via Node's own `node:sea` API, defensively: an unrecognized or
   unexpectedly-shaped `node:sea` module is treated as "not a SEA binary,"
   the safer default that preserves today's behavior rather than crashing
   resolution outright).
3. **`node` resolved from PATH**, gated at the same minimum version the rest
   of the toolchain requires. Version comparison is always numeric
   (`22.9.0` must never compare "greater than" `22.16.0` under a naive string
   comparison -- that class of bug is exactly what a purely numeric
   major/minor/patch comparison avoids).

If none of the three tiers resolves to a usable runtime, resolution throws a
dedicated, class-checkable error naming every candidate tried (with the
specific reason each failed -- not found, probe failed, or below minimum
version) and a single operator-facing fix line.

## Where resolution runs, and why it is lazy and cached

Resolution does **not** run at supervisor startup. A supervisor with no
usable Node.js runtime on the host must still start and keep serving the
console, dashboard, and health endpoints -- only an actual *launch attempt*
should fail. Resolution instead runs lazily, inside the sprint-launch call,
and strictly before any other side effect of launching a sprint (port
allocation, per-sprint log file creation, claiming a ledger reservation) --
so a failed resolution leaks none of those.

A **successful** resolution is cached for the rest of the process's
lifetime: the Node.js runtime available to a running supervisor process
cannot change while it stays up, so re-probing on every launch would be pure
waste. A **failed** resolution is deliberately never cached -- a transient
problem (PATH not yet populated at the moment of an early launch attempt, a
momentarily-broken override) can heal itself on a later launch attempt
without requiring a full supervisor restart.

A failed resolution is surfaced to the launch API caller as a distinct HTTP
status (not a generic 500), carrying the operator-facing fix line, and is
recognized by checking the thrown error's own class/discriminating property
-- never by string-matching its message. Message text is for humans; the
class is the contract a caller programs against.

## Windows quoting: the probe path must be quoted, the resolved command must not be

Probing a candidate binary's version (`<candidate> --version`) on Windows
goes through a shell, because both `node` and an operator override routinely
resolve to a `.cmd`/shim that Node refuses to spawn directly. Routing a
*fixed, non-interpolated* argv array through a shell for a version probe is
safe; the danger is specific to how `cmd.exe` re-parses its own command line
when the candidate path itself contains a space (a default Windows install
path being the common case). Quoting the candidate path defeats an outer
unquoting step `cmd.exe` would otherwise perform, keeping the whole spaced
path as one token instead of letting it split into two. This quoting is
strictly probe-internal: what resolution *returns* to its caller is always
the original, unquoted path -- only the probe's own shell invocation needs
the extra quoting.

## Known gap: a resolved shim can still fail to spawn

Resolution's own probes run with a shell (`shell: true` on Windows), so a
`.cmd`/shim candidate can pass resolution. The supervisor's actual spawn of
the sprint's child process, however, does not use a shell. A shim that only
works when invoked through a shell can therefore pass resolution and still
fail at the real spawn -- resolution's probe environment and the spawn's own
environment are not perfectly symmetric. This is a known, tracked gap, not a
silently-accepted one: closing it means either probing without a shell (so a
probe failure predicts a spawn failure) or spawning with the same shell
semantics the probe uses.
