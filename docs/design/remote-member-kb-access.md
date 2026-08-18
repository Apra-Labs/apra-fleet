# Remote-member KB access: problem statement and design

Status: proposal
Branch: `feat/remote-member-kb-access`
Base: `feat/code-intelligence-abstraction` @ 89ed5bbc

## 1. Where we are

A dispatched agent on a remote member cannot reach the KB at all -- not read, not
write, not at dispatch time, not mid-session. Everything it knows arrives as text
pasted into the prompt before it starts.

Three independent causes, any one sufficient:

1. **No MCP server exists on a remote member.** The `apra-fleet` entry is created
   only by `runInstall` (`src/cli/install.ts:1158-1189`) pointing at
   `http://localhost:7523/mcp`, and `runInstall` is invoked only from the local
   CLI (`src/index.ts:68,229`) -- never pushed over SSH. The
   `mcpServers:{'apra-fleet':{disabled:true}}` block in `composePermissionConfig`
   (`src/providers/claude.ts:290-292`) is disabling a server that was never
   registered on that host.

2. **The one entry that would work is local-only and loopback.**
   `apra-fleet-member` is written by `registerMcpEndpoint`
   (`src/providers/claude.ts:335-356`), gated at `src/tools/register-member.ts:455`
   on `isLocal && memberProvider === 'claude' && interactiveBootstrapEnabled()`,
   where that function is a hardcoded `return false`
   (`register-member.ts:111-118`). Its URL is `127.0.0.1:<port>?member=<uuid>`.
   The fleet server binds `127.0.0.1` by default (`src/paths.ts:36`), so
   `localhost:7523` on a member resolves to that member's own loopback.

3. **The write path is closed server-side.** `assertCheckableBasis`
   (`src/services/knowledge/sqlite-provider.ts:334-356`) requires every cited
   `source_file` to resolve under `repoPath`. For a remote member that path is on
   another host, so every capture is rejected. Verified live:

   ```
   kb_capture { repo_path: '/home/developer/ApraPipes', source_files: ['CMakeLists.txt'] }
   -> "kb capture rejected: source file(s) do not exist in /home/developer/ApraPipes: CMakeLists.txt"
   ```

There is no fallback channel either: `send_message` / `report_status` are on the
same disabled server, `respond_to_message` resolves an in-process map
(`src/services/pending-responses.ts:18`), stdin is deliberately closed
(`src/services/ssh.ts:240-241`), and there is no file mailbox. Final stdout at
process exit is the only return path.

### What works today

The engine reads the KB on the member's behalf and inlines the result:
`kb_import` -> `kb_session_prime` -> `kb_query` on the server, serialized into a
"KNOWLEDGE BANK" prompt block capped at 12 entries
(`KB_MAX_KNOWLEDGE_ENTRIES`, `packages/apra-fleet-se/fleet-sprint/runner.js:1522`),
carrying the line "You do not need to call any kb_* tool to read these." Writes
come back as `kb_captures[]` / `kb_promotions[]` in the agent's JSON and the
engine executes them (`runner.js:1872,1895`).

This is a snapshot chosen before the agent starts work. It cannot be refreshed,
extended, or queried. That is the limitation this design targets.

### Two open defects that gate any fix

- **`repo_remote_url` has no caller.** The parameter appears in zero files under
  `packages/`. The fleet-sprint runner passes `repo_path` alone at all five KB
  call sites (`runner.js:1614,1622,1821,1872,1895`) -- the very unreachable path
  the parameter exists to work around. Observable cost: this repo's KB is split
  across `apra-fleet` (118 entries, 98 CONFIRMED -- basename slug) and
  `githubcom-apra-labs-apra-fleet` (23 entries, 0 CONFIRMED -- remote-URL slug).

- **Composed permissions may not land on remote members.**
  `permissionConfigPaths()` returns the relative `'.claude/settings.local.json'`
  (`claude.ts:286-288`), and `RemoteStrategy.execCommand` passes no cwd
  (`src/services/strategy.ts:32-34`) while `LocalStrategy` passes
  `cwd: this.agent.workFolder` (`:77`). So the file is written relative to the SSH
  login shell's cwd (`$HOME`), while dispatch runs
  `cd "<workFolder>" && claude -p` (`src/os/linux.ts:132-135`). Claude Code reads
  `settings.local.json` only inside a project directory;
  `~/.claude/settings.local.json` is not a supported location. If confirmed, the
  current block is not enforced remotely and any client-side allowlist would be
  equally unenforced.

## 2. Three separable problems

Conflating these is why the existing work stalled. They are independent and have
different costs.

