# Antigravity (agy) provider

How apra-fleet drives Google's Antigravity CLI (`agy`, provider key `agy`):
how a member is bound to its own agy project, what fleet writes into it, how
Claude-style grants become agy rules, how refusals come back to the caller,
and what is not covered yet.

agy's own permission and sandbox semantics are defined by Google; this page
only describes what fleet does with them:

- Permissions: https://antigravity.google/docs/permissions
- Terminal sandbox: https://antigravity.google/docs/sandbox

---

## 1. One agy project per member

agy keeps its projects in `~/.gemini/config/projects/<id>.json` on each
machine. A headless run (`agy -p`) enforces a project's `permissionGrants`
only when the run names that project with `--project <id>`. Without it, every
headless run on the machine shares the built-in `default-cli-project`, and a
project file that merely points at the work folder is not picked up. agy also
falls back to `default-cli-project` silently, with exit code 0, when the named
project's file is missing or not valid JSON.

Fleet therefore gives every agy member its own project and never relies on
folder matching or the default project:

| When | What fleet does |
|---|---|
| `register_member` with `llm_provider: "agy"` (member reachable) | Creates the project before the member is saved. If it cannot, the member is **not** registered. |
| `update_member` switching a member to `agy` | Creates the project for the resulting member (new host/folder/shell) before the update is saved. If it cannot, the member is **not** updated. |
| Every `compose_permissions` and `execute_prompt` on an agy member | Verifies the project file: it must exist, parse as a JSON object and carry the member's id. A member with no id, or whose file is missing, corrupt or names another id, gets a new project (and a new id) first. |
| Every agy dispatch | Passes `--project <id>`. A member whose project cannot be created or verified gets a hard failure (`execute_prompt` reason `dispatch_failed`, no LLM call; `compose_permissions` writes nothing). There is no fallback to a run without `--project`. |
| `remove_member` | Deletes the member's project file on its machine, best effort (see below). |

The project id is stored on the member as `agyProjectId` and shown by
`member_detail` and `list_members` (JSON format). A member registered while
unreachable, or before project binding existed, has no id until its next
`compose_permissions` or `execute_prompt`, which creates one.

### Creating a project

Fleet runs, on the member, in its work folder:

```
agy --add-dir <workFolder> --model <cheap-tier model> --output-format json \
    --log-file <temp file> --new-project -p "Reply with only the word OK. Do not use any tools."
```

This costs one short model turn on the cheap tier. agy is spawned directly
from a small node script (no shell), with the member's stored agy credentials
in its environment. The new id is accepted only when exactly one new
`<id>.json` appeared in `~/.gemini/config/projects/` **and** agy's own log
names the same id as the project it created; anything else fails the call with
the evidence. The model's reply is never used (the model does not know the
id). The temporary log is deleted and never echoed. Only one project creation
runs at a time per machine, so the before/after directory listing cannot pick
up another member's project.

### Removing a project

`remove_member` deletes `<agyProjectId>.json` (and any leftover fleet-created
project file for that member from older fleet versions) from the member's
`~/.gemini/config/projects/`. It is skipped when another registered member
has the same `agyProjectId`. Any failure - member offline, permission denied -
is returned as a warning; the member is removed from the registry regardless.

---

## 2. The project file

agy writes `id`, `name` and `projectResources` when it creates the project.
Fleet adds only the nested grants block and leaves everything else as agy
wrote it:

```json
{
  "id": "1afd6dbb-498f-4918-a9d9-6da64b75a204",
  "name": "my-repo",
  "projectResources": { "resources": [ { "folderUri": "file://C:/work/my-repo" } ] },
  "permissionGrants": {
    "permissionGrants": {
      "allow": [ "read_file(*)", "command(git)", "command(regex:git .*)", "mcp(apra-fleet/kb_query)" ],
      "deny":  [ "mcp(apra-fleet/remove_member)", "mcp(apra-fleet-member/remove_member)" ]
    }
  }
}
```

