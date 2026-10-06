# Supervisor reliability invariants

Design notes for three behaviours of the fleet-sprint supervisor and engine that are easy to
break and non-obvious from the code.

## Synced-mode topology probes parse command output

`checkMemberTopology` runs three probes per member (HEAD / git remote origin / beads-Dolt pull).
The member command tool returns an envelope, not raw stdout. `commandResultStdout()` in
`fleet-sprint/git-topology.mjs` is the single place that extracts the real stdout:

- prefer `structuredContent.stdout`;
- otherwise use the text with the `Exit code: N` line removed;
- normalise CRLF to LF (Windows members);
- throw, naming the member and exit code, on a non-zero exit or an error result.

Rule: probes must compare the parsed stdout, never the envelope text. Comparing envelopes
makes two identical members look different (or two different members look equal) because the
envelope carries volatile framing. A synced launch on members with differing HEADs must pass;
legacy mode must still refuse differing HEADs.

## Terminal reason is read from the engine's own record

The run viewer overwrites the top-level `terminalReason` in the run state, so the watchdog
cannot trust it. `readTerminal()` in `src/supervisor/watchdog.mjs` prefers
`extensions.terminal.terminalReason` (written by the engine) and falls back to the top-level
value. Both the finished-detail text and the finished-record path use it.

`src/supervisor/terminal-reasons.mjs` is the class table for terminal reasons. The relaunch
gate (reasons that block automatic relaunch) is derived from it, and currently contains
exactly `BEADS_SYNC_CONFLICT`. `history.mjs` derives its set from the same table; add new
reasons to the table, not to ad-hoc lists. Test fixtures must seed the real engine+viewer
shape (engine value nested, viewer value at top level) and assert the top-level value is not
what drives the decision.

## Dolt mutex holder survives supervisor restart

`src/supervisor/dolt-mutex.mjs` is the global lock that serialises Dolt pushes across members.

- **Persistence**: the holder is written to `<dataDir>/mutex.json` on grant, renew, release
  and reclaim, through a serialized tmp-file + rename chain. A write failure is logged and
  never thrown, so a disk problem cannot fail a lock operation.
- **Restore**: `start()` reloads the holder. It is dropped (with a log line) if its lease has
  expired or its pid is dead. Corrupt JSON or an unknown file version yields a warning and no
  holder (fail open to "unheld", never crash).
- **Stop**: `stop()` leaves the file in place and waits for queued writes to flush, so a
  restart honours a holder that was legitimately mid-push.
- **API semantics**: while stopping, requests get `503` with `retryable: true`; renew by a
  non-holder gets `409 not-holder`; acquire is idempotent only for the live holder presenting
  its own token on the same sprint id (any other re-acquire is refused rather than silently
  handing over the lock).
- Tests that construct a mutex must use a temp `dataDir` so they never share a `mutex.json`.

## Service token re-resolves lazily, with a bounded grace for the old token

The supervisor's API guard does not capture its service token once at start.
It re-resolves the token source on demand, so a supervisor started before
`fleet.key` existed converges on the key-derived credential without a restart.
When the token changes, the previous token is still accepted for a bounded grace
window (24 hours) so in-flight callers are not cut off mid-rotation. When
`createSupervisor` has no token source at all it warns once rather than failing
silently.

## Dashboard sign-in is a same-origin POST, never a URL token

The dashboard session is established by a paste-token form that POSTs to
`/signin`. The handler checks `Sec-Fetch-Site` and `Origin`/`Host` first, then
compares the token with a constant-time comparison, caps the body (8 KiB), and
sanitizes `next` to a root-relative path. A `GET` carrying `?token=` is refused
with 400 and never compared or turned into a cookie, because tokens in URLs leak
via history, logs and referrers. Instructions and examples must keep the key out
of argv and URLs (use clipboard or stdin paths).
