# Running auto-sprint

This doc exists because it is easy to reach for the wrong launcher. There are
two different things in this repo/session that are both called "auto-sprint",
and only one of them is the real thing.

## The only correct way to launch a real sprint

Run `packages/apra-fleet-se/bin/cli.mjs` directly with a real Node.js process,
in the background, and watch it via its dashboard viewer HTTP endpoint. This
is a genuine, long-running Node process -- not a Claude Code Skill or
Workflow invocation.

```bash
node packages/apra-fleet-se/bin/cli.mjs \
  --issue apra-fleet-7pm \
  --members fleet-reorg \
  --branch feat/fleet-reorg \
  --base main \
  --viewer-port 18300 \
  > /path/to/auto-sprint.log 2>&1 &
disown
```

Required flags: `--issue`, `--members`, `--branch`, `--base`. See
`node packages/apra-fleet-se/bin/cli.mjs --help` for the full flag list
(`--goal`, `--max-cycles`, `--allow-missing-members`, `--requirements-file`,
`--role-map`, `--viewer-port`, `--budget`).

Once it starts, `console.log` in `bin/cli.mjs` prints the dashboard URL
(`http://localhost:<viewer-port>`); use a browser tool to watch progress
there rather than tailing raw stdout.

Always use `nohup`-style backgrounding (`&` + `disown` on POSIX, or an
equivalent detached start on Windows) -- a plain `&` tied to a single tool
call's process group can be killed when that tool call returns, silently
orphaning the sprint mid-run.

## What NOT to do: the Claude Code `Workflow` tool

`packages/apra-fleet-se/auto-sprint/runner.js` (the actual sprint engine,
loaded at runtime by `bin/cli.mjs` via `engine.executeFile()`) is plain
Node.js: it uses `require('fs')`, `require('path')`, and shells out to real
`node -e "..."` one-liners for JSON post-processing.

Claude Code's own `Workflow` tool (a separate, unrelated orchestration
feature for fanning out sub-agents) also happens to be invocable with
`name: "auto-sprint"` if a same-named skill/workflow file has been copied
into `~/.claude/workflows/`. Do not use it for this. That tool executes
scripts in a sandboxed JS context with **no `require`, no filesystem
access, and no real Node.js APIs** -- calling
`Workflow({ name: "auto-sprint", args: {...} })` fails immediately with
`Error: require is not defined`, before any sprint phase runs. The two
"auto-sprint" names are unrelated: one is a real Node CLI, the other is a
Claude-Code-internal sub-agent-fanout script format. Only the CLI form
above is the real sprint.

## Preconditions worth checking first

- The target issue (e.g. `apra-fleet-7pm`) must exist and be open:
  `bd show <issue>`.
- Every `--members` name must be registered with the fleet
  (`list_members`); an unregistered member aborts the sprint unless
  `--allow-missing-members` is passed.
- Multi-member sprints require all configured members to share the same
  git HEAD (`checkMemberTopology`) -- see `auto-sprint-diagram.md` for the
  supported-topology notes. Stick to single-member unless that's verified.
- The sprint branch (`--branch`) is created from `--base` if it does not
  already exist; if it already exists (e.g. resuming on the current
  working branch), it is reused as-is.