| # | Problem | Current state |
|---|---|---|
| P1 | **Reachability** -- no endpoint a remote agent can call | No entry, loopback bind |
| P2 | **Authorization** -- what may it call once reachable | No server-side check at all |
| P3 | **Write correctness** -- how a cross-host capture stays falsifiable | Structurally rejected |

P2 must land before P1 is enabled. P3 is independent and can trail.

## 3. P2 first: authorization

`registerTools(sessionServer)` is called **unconditionally** on every session
(`src/services/http-transport.ts:305`). Auth is opt-in -- a *missing* bearer token
passes through, only an invalid one 401s (`:143-160`):

```ts
// JWT auth: verify Bearer token if present; unauthenticated (PM/tool) connections pass through
if (rawToken !== null) { postClaims = getTokenIssuer().verify(rawToken); ... }
```

`.role` never appears in `http-transport.ts`, so the JWT role is never consulted
for tool access. The only thing between a caller and all 57 tools is the loopback
bind. There is also no recursion guard anywhere: `APRA_FLEET_SPRINT_ID` is a
reservation check (`src/tools/execute-prompt.ts:554-575`), not a depth counter, and
`inFlightAgents` (`:293`) is a per-member busy set -- an agent on member M can
dispatch to member N freely. `skillOverrides:{pm:'off',fleet:'off'}` is written in
two providers and **consumed nowhere** in `src/` or `packages/`.

### Design: scope tool registration by session identity

Change `registerTools(server)` to `registerTools(server, scope)` and derive the
scope from the session. For a member session (JWT-identified, or the `?member=`
fallback), register only:

```
kb_query  kb_session_prime  kb_context  kb_list  kb_stats  kb_capture
code_graph  code_impact  code_query  code_context  code_map  code_flow  code_tests
version  report_status
```

Everything else is **not registered**, so it cannot be called regardless of client
config. Deny-by-omission, enforced server-side.

Deliberately excluded, with reasons:

- `execute_prompt`, `execute_command`, `stop_prompt` -- arbitrary execution on any
  member; the recursion hole.
- `compose_permissions` -- self-escalation. An agent that can call this rewrites
  its own allow list. This is the single most important exclusion.
- `credential_store_*`, `provision_llm_auth`, `provision_vcs_auth`,
  `revoke_vcs_auth`, `setup_ssh_key`, `setup_git_app` -- secrets.
- `register_member`, `remove_member`, `update_member`, `member_reservation`,
  `shutdown_server`, `update_llm_cli`, `cloud_control` -- fleet control.
- `send_files`, `receive_files`, `send_email` -- exfiltration.
- `dolt_push_mutex`, `child_id_allocator` -- global mutexes; a dispatched agent
  could wedge unrelated sprints.
- `list_members`, `member_detail`, `fleet_status` -- leak fleet topology (hosts,
  usernames, work folders). Excluded by default; revisit if a role needs them.
- `kb_promote`, `kb_import` -- mint CONFIRMED, the tier the whole ladder rests on.
  `kb_import`'s own code calls itself "caller-asserted trust, equivalent in power
  to kb_promote."
- `kb_export` -- auto-commits `.fleet/kb-canonical.json` to git
  (`src/tools/kb-export.ts:276-316`). A writer despite reading only CONFIRMED.
- `kb_setup` -- installs a git hook and writes credentials.

`kb_capture` is included: confidence is hard-clamped to INFERRED at the provider
choke point (`sqlite-provider.ts:889-895`), so a member cannot mint trust. Note it
will still be rejected by P3 until that lands -- included now so the scope does not
need revisiting later.

While here, tighten the `?member=` path: it currently registers a full session
with `role:'doer'` hardcoded and no proof of identity
(`http-transport.ts:158-160,201-212,262`). Under scoped registration it gets the
member scope, which is the correct blast radius.

## 4. P1: reachability via SSH reverse tunnel

### Rejected: open the bind

Setting `APRA_FLEET_HOST=0.0.0.0` is the obvious move and the wrong one. The code
warns about it itself (`http-transport.ts:374-376`): it re-exposes the
unauthenticated `?member=` fallback and `/shutdown` to anything that can route to
the port. It also requires per-site firewall/NAT work, and a Jetson on a lab
network typically cannot route back to the operator's workstation at all.

### Rejected: kb-server

`src/commands/kb-server.ts` is attractive in principle -- a dedicated KB API has no
execute tools to leak. In practice it is prototype-grade:

- Binds `0.0.0.0` unconditionally (`:225`, `listen(port)` with no host); no
  `--host` flag despite `docs/knowledge-layer-design.md:478-479` specifying one.
  No TLS.