- Every rule is an `action(target)` string. Fleet emits only the actions agy
  accepts (`command`, `read_file`, `write_file`, `read_url`, `mcp`,
  `execute_url`, `unsandboxed`); anything else is dropped rather than written.
- No `ask` list is ever written: a headless run cannot prompt, so agy treats
  ask as deny.
- `projectResources` does not affect grants under `--project`; the run's
  workspace comes from `--add-dir <workFolder>`.
- Fleet writes only this one file. It never edits `default-cli-project.json`,
  other projects, or agy's user-level `settings.json` on a member.

Every write is a read-merge-write followed by a read-back check: if the file
on disk does not structurally match what fleet intended, `compose_permissions`
fails and the ledger is not updated.

### Full compose vs reactive grant

- **Full compose** (`compose_permissions` with `role`/`tags`) is the complete,
  authoritative set: it **replaces** `allow` and `deny`.
- **Reactive grant** (`compose_permissions` with `grant`) **adds**: the new
  rules are unioned into the existing `allow`/`deny` arrays, so nothing the
  member already had is lost. Grants still pass the never-auto-grant gate
  (see [compose_permissions design](compose-permissions-design.md)).

### Deny rules for orchestrator-only tools

`deny` always lists every orchestrator-only fleet MCP tool under both server
names a member may see (`apra-fleet` and `apra-fleet-member`): member
lifecycle and registry tools, `execute_prompt`/`execute_command`, file
transfer, auth and credential-store tools, `compose_permissions`,
`shutdown_server`, messaging/email, and the administrative knowledge-base
tools (`kb_promote`, `kb_import`, `kb_export`, `kb_harvest`, ...). Tools a
member legitimately uses - code intelligence (`code_*`) and the read/capture
knowledge-base tools (`kb_session_prime`, `kb_query`, `kb_stats`,
`kb_capture`, `kb_feedback`, `kb_list`) - are not denied; whether they are
allowed depends on the composed grants. A deny rule wins over a matching
allow rule.

---

## 3. Mapping Claude-style grants to agy rules

Fleet composes permissions in Claude Code syntax (profiles, tags, ledger,
reactive grants) and converts them per provider. For agy:

| Claude grant | agy rule(s) |
|---|---|
| `Read`, `Glob`, `Grep` | `read_file(*)` |
| `Write`, `Edit` | `write_file(*)` |
| `Read(<path>)`, `Glob(<path>)`, `Grep(<path>)` | `read_file(<path>)` (see path rules) |
| `Write(<path>)`, `Edit(<path>)` | `write_file(<path>)` (see path rules) |
| `Bash`, `Bash(*)` | `command(*)` |
| `Bash(git:*)`, `Bash(git *)`, `Bash(git*)` | `command(git)` and `command(regex:git .*)` |
| `Bash(npm run:*)` | `command(npm run)` and `command(regex:npm run .*)` |
| `Bash(npm test)` (no wildcard) | `command(npm test)` only |
| `mcp__<server>__<tool>` | `mcp(<server>/<tool>)` |
| `WebSearch`, `Web`, `Fetch` | `read_url(*)` |
| `Agent`, or any token with no agy action | dropped |

### Command rules: why each prefix grant becomes two rules

`command(<cmd>)` alone is not a reliable prefix grant (see agy's permissions
page, cross-platform command matching):

- **Windows**: agy matches a command line it cannot split into words
  (PowerShell/cmd) character for character, so `command(git)` allows only a
  bare `git`, not `git status --short --branch`.
- **Linux/macOS**: agy splits command lines into words and prefix-matches, so
  `command(git)` does allow `git status --short --branch`. But command or
  process substitution (`$(...)`), backticks, brace expansion and fd
  redirections disable prefix matching; such a line needs a full-line match.

A `regex:` target is matched against the full raw command line on every OS.
So a prefix grant `Bash(<cmd>:*)` is written as the bare command plus
`command(regex:<cmd> .*)` (regex metacharacters in `<cmd>` escaped), on every
OS. The pair allows `<cmd>` alone and `<cmd>` with any arguments, including
`git log -1 --format=%h $(git rev-parse HEAD)`. An exact grant (no wildcard)
stays exact: only that command line.

