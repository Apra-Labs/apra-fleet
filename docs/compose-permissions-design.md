# compose_permissions design

`compose_permissions` is how fleet gives a member a least-privilege permission
set. It **composes** one canonical allow list and then **delivers** it in the
member's provider-native format, verified on disk.

---

## 1. Composition

The canonical format is Claude Code's permission syntax:

- file tools: `Read`, `Write`, `Edit`, `Glob`, `Grep`, optionally path-scoped
  (`Write(docs/**)`, `Edit(feedback.md)`);
- shell: `Bash(git:*)` (a command prefix), `Bash(npm test)` (an exact command
  line);
- MCP tools: `mcp__<server>__<tool>` (e.g. `mcp__apra-fleet__kb_query`).

```mermaid
flowchart TD
    R[Role / primary mode: doer or reviewer] --> Base["Base profile (base-dev / base-reviewer)"]
    S[Work folder] --> Stack["Stack detection (node, python, go, rust, ...)"]
    T["Tags (gpu, devops, ...)"] --> Tag["Tag profiles (tag-*.json)"]
    L["permissions.json ledger"] --> Ledger["Ledger grants"]
    G["Reactive grant"] --> Gate["Never-auto-grant gate + co-occurrence expansion"]
    Base --> Allow[Canonical allow set]
    Stack --> Allow
    Tag --> Allow
    Ledger --> Allow
    Gate --> Allow
    Allow --> Adapter{Provider adapter}
    Adapter --> Deliver["Verified delivery (merge, write, read back)"]
```

- **Full compose** (`role` and/or `tags`): base profile for the primary mode,
  plus stack profiles for the detected stacks, plus tag profiles, plus the
  project ledger's past grants. The merge is additive and order-independent.
- **Reactive grant** (`grant: [...]`): adds specific permissions to what the
  member already has, typically after a permission denial. Co-occurring
  grants are expanded (e.g. docker with docker-compose). With
  `project_folder`, each grant is recorded in the ledger so future composes
  include it.

### Never auto-granted

Every `grant` entry, from any caller, is checked against a denylist matched
by wildcard against a normalized form of the request, and rejected outright
on a hit: `sudo`/`su`/`doas`, `bash -c`/`sh -c`/`eval`, `env`/`printenv`,
`nc`/`nmap`, `chmod 777`, any catch-all such as `Bash(*)`, and any payload
containing a shell-chaining metacharacter (`|`, `;`, `&&`, backtick, `$(`).
These need a human decision.

---

## 2. Delivery

Each provider adapter converts the canonical set and names the file it lives
in:

| Provider | Target | Notes |
|---|---|---|
| Claude | `<workFolder>/.claude/settings.local.json` | Passed through as `permissions.allow`; a grant is merged into the existing list. |
| Antigravity (agy) | `~/.gemini/config/projects/<agyProjectId>.json` on the member | The member's own agy project, bound with `--project` on every dispatch. See [Antigravity (agy) provider](agy-provider.md). |
| Codex | `<workFolder>/.codex/config.toml` | Role-based approval settings. |
| Copilot | `<workFolder>/.github/copilot/settings.local.json` | JSON allow list. |
| OpenCode | `<workFolder>/.opencode/settings.json` | |

Delivery is the same for every provider and transport (local process or
SSH):

1. Resolve the target path. A home-anchored path (`~/...`) is resolved from
   the member's home directory, determined by fleet, never by shell
   expansion; if it cannot be determined, delivery fails rather than writing
   to the wrong place.
2. Read the existing file and merge the new content into it, preserving keys
   fleet does not own. On a full compose the provider's permission arrays are
   replaced by the composed set; on a reactive grant they are extended (Claude
   by merging its allow list first, agy by unioning its allow/deny arrays).
3. Write with a shell-appropriate command (POSIX or PowerShell, by the
   member's registered shell).
4. Read the file back and compare it structurally with the intended content.
   Any mismatch fails the call; the ledger is updated only after every file
   landed.

Provider-specific warnings (for example grants a provider cannot express) are
returned under `Warnings:` in the result. After delivery, workspace trust is
seeded for providers that need it (Claude).
