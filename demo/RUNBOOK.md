# Upgrade Demo -- Recording Runbook

One-take head-to-head: **Env A** (released apra-fleet v0.3.4, no KB/code
intelligence layer) vs **Env B** (this branch build) running the same two
sprints against the same NoteAPI toy repo, sequentially, on one machine.

The human runs the actual sprints in Claude sessions on camera. The scripts
in `demo/` only stage the two environments and measure the results
afterward -- they never touch the sprint content itself.

## Before you press record: one decision you must make

`apra-fleet install` (both the v0.3.4 installer and this branch's
`node dist/index.js install`) is a **machine-global** operation, not a
per-sandbox one -- verified against `src/cli/install.ts` and
`src/cli/config.ts` in this repo:

- PM/fleet skills are written to `~/.claude/skills/pm` (a fixed home-
  directory path, not project-scoped).
- The MCP server is registered with `claude mcp add --scope user apra-fleet`
  -- **user** scope, i.e. one registration for the whole machine.
- `~/.claude/CLAUDE.md` and `~/.claude/workflows/auto-sprint.js` are also
  home-directory paths.
- Only the KB/code-intelligence **data** (`kb.sqlite`, code-intelligence
  config under `FLEET_DIR`) honors `APRA_FLEET_DATA_DIR` -- that part is
  genuinely per-env isolated by `setup-env.ps1`'s env snippet. Everything
  else above is not.

**Consequence:** installing Env A and then Env B (or vice versa) on this
machine will each overwrite the other's global skills/MCP registration/
CLAUDE.md. That's expected in this runbook -- `setup-env.ps1` re-installs
immediately before each env's segment. But if this machine has your own
real, non-demo apra-fleet setup on it, **decide now** whether to:

- back up `~/.claude/skills/pm`, `~/.claude/workflows/auto-sprint.js`, and
  the apra-fleet block of `~/.claude/CLAUDE.md` before recording, and
  restore/reinstall your own setup afterward; or
- accept the overwrite and treat this recording as also being your next
  "real" `apra-fleet update`.

There is no way for this demo kit to isolate that for you -- it is a
verified property of how the installer works today, not a bug in these
scripts.

## Prerequisites

- `gh` CLI authenticated (`gh auth status`) -- used to download the v0.3.4
  release asset.
- Node.js 22+ on PATH (`node --version`) -- both the current build and the
  metrics scripts require it; `node:sqlite` (used by `collect-metrics.mjs`)
  needs Node 22+.
- `claude` CLI on PATH, logged in.
- `git` on PATH.
- This repo built: see Env B step (a) below -- do this before recording
  starts, or on camera if you want the build itself in the take.
- The toy target repo present and clean at
  `C:\ws_yash\Repos\apra-fleet-main\Workshop\fleet-e2e-toy` (already a git
  worktree -- `setup-env.ps1` copies from it, it never modifies it).

All commands below are run from this repo's root
(`C:\ws_yash\Repos\apra-fleet-main\apra-fleet`) in PowerShell unless noted.

---

## Env A -- released v0.3.4 (no KB / code intelligence)

### (a) Download the installer -- ON CAMERA

```powershell
gh release download v0.3.4 --repo Apra-Labs/apra-fleet --pattern apra-fleet-installer-win-x64.exe --dir demo\downloads
```

This is the exact asset a user downloads from the GitHub Releases page --
no KB/code-intelligence tools exist in this build (that layer landed after
v0.3.4).

### (b) Stage the sandbox + install

```powershell
.\demo\setup-env.ps1 -Env A
```

This copies a fresh, `.git`-free copy of the toy repo to
`C:\ws_yash\demo-upgrade\sandbox-a`, gives it its own git history, runs
`npm ci`, writes `C:\ws_yash\demo-upgrade\env-a.ps1` (the
`APRA_FLEET_DATA_DIR` snippet), and runs the v0.3.4 installer from inside
the sandbox (installation is the default action as of v0.3.3 -- see
`CHANGELOG.md`).

Pass `-Force` if you need to re-stage over a previous run; the script
refuses to silently clobber an existing sandbox.

### (c) Run the sprints in Claude Code

In a fresh terminal:

```powershell
. C:\ws_yash\demo-upgrade\env-a.ps1
cd C:\ws_yash\demo-upgrade\sandbox-a
claude
```

In the Claude session:

```
/pm init fleet-e2e-toy-env-a
```

**Sprint 1** (exact prompt, verbatim):

```
/pm plan Implement note archiving per feature_list.json: add an archived boolean to notes, POST /api/notes/:id/archive and /api/notes/:id/unarchive endpoints, GET /api/notes excludes archived by default, ?include_archived=true includes them. Then /pm start.
```

When sprint 1 completes:

```powershell
node "C:\ws_yash\Repos\apra-fleet-main\apra-fleet\demo\collect-metrics.mjs" A sprint1
```

**Sprint 2** (exact prompt, verbatim):

```
/pm plan Implement pagination per feature_list.json: GET /api/notes?page=1&limit=10 returns { data, total, page, limit }; must compose correctly with the archived-notes default filter. Then /pm start.
```

T2 deliberately touches the same listing code T1 changed -- Env A has no
KB, so this sprint gets no reuse benefit from sprint 1's work. That absence
is the point of comparison.

