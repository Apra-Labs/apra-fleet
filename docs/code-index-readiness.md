# Code index readiness, reindex and status

## Self-scoped code tools

Every `code_*` handler resolves its repository from the calling session
(`resolveCodeSelf()`): a member session maps to its registered work folder, any
other session to the server's folder. A repo key supplied in the input is
overwritten, so a caller can never point a code tool at another folder. The old
"single in-flight agent" guessing heuristic is gone.

## Truthful readiness

An index counts as ready only when it has a non-empty `lastCommit`, no
incremental update in progress and no lock. Otherwise code tools throw (not
return) typed errors, so callers see an error result rather than an
empty-looking success:

- `E-CODE-INDEX-NOT-READY` -- missing or still building; the message carries a
  one-line remediation.
- `E-CODE-INTEL-DISABLED` -- code intelligence is switched off.

Errors are thrown because handlers wrap provider results in an ok envelope; a
returned error-shaped object would read as success.

## indexedCommit

Every `code_*` result carries `indexedCommit` (applied centrally by
`withIndexedCommit`), so a consumer can tell which commit the answer reflects
and compare it with the checkout. This holds on every outcome of
`code_reindex` and `code_status` too, and a parameterised test covers every
registered `code_*` tool.

## code_reindex and code_status

- `code_reindex` starts a reindex of the caller's folder (single-flight per
  repo, with a cooldown) and captures the analyzer output to `analyze.log`. It
  checks the first tick so an immediate failure is reported rather than lost.
- `code_status` reports readiness from `status.json` plus the log tail.

Both are member-allowed by the rule that every `code_*` tool is on the member
allowlist. Their schemas live in the memory-contract v1 spec, schemas,
fixtures and roster, and in the client package exports.