- One shared token, no per-member identity, no revocation or expiry, non
  constant-time compare (`:130`), rate limiter applied pre-auth and keyed on
  socket IP with an unbounded bucket map.
- Client-supplied `author`/`source` on capture -- no server-side attribution.
- 5 of ~18 KB operations have a route. `HttpKbProvider.promote`, `getLinked`,
  `touch`, `relatedClaims` silently hit the **local** DB instead of the remote --
  worse than throwing.
- `HttpKbProvider` is not wired into `kb-providers.ts` at all, which hardcodes
  `SqliteProvider` (`:28,43`). `KbProviders.project` is typed `SqliteProvider`, and
  six tools call SQLite-only methods absent from `MemoryProvider`.
- The config path is dead: `kb_setup` writes `{provider,url,token_encrypted}` to
  `knowledge/config.json` and nothing reads those keys.
- No repo scoping -- the served KB is whatever `process.cwd()` resolves to, fixed
  at boot. This is the exact repo-blindness class the MCP tools already fixed.

Closing that list is more work than the alternative, and it would duplicate a
weaker copy of a transport that already exists.

### Chosen: reverse-tunnel the existing MCP transport

The fleet server already holds an SSH connection to every remote member, with a
pool and idle timer (`src/services/ssh.ts:28-101`) and a dedicated
non-pooled long-lived channel path (`execStream`, `:343`). `ssh2` -- already a
dependency (`package.json:96`) -- supports remote forwarding:
`Client.forwardIn(addr, port, cb)` plus the `'tcp connection'` event
(`@types/ssh2/index.d.ts:628,344`).

So: ask the member to listen on a loopback port and pipe connections back to the
fleet server's own loopback.

```
fleet server (Windows)                          remote member (Jetson)
======================                          ======================
ssh2 Client (pooled, already connected)
  forwardIn('127.0.0.1', 0, cb) ------------->  member listens on 127.0.0.1:<p>
  on('tcp connection', accept) <-------------   agent connects to
    pipe(stream, net.connect(127.0.0.1, 7523))    http://127.0.0.1:<p>/mcp?member=<uuid>
                                                          |
  MCP session, member-scoped tools  <--------------------- +
```

Properties that make this the right choice:

- **No new network exposure.** The fleet server stays loopback-bound. Nothing new
  listens on any routable interface on either host.
- **No NAT/firewall work.** Reuses the already-established outbound SSH session.
  Works for a device that cannot route back to the operator.
- **Auth is already established.** Only a party with SSH access to the member can
  reach the forwarded port, and it is bound to the member's loopback -- so it is
  not reachable from the member's LAN either.
- **Natural lifecycle.** The tunnel dies with the SSH session. `unforwardIn` on
  teardown; a dropped connection cannot leave a stale open port.
- **Inherently per-member.** The `?member=<uuid>` is fixed at tunnel setup, so a
  member cannot impersonate another by editing a URL.

Implementation notes:

- Add `openReverseTunnel(agent, localPort)` to `src/services/ssh.ts`, modelled on
  `execStream`'s dedicated-connection approach so the pool's idle timer cannot tear
  down a live tunnel. `forwardIn` with port `0` lets the member's sshd choose; the
  callback returns the assigned port.
- Requires `AllowTcpForwarding yes` on the member's sshd (the default). Probe once
  at registration and record the result on the agent so dispatch can degrade to the
  Phase-0 bible fallback with a clear warning rather than failing.
- Write the member's MCP entry into the **project-scoped**
  `<workFolder>/.claude/settings.local.json` -- which requires fixing the relative
  path defect in section 1 first. `deliverConfigFile` already deep-merges
  (`src/tools/compose-permissions.ts:199-216`) specifically to avoid clobbering
  `mcpServers['apra-fleet-member']`, so the two configs coexist.
- Mint a real member JWT rather than relying on the `?member=` fallback. The
  issuer exists (`issuer.issue`, called today only inside the dead
  `interactiveBootstrapEnabled()` branch).
- Tunnel setup belongs on the dispatch path, not registration -- it should exist
  only for the life of a prompt.

This also unblocks `interactiveBootstrapEnabled()`: the reason it is stubbed off is
lifecycle ("a long-running, unlabeled claude.exe with no obvious owner"), which a
dispatch-scoped tunnel does not create.

## 5. P3: cross-host capture

The invariant the existence check protects is **falsifiability**, not existence.
From the call-site comment (`sqlite-provider.ts:820-843`):

```
// freshnessSweep() builds its work set ONLY from entries with a parsed
// source_file_hashes basis, so an entry citing no files is never checked and
// can never be staled -- permanently CONFIRMED-able and structurally
// unfalsifiable. An entry citing files that do not exist is checkable and
// already wrong.
```

