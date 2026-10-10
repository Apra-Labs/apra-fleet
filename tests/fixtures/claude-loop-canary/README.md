# claude-loop-canary

Claude Code `--output-format stream-json --verbose` output for the canary
dispatch of `scripts/claude-cli-loop-canary.mjs` (the `CANARY_PROMPT` asking
for one `for f in alpha beta gamma; do echo "canary-$f"; done` call, in
acceptEdits mode, under an allowlist of Read/Glob/Grep/`Bash(echo:*)`/
`Bash(ls:*)`).

- `loop-refused-complete.jsonl` -- RECORDED from a live headless run of
  Claude Code 2.1.296 (the latest npm release on 2026-10-10). The CLI refused
  the loop ("A variable in this command can't be checked before it runs"),
  listed it in `permission_denials`, and still replied `CANARY-REPLY
  refused`. Only the temp-dir paths were rewritten to `/tmp/claude-canary`.
- `loop-refused-incomplete.jsonl` -- derived by hand from the recording: the
  final assistant text event is dropped and the result event's `result` is
  empty (the turn ended without a reply).
- `loop-refused-outside-policy.jsonl` -- derived from the incomplete variant:
  the loop body runs `curl -s ...`, which the allowlist does not cover.
- `auth-failure.jsonl` -- hand-made from the recording's init and result
  events: `is_error: true` with an invalid-API-key result, the CLI's shape for
  a rejected credential.

Consumed by `tests/claude-cli-loop-canary.test.ts`. Re-record the first file
by running the canary's dispatch against a newer CLI if the stream shape
changes.
