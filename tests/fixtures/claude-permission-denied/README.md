# claude-permission-denied

`result.json` is a Claude Code `--output-format json` result event for a
plan-reviewer dispatch whose `bd` calls were refused ("This command requires
approval"), with `is_error: false` and a complete-looking reply.

Provenance: the envelope keys and shape are copied from a real result printed
by the installed Claude Code CLI on this machine (2026-10-06; that run itself
failed auth, so it carried an empty `permission_denials`). The
`permission_denials` entries use Claude Code's `{tool_name, tool_use_id,
tool_input}` shape and were filled in by hand, as were the reply text and usage
numbers. Re-record from a live headless run that has `bd` disallowed if the CLI
shape changes.