The second clause assumes *this host* is the falsifier. That assumption is what
breaks for a remote member.

### Rejected: caller-supplied hashes at capture

Letting the member pass `source_file_hashes` into `capture()` requires: adding a
field to `KBEntryInput` (which has none today, `types.ts:91`), relaxing
`assertCheckableBasis`, and stopping `capture()` from clobbering it -- `:902`
unconditionally recomputes, which for a remote member yields `{}`. And even then
the result is unsafe: `repo_remote_url` routes the member to the *same* database as
a local counterpart clone whose anchor **does** exist, and that host's next
`freshnessSweep` will evaluate the remote-captured rows. Given the three divergence
vectors below, the likely outcome is mass-staling the member's entries -- the
`apra-fleet-b4g.4` corruption mode in mirror image.

Relaxing the existence gate alone is worse than doing nothing:
`computeSourceFileHashes` silently drops unresolvable files (`:363-381`),
`parseBasis` returns null for an empty map (`:452-460`), and `freshnessSweep` skips
null bases (`:606-612`) -- so it would reconstruct the unfalsifiable-entry failure
mode by a second route.

### Chosen: remote-sourced verification hashes

Keep the basis immutable and let the *sweep* take its current hashes from the
member:

```
freshnessSweep(root?, currentHashes?)   // hashes supplied instead of computed locally
```

This preserves every existing invariant -- same basis, same `basisFullyMatches`,
same `freshnessRevivable` four-actor argument (`:397-428`, which assumes an
immutable basis) -- and changes only where the comparison hashes come from. It also
gives a remote-captured entry a real falsifier.

Producer: a new `os-commands` method `gitHashObject(repoPath, files[])` ->
`git -C <repoPath> hash-object -- <files>`, driven over the existing
`strategy.execCommand`. This is the *same command* `computeFileHashBatch` uses as
its primary path (`src/services/knowledge/file-hash.ts:80-109`), so the hash
flavour matches by construction.

`probeRemoteAgentHashes` (`src/services/agent-provisioner.ts:75-119`) cannot be
reused: it is sha256 (`Get-FileHash`/`sha256sum`), home-relative and whole-tree,
with a parser fixed at 64 hex chars (`:66`) that a 40-char git blob SHA-1 would not
match.

### Three prerequisites, all latent bugs today

1. **Hash type is discarded.** `sqlite-provider.ts:372-376` keeps `result.hash`
   and drops `result.type` (`'git' | 'sha256'`). A stored basis is an
   undiscriminated mix, so a git-vs-sha256 disagreement mismatches every file and
   stales the entry. Persist the type.
2. **Basis keys are not path-normalized.** `validateFilePaths`
   (`src/services/knowledge/path-validation.ts:3-13`) rejects only absolute and
   `..` paths, so a Windows member's `src\services\x.ts` becomes a basis key that
   never resolves on Linux. Canonicalize to `/`.
3. **git-blob hashes are only host-independent by repo config.** `computeFileHash*`
   does not pass `--no-filters`, so EOL/clean filters apply. This repo is safe
   (`.gitattributes:4` is `* text=auto eol=lf`), but a repo with
   `core.autocrlf=false` and no `text` attribute yields different hashes on Windows
   vs Linux for identical content. Also, two call sites omit `cwd`
   (`src/tools/kb-capture.ts:59`, `sqlite-provider.ts:1083`) and so pick up the
   fleet server's own repo config. Pin the flavour explicitly.

Also note `source_file_hashes` is insert-once -- written only by `insertEntry`
(`:275`), with no `UPDATE` anywhere in `src/`. Any re-report design must either add
a write path (and re-audit the revival predicate) or, per the above, keep the basis
frozen and supply only the comparison.

If a remote-only member has **no** local counterpart clone, the invariant is
genuinely lost: `anchorIsMissing` suppresses every server-side verdict and nothing
can contradict the row. Scope P3 to members whose repo has a local counterpart, and
reject cross-host capture otherwise rather than storing an unfalsifiable entry.

## 6. Phase 0: ship this first

Independent of everything above, and worth doing on day one.

`.fleet/kb-canonical.json` is **committed** (`git ls-files .fleet/` -> one file),
31 entries in a v2 envelope. Every clone has it, including the Jetson's. A remote
agent can `Read`/`Grep` it with no MCP, no network, no tools -- repeatedly,
mid-session, as many times as it wants.

