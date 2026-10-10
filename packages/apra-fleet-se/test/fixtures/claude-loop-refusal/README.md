# claude-loop-refusal

`result.json` is a Claude Code `--output-format json` result event for a
planner dispatch whose reply is COMPLETE (beads created, DAG verified) but
whose one verification call -- a Bash `for ... do bd graph ... done` loop --
was refused, with `is_error: false`. It is shaped like the incident where such
a planner reply was complete yet the sprint failed in planning because of that
single refused loop.

Provenance: the envelope keys and shape follow the sibling recorded fixture
`tests/fixtures/claude-permission-denied/result.json` (copied from a real
result printed by the installed Claude Code CLI). The `permission_denials`
entry uses Claude Code's `{tool_name, tool_use_id, tool_input}` shape; the loop
command, reply text, session id and usage numbers were filled in by hand.
Re-record from a live headless run that refuses a shell loop if the CLI shape
changes.

Consumed by `test/permission-loop-refusal.test.mjs`.