When sprint 2 completes:

```powershell
node "C:\ws_yash\Repos\apra-fleet-main\apra-fleet\demo\collect-metrics.mjs" A sprint2
```

---

## Env B -- this branch build

### (a) Build -- ON CAMERA (if you want the build itself in the take)

```powershell
npm ci
npm run build
```

### (b) Stage the sandbox + install

```powershell
.\demo\setup-env.ps1 -Env B
```

Same staging as Env A, but the install step runs
`node dist\index.js install` **from the sandbox directory** so KB/
gitnexus/code-intelligence setup binds to the sandbox repo, not to this
apra-fleet checkout. `-Force` works the same way as Env A.

### (c) Run the same two sprints

```powershell
. C:\ws_yash\demo-upgrade\env-b.ps1
cd C:\ws_yash\demo-upgrade\sandbox-b
claude
```

```
/pm init fleet-e2e-toy-env-b
```

**Sprint 1** (identical prompt to Env A, verbatim):

```
/pm plan Implement note archiving per feature_list.json: add an archived boolean to notes, POST /api/notes/:id/archive and /api/notes/:id/unarchive endpoints, GET /api/notes excludes archived by default, ?include_archived=true includes them. Then /pm start.
```

```powershell
node "C:\ws_yash\Repos\apra-fleet-main\apra-fleet\demo\collect-metrics.mjs" B sprint1
```

**Sprint 2** (identical prompt to Env A, verbatim):

```
/pm plan Implement pagination per feature_list.json: GET /api/notes?page=1&limit=10 returns { data, total, page, limit }; must compose correctly with the archived-notes default filter. Then /pm start.
```

```powershell
node "C:\ws_yash\Repos\apra-fleet-main\apra-fleet\demo\collect-metrics.mjs" B sprint2
```

---

## Final report

```powershell
node "C:\ws_yash\Repos\apra-fleet-main\apra-fleet\demo\gain-report.mjs"
```

Writes `demo\gain-report.html` from `demo\metrics-A.json` +
`demo\metrics-B.json`. Open it in a browser for the closing shot.

---

## Camera-moment callouts (Env B only -- zoom on these)

These are all verified against this repo's source, not aspirational:

- **gitnexus index during init** -- `/pm init` runs `npx gitnexus analyze`
  as its final setup step (`skills/pm/SKILL.md` Lifecycle section). Watch
  for the analyze pass completing before the first dispatch -- Env A has no
  equivalent step at all.
- **kb_session_prime hits opening sprint 2** -- the planner calls
  `kb_session_prime` before writing `PLAN.md` (`skills/pm/tpl-planner.md`).
  On sprint 2's `/pm plan`, this should surface CONFIRMED coverage on the
  listing code sprint 1 just touched -- the reuse moment.
  `usage.jsonl`-derived call counts in `gain-report.html` back this up.
- **planner citing coverage** -- `PLAN.md`'s model-assignment rationale
  must cite the `kb_stats` coverage number for the plan's key symbols
  (`skills/pm/tpl-planner.md`: coverage >= 0.8 -> lean cheap/standard,
  < 0.3 -> lean premium). Read this line straight from `PLAN.md` on camera.
- **bible auto-commit in git log** -- `kb_export` auto-commits
  `.fleet/kb-canonical.json` under the dedicated `pm-kb <kb@pm.local>`
  identity whenever the content changed (`src/tools/kb-export.ts`, F6a) --
  no manual `git commit` step. `git log --oneline -- .fleet/kb-canonical.json`
  in the sandbox will show it.
- **kb_stats** -- run it (or look at the KB entries/bible-drift numbers in
  `gain-report.html`'s Env-B-only capabilities section) to show the KB
  actually grew across the two sprints.

## Honesty note (say this out loud, don't just imply it)

**Sprint 1 on Env B may cost MORE tokens than Env A**, not less. Sprint 1 is
a cold start either way -- Env B additionally pays for `gitnexus analyze`,
`kb_session_prime`, and `kb_capture`/`kb_export` calls that Env A simply
does not have. That capture overhead is real and should show up in
`gain-report.html`'s sprint 1 table as a *worse* delta for Env B.

**The gain is sprint 2**, where Env B reuses what sprint 1 captured about
the listing code -- and it compounds on every sprint after that. Show both
numbers on camera; a demo that only shows the favorable sprint is not
credible.

---

## Script reference

| File | Purpose |
|---|---|
| `demo/setup-env.ps1` | Stages one env's sandbox + data dir + install. `-Force` to re-stage, `-SkipInstall` for dry-run staging only (see script header). |
| `demo/collect-metrics.mjs` | `node demo/collect-metrics.mjs <A\|B> <sprint1\|sprint2>` -- appends one snapshot to `demo/metrics-<env>.json`. |
| `demo/gain-report.mjs` | `node demo/gain-report.mjs` -- reads both metrics files, writes `demo/gain-report.html`. |
| `demo/selftest.mjs` | `node demo/selftest.mjs` -- exercises the collector + report against synthetic fixtures (`demo/fixtures/`), never touches real sandboxes or `~/.apra-fleet`. Run this any time you touch the scripts. |