No prompt anywhere tells any agent to do that. Meanwhile all 10 role contracts
still instruct the agent to call `kb_session_prime` in Step 0 -- dead text on a
remote dispatch, pinned by `tests/agent-contracts-kb-wiring.test.ts:49-50`.

Change: add a fallback to Step 0 -- "if `kb_session_prime` is unavailable, Read
`<repo>/.fleet/kb-canonical.json` and use its `entries[]`."

This directly answers the "blocked when they need more KB mid-call" objection. It
is strictly better than the 12-entry pre-send snapshot: the agent searches all 31
entries by the symbols and files it actually touches, at the moment it needs them.

Limits, stated honestly: read-only; CONFIRMED-only (31 of 118 entries in this
repo); no `content` field, only `summary` (export drops it, `kb-export.ts:48-57`);
as fresh as the last commit; no `code_*` tools. It is a floor, not the answer.

## 7. Sequencing

| Phase | Work | Unblocks | Risk |
|---|---|---|---|
| **0** | Bible fallback in role contracts Step 0 | Runtime KB reads, today | None -- prompt only |
| **0b** | Thread `repo_remote_url` through `runner.js` (5 sites) + resolve member origin URL once in `folderFor()` | Correct KB routing; stops slug fragmentation | Low |
| **0c** | Fix relative `settings.local.json` delivery for remote members | Prerequisite for any client-side config | Low, but verify on hardware |
| **1** | `registerTools(server, scope)` -- server-side tool scoping | Makes any endpoint safe to expose | Medium; must enumerate carefully |
| **2** | SSH reverse tunnel + member JWT + project-scoped MCP entry | Full KB/code read access at runtime | Medium; needs `AllowTcpForwarding` probe |
| **3** | Client-side allow/deny replacing `disabled:true` | Defense in depth | Low, once 1 is in |
| **4** | Remote-sourced verification hashes + the three normalization fixes | Cross-host capture | High; do last |

Phases 0/0b/0c are independent and can land immediately. Phase 1 gates Phase 2 --
do not open an endpoint before the tool set is scoped server-side.

## 8. On the whitelist proposal specifically

The proposal -- drop the blanket `mcp_fleet_*` block, whitelist `code_*` and
`kb_*`, keep `execute_command`/`execute_prompt` blocked -- is the right shape for
P2, and the rule syntax works. There is already precedent in this repo:
`src/cli/install.ts:599` uses `'mcp__apra-fleet__*'` for the orchestrator's own
session.

Confirmed Claude Code semantics:

- Format is `mcp__<server>__<tool>` (double underscores).
- **Allow** rules require the glob to follow a literal `mcp__<server>__` prefix.
  `mcp__apra-fleet-member__kb_*` is valid; an unanchored `mcp__*` in an allow rule
  is skipped with a warning.
- **Deny/ask** rules accept bare globs -- `mcp__*` and `mcp__apra-fleet__*` both
  work.
- Precedence is **deny -> ask -> allow, first match wins**, not specificity-based.
  So a broad `code_*` allow plus targeted denies behaves as intended.

Four corrections to the plan as stated:

1. **`disabled: true` must be removed, not layered.** It sits upstream of the
   permission matcher; a disabled server's tools are never listed, so no allow rule
   can revive them.
2. **It targets the wrong key.** The entry that carries a working URL is
   `apra-fleet-member`, not `apra-fleet`. Rules on `apra-fleet` govern the
   orchestrator's server -- keep that one denied.
3. **For remote members it is currently a no-op** -- there is no server entry to
   enable (section 1). P1 is a hard prerequisite.
4. **The blocked set is larger than the execute tools.** `compose_permissions` is
   the critical addition -- an agent that can call it rewrites its own allow list.
   See section 3 for the full list.

And the reason it should not be the *only* control: there is no other recursion
guard (section 3), no server-side authorization, and `base-dev.json` grants `Read`,
`Write`, `Edit`, `Bash(bash:*)`, `Bash(sh:*)`, `Bash(chmod:*)` -- so a dispatched
agent can read and rewrite its own `settings.local.json`. Additionally, allow rules
are silently dropped unless the workspace is trusted
(`src/providers/claude.ts:358-478`), so a trust-seeding failure degrades to *no
restriction* rather than to a block. That is fail-open.

Hence Phase 1 before Phase 3: server-side scoping is the boundary, the client-side
allowlist is defense in depth on top of it.

The premise behind the proposal is correct and is the strongest argument here:
pre-stuffing the prompt cannot work, because an agent that discovers mid-run that
it needs a fact has no channel to ask for it -- not `kb_*`, not `send_message`, not
stdin, not a file mailbox. Phase 0 gives that channel cheaply; Phase 2 gives it
properly.