Linux/macOS agy reports a refused shell command as the `unsandboxed` action in
its transcript; `command(...)` rules grant it. Fleet never writes
`unsandboxed(...)` rules.

### Path rules

agy path targets are plain paths, have no globs, and grant a directory
recursively. Fleet reduces each Claude path pattern accordingly:

- a leading `~` becomes the member's home directory, resolved by fleet (never
  by shell expansion); on Windows it is written with forward slashes, e.g.
  `C:/Users/alice/notes`;
- a trailing `/**` or `/*` becomes the directory itself;
- a bare `*` or `**` is the global wildcard `*`;
- any other glob (for example `Write(feedback-*.md)`) cannot be expressed:
  the grant is dropped and `compose_permissions` lists it under `Warnings:` in
  its result. So is a `~` path when the member's home directory is unknown.
  Grant a directory or an exact path instead.

Tokens with no agy action (`Agent`, unknown tokens) are dropped too; those
drops are recorded in the fleet server log, not in the tool result.

---

## 4. Permission denials and the heal loop

A headless agy run that needs a grant it does not have cannot prompt: agy
refuses the tool call, exits 0 with `status: "SUCCESS"` and usually an empty
reply, and reports the refusal in its JSON result (`denied_actions`), on
stderr ("... headless mode cannot prompt for, so it was auto-denied") and as
an ERROR step in the session transcript naming the concrete target. After agy
exits, fleet prints that transcript from disk so the target is available.

`execute_prompt` turns any of these signals into a structured failure instead
of an empty response:

```json
{
  "isError": true,
  "reason": "permission_denied",
  "permissionDenied": {
    "actions": ["command"],
    "denials": [{ "action": "command", "target": "git status --short --branch" }],
    "suggestedGrants": ["Bash(git:*)", "Bash(git status --short --branch)"],
    "hint": "agy auto-denied command \"git status --short --branch\" (headless mode cannot prompt for permission). Grant it with compose_permissions grant: [\"Bash(git:*)\"] and retry. ...",
    "signals": ["result_json", "stderr", "transcript"]
  },
  "sessionId": "..."
}
```

- The JSON result is authoritative when present; only transcript steps from
  the current turn are read, so an old denial in a resumed conversation is
  not reported again.
- `suggestedGrants` lists the primary grant first. For a `command` or
  `unsandboxed` denial that is the prefix grant `Bash(<first word>:*)`,
  followed by the exact command line as the narrower alternative. A line with
  `$(...)` gets only the prefix grant; a line with `|`, `;`, `&&` or backticks
  gets none, because `compose_permissions` refuses shell chaining. Other
  actions map to `Read(<path>)`, `Write(<path>)`, `mcp__<server>__<tool>` or
  `WebSearch`; an action with no mapping yields no suggestion and the hint
  says to grant it by hand or escalate.
- Any partial reply is kept in `response`.
- On Linux/macOS `actions` can read `["unsandboxed", "command"]` for one
  refused shell command.

**Heal loop** (driven by the caller, typically the orchestrator): read
`permissionDenied` (`permissionDenialOf(result)` in apra-fleet-client; the
workflow layer forwards it on `AgentDispatchError.details.permissionDenied`),
review `suggestedGrants`, call `compose_permissions` with `grant` (and
`project_folder` to record it in the ledger), then re-dispatch, resuming the
session if useful. The server never grants anything on its own.

---

## 5. Dispatch

An agy dispatch runs, in the member's work folder:

```
agy --add-dir <workFolder> --project <agyProjectId> --model <model> --output-format json \
    [--agent <name>] -p "<instruction>" [--conversation <id> | --continue] <permission mode flag>
```

- `--add-dir` is what gives agy its workspace; agy does not adopt the process
  working directory.
- `--model` takes agy's model slug ids (as listed by `agy models`). Fleet maps
  the cheap/standard/premium tiers to default slugs; override them per tier in
  `config.json` in the fleet data directory (see [install](install.md)).
