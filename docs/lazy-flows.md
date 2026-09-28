# Flows

A flow is a job made of blocks, run in a fixed order by plain code. It is for
work that is not a code change: a daily timesheet, a standup note, a weekly
summary, a check that reports somewhere. Sprint designs (docs/lazy-sprint-designs.md)
shape the code-sprint engine; flows do not use that engine at all.

The person does not write flows. Claude designs them from a request, following
`skills/fleet/flows.md` (the authoring guide, installed with the fleet skill),
and the person reviews and approves them on the Flows tab.

## Pieces

| File | Role |
|---|---|
| `src/lazy/flows/flow.ts` | Types, validation (`flowProblems`, `flowWarnings`), tool parsing, MCP server lookup, storage, approval. |
| `src/lazy/flows/runner.ts` | The orchestrator, run records, prompts, and the real executor (`claude -p` per agent block, a shell per command block). |
| `src/lazy/flows/api.ts` | `/_lazy/api/flows...` and `/_lazy/api/flow-runs/...`, plus `flowBlocker` for schedules. |
| `src/lazy/ui-flows.ts` | The Flows tab: list, one flow (blocks, approval, runs), one run (every step). |
| `src/lazy/schedules.ts` | Source type `flow`: no project folder needed, runs only while approved. |
| `src/lazy/cli.ts` | `lazyfleet flow check|save|try|run|schedule|list|show|log|delete`. |

State lives under `~/.lazyfleet/`: `flows/<id>.json`, `flows/approvals.json`,
`flow-runs/<run-id>.json` (last 50 per flow), and `flow-work/<id>/` (the
scratch folder of a flow without its own `folder`).

## The orchestrator is code, not a model

`orchestrate()` starts at `start` (or the first block), runs the block, and
follows `next.pass` or `next.fail`. Defaults: pass goes to the next block in
the list, or `end` after the last one; fail goes to `stop`. `end` means the run
passed, `stop` that it failed. A block with `retries` runs again with the
failure notes appended to its prompt before its fail edge is taken. A block
receives the latest output of every block it names in `input`, plus the run
input. The run ends with an error at `limits.maxSteps` block runs (default 25;
the guard for loops) or once `limits.usd` is spent; each agent block also gets
`--max-budget-usd` for what is left.

Every agent block answers with the same structured result, enforced with
`--json-schema`: `{ status: "pass" | "fail", output, notes }`. Routing reads
only `status`. A crash, a timeout or an answer that does not fit the schema
counts as a fail, so retries and fail edges apply to it too.

## What a block may do

An agent block runs as:

```
claude -p <prompt> --model <tier model or exact model> --output-format json
  --json-schema <result schema> --no-session-persistence
  --permission-mode dontAsk --append-system-prompt <flow + block + context files>
  --tools <its built-ins> --allowedTools <its tools> --strict-mcp-config
  [--mcp-config <only the servers it names>] [--max-budget-usd <left>]
```

- `dontAsk` refuses anything not in `--allowedTools` instead of waiting for
  an answer nobody will give.
- `--strict-mcp-config` plus a generated `--mcp-config` loads only the MCP
  servers the block names, copied from the person's Claude Code config (user
  scope, the folder's local scope, the folder's `.mcp.json`). A name that is
  not configured fails validation.
- The block's cwd is the flow's `folder`, so its `CLAUDE.md` loads as usual;
  `context` files are added to the system prompt.
- Blocks run through the lazyfleet proxy like every Claude Code session, so
  secrets are hidden and `{{secret.name}}` placeholders work.

Tiers map to `haiku`, `sonnet` and `opus`, the same aliases the rest of the
fleet uses.

## Trial runs and approval

A trial run gives each agent block only its read-only built-ins (`Read`,
`Grep`, `Glob`, `WebFetch`, `WebSearch`) plus its `trialTools`, tells it to
change nothing and report what it would have done, and skips command blocks
unless they are marked `runInTrial`. Trials need no approval, so Claude can
test a flow before showing it.

A real run, manual or scheduled, needs approval of the exact version: the
approval stores a fingerprint of the whole flow (everything except
`updatedAt`) and a copy of it. Any change makes the state `changed`, and the
page outlines the blocks that differ from the approved copy. The approve call
takes the fingerprint the page showed, so a flow that changed while the person
was reading it cannot be approved by accident. There is no CLI command to
approve.

Schedules with a flow source skip, with the reason in their log, while the
flow is unapproved or changed; "Run now" cannot override that. They do not need
a project folder and do not wait for a clean working tree unless
`requireClean` is set.

## Limits of this first version

- Flows are stored per user only; a project cannot ship flows the way it can
  ship sprint designs.
- A block sees the latest output of its inputs, not the history of a loop.
- The Flows tab is for review only; changes go through Claude.
- MCP servers added through claude.ai connectors are not in the local Claude
  Code config, so blocks cannot use them.
