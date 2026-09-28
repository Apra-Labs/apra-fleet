# Flows: fixed jobs made of blocks

A flow is a job the user wants done the same way every time, often on a schedule:
fill in the timesheet each evening, post a standup note, summarise the week,
check a service and report. It is a short chain of blocks. Each block has one
job written in plain words, a model tier, the tools it may use, and where to go
on pass and on fail. Plain code runs the blocks in order and passes outputs
along; the models only do the work inside each block.

Use a flow, not a sprint, when the job is not "change this codebase": no
planning, no building, no code review. Use a sprint for code work
(`autonomy.md`). Only when lazyfleet is installed (`~/.lazyfleet/config.json`
exists).

The user never writes flows. You design one from what they ask for, test it,
and send them to review it. They approve it on the Flows page; only an approved
version runs for real or on a schedule, and any change needs their approval
again. You cannot approve for them.

## The loop

1. **Design it.** Write the flow JSON to a scratch file (format below). Use as
   few blocks as the job needs, the cheapest tier that can do each job, and the
   narrowest tools.
2. **Check it.** `lazyfleet flow check <file>`. Fix every problem it lists.
3. **Save it.** `lazyfleet flow save <file>`. It prints the review link.
4. **Try it.** `lazyfleet flow try <id>`. A trial run gives blocks only
   read-only tools (plus the `trialTools` you listed), skips command blocks
   unless marked `runInTrial`, and tells each block to change nothing and say
   what it would have done. It prints every step. Fix and repeat until the
   output is what the user wants.
5. **Schedule it, if they asked for that.** `lazyfleet flow schedule <id> --at
   18:30 --days mon-fri` or `--every 6`. It skips until approved.
6. **Hand it over.** Tell the user in plain words what the flow does, block by
   block, what the trial showed, when it will run, and give them the review
   link to approve it. Do not run it for real before they approve.

To change a flow: edit the JSON, `check`, `save`, `try`, and send the link again.
The page shows which blocks changed since their approval.

## The file

```json
{
  "id": "daily-timesheet",
  "name": "Daily timesheet",
  "purpose": "Log what I worked on today to the company timesheet.",
  "folder": "/home/me/timesheet",
  "context": ["PREFERENCES.md"],
  "limits": { "usd": 0.5 },
  "blocks": [
    {
      "id": "gather",
      "tier": "cheap",
      "purpose": "List what I worked on today: commits in ~/code since 09:00, with repo names and rough hours.",
      "tools": ["Read", "Bash(git log:*)"]
    },
    {
      "id": "log",
      "tier": "cheap",
      "purpose": "Write today's timesheet rows from the summary. First read today's entries; if there are rows already, change nothing and pass.",
      "input": ["gather"],
      "tools": ["mcp:timesheet"],
      "trialTools": ["mcp:timesheet/get_today_entries", "mcp:timesheet/get_user_context"],
      "retries": 1
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `id` | Lowercase letters, digits, dashes; up to 40. Saving the same id replaces that flow. |
| `purpose` | What the whole flow is for. Every block is told. |
| `folder` | Optional. Where blocks work. Its `CLAUDE.md` is read by every agent block, so the user's standing instructions live there. Without it, the flow gets a scratch folder of its own. |
| `context` | Optional files in `folder` given to every agent block: preferences, templates, rules. Up to 10, 64 KB each. |
| `start` | Optional first block (default: the first). |
| `limits.usd` | Stop a run after about this much usage. Always set it. |
| `limits.maxSteps` | Stop after this many block runs (default 25); the guard for loops. |

Blocks:

| Field | Meaning |
|---|---|
| `id` | Other blocks point here with it. Not `end` or `stop`. |
| `name` | Optional display name. |
| `kind` | `agent` (default): a model does `purpose`. `command`: one shell command, passes on exit 0. |
| `purpose` | The block's whole job and its prompt. Say what done looks like, and what to do when the work is already done. |
| `tier` | `cheap` (haiku), `standard` (sonnet, default), `premium` (opus). |
| `model` | An exact model instead of the tier, e.g. `claude-sonnet-5`. |
| `tools` | Built-in: `Read`, `Grep`, `Glob`, `Write`, `Edit`, `Bash`, `WebFetch`, `WebSearch`, optionally narrowed like `Bash(git log:*)` or `Write(notes/*)`. MCP: `mcp:<server>` (all its tools) or `mcp:<server>/<tool>`. The server must be in the user's Claude Code config (`claude mcp list`); only the servers a block names are loaded for it. Anything not listed is refused. |
| `trialTools` | The part of `tools` that only reads, allowed in trial runs (e.g. an MCP server's get/list tools). |
| `input` | Blocks whose latest output this block receives. |
| `next.pass` / `next.fail` | A block id, `end` (the flow passed) or `stop` (the flow failed). Defaults: pass goes to the next block in the list (or `end`), fail goes to `stop`. Pointing back makes a loop, e.g. a check that fails back to the writer. |
| `retries` | 0-3. Runs the block again, with why it failed, before taking `next.fail`. |
| `timeoutMinutes` | Default 15. |
| `command` | For `kind: command`: one line, run in the folder. Gets `FLOW_INPUT` and `FLOW_OUT_<BLOCK_ID>` in its environment. |
| `runInTrial` | A command that only reads runs in trial runs too. |

Every agent block answers with `{status, output, notes}`: `output` is all the
next blocks see from it, so its purpose should say what to put there.

## Designing well

- **One job per block, and only when it needs a different model or tools.**
  Gathering (read-only, cheap) and acting (write tools) is a good split; five
  blocks for a one-step job is not.
- **Cheapest tier that works.** Collecting, formatting and filling in forms:
  `cheap`. Judgement, writing for people, tricky reasoning: `standard`.
  `premium` only for a block that failed on `standard` in a trial.
- **Make acting blocks safe to repeat.** A schedule can fire again after a
  failure; tell the block to check what is already there first.
- **Check blocks** are agents whose purpose is a rule ("pass only if every
  project from the summary has a row"); send `fail` back to the block that
  should fix it, and keep `limits.maxSteps` low.
- **Secrets**: never write a secret into a flow. Name a vault preset in the
  purpose (`{{secret.name}}`); it is filled in when the tool runs.
- **Personal details** (name, default project, style) belong in the folder's
  `CLAUDE.md` or a `context` file, not repeated in every purpose.

## Other commands

`lazyfleet flow list`, `flow show <id>` (blocks, approval, runs), `flow log
<run-id>` (every step with its output), `flow run <id>` (for real, once
approved, when the user asks), `flow delete <id>`.