- `--agent <name>` activates a role agent from
  `<workFolder>/.gemini/antigravity-cli/agents/` or
  `~/.gemini/antigravity-cli/agents/`. Role-agent files are transformed for
  agy at install/provision time, including provider-conditional prose in the
  body (see [agent transform conditionals](features/agent-transform-provider-conditionals.md)).
- Sessions resume with `--conversation <id>`. The stall detector watches
  agy's session transcripts under `~/.gemini/antigravity-cli/brain/`.
- No workspace-trust seeding is needed or done for agy: grants bind through
  `--project`.

### Unattended modes

| `unattended` | agy flag |
|---|---|
| unset / `false` | `--mode accept-edits` |
| `"auto"` | `--mode accept-edits` (agy has no broader safe mode; fleet logs a warning) |
| `"dangerous"` | `--dangerously-skip-permissions` (bypasses every grant and deny rule) |

`accept-edits` auto-approves file edits in the workspace; everything else
(commands, reads outside the workspace, MCP tools, URLs) needs a grant in the
member's project.

---

## 6. Global skills

agy has no per-member, per-project or per-session way to hide user-level
skills: skills installed under `~/.gemini/antigravity-cli/skills/` on a
machine are visible to every agy run there, and skills have no permission
action that a deny rule could block. On every `compose_permissions`, fleet
checks the member for the `pm` and `fleet` skills and, if either is present,
adds a warning to the result naming them (a check that cannot run is also a
warning). The enforced boundary is the MCP deny list above: a member that sees
the orchestrator skills still cannot call orchestrator-only fleet tools.

For a local agy member, which shares the orchestrator's home directory,
`register_member` also writes empty `.ignore` markers under
`<workFolder>/.gemini/antigravity-cli/` for the `apra-fleet` MCP server and
the `pm`/`fleet` skills. The skills warning is still emitted, because agy does
not document these markers as hiding user-level skills.

---

## 7. Orchestrator install (`apra-fleet install --llm agy`)

On the machine where agy is the orchestrator's CLI, install merges fleet's
entries into agy's user-level configuration without overwriting other
content, and uninstall removes only those entries:

- MCP server `apra-fleet` in `~/.gemini/config/mcp_config.json`;
- fleet hooks in `~/.gemini/config/hooks.json`;
- status line, default model and `read_file(...)` rules for the installed
  skill and agent directories in `~/.gemini/antigravity-cli/settings.json`;
- `pm`/`fleet` skills and role agents under `~/.gemini/antigravity-cli/`.

This is the orchestrator's own setup. Member grants live only in each
member's project file (section 2).

Authentication: agy uses a browser Google login per machine or the
`ANTIGRAVITY_API_KEY` environment variable. For a remote member, provide an
API key (`provision_llm_auth` with `api_key` stores it encrypted and sets the
variable on the member). Local members use the host's own login.

---

## 8. Known limitations and future work

- **Terminal sandbox not used.** Fleet never passes agy's sandbox options, and
  agy's CLI default is sandbox off, so member commands run unsandboxed and are
  governed only by the project's grants. Enabling the sandbox is future work:
  on Linux it can require the host to allow unprivileged user namespaces
  (AppArmor), and its semantics on Linux and macOS - including how
  `unsandboxed(...)` rules act as sandbox escapes - are not mapped by fleet
  yet. See https://antigravity.google/docs/sandbox.
- **Deny-rule hits are not reported as `permission_denied`.** A call refused
  by an explicit deny rule shows up only in the model's reply text and the
  transcript (no `denied_actions`), so the dispatch looks successful.
- **Globs in path grants** cannot be expressed; such grants are dropped with
  a warning (section 3).
- **Tokens without an agy action** (`Agent`, unknown tokens) are dropped and
  logged only in the server log, not returned as warnings.
- **Global skills** stay visible to agy members (section 6).
- **No command deny rules** are composed today; the deny list covers fleet MCP
  tools only. A future command deny rule must use the same bare-plus-regex
  form as the allow rules so it matches full command lines.
