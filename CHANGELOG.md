# Changelog

What changed in each apra-fleet release, newest first. Each entry summarises
the [GitHub release](https://github.com/Apra-Labs/apra-fleet/releases) of the
same version; the release page has the full notes, upgrade guide and PR list.

This file is updated only when a release is cut, by whoever cuts it
(see `docs/release-playbook.md`) -- not by feature PRs or sprints.
`[Unreleased]` stays empty between releases.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Dates are
the GitHub publish date (UTC). Versions before 0.2.0 used 4-part tags.

## [Unreleased]

## [0.4.5] - 2026-11-17

Patch release on top of 0.4.4. Upgrade guide and known issues:
[discussion #820](https://github.com/Apra-Labs/apra-fleet/discussions/820).

### Upgrade notes

- Bitbucket: only Atlassian API tokens with scopes are supported (app passwords fail with HTTP 410), stored as the secret `bitbucket_api_token`. Required scopes: `read:repository:bitbucket`, `write:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket`. The `bitbucket-devops` skill is retired in favour of the `bitbucket` plugin in Apra-Labs/agent-marketplace.
- Local Bitbucket members: run `provision_vcs_auth member_name=<member> provider=bitbucket workspace=<workspace> api_token={{secret.bitbucket_api_token}}` once each (0.4.4 used the email as git username). Remote members are fixed on their next sprint.
- Bitbucket SSH remotes may now point at `ssh.bitbucket.org`.
- Azure DevOps: a rotated PAT is deployed only after the old one fails; re-run `provision_vcs_auth` to deploy it at once.
- fleet-sprint: a launch resets in-scope `in_progress` beads to open and clears their assignee. Check `bd list --status=in_progress` before launching.
- Intel Macs: install 0.4.5 by hand once with `apra-fleet-installer-darwin-x64` and `install --force` (0.4.4's `update` always downloads the Apple Silicon build).
- `apra-fleet update` from 0.4.3 or older: restart every open LLM CLI session afterwards. A custom `APRA_FLEET_PORT` is still reset to 7523 by `update`; set it again and re-run the install.
- Supervisor API: every POST/PUT/DELETE needs `Content-Type: application/json` and a JSON body (else `415`). Dashboards listen on `127.0.0.1` only; use `--host` (and `--allowed-host <name>` for DNS names) for remote access. A sprint whose PR could not be opened ends as `success-with-warnings`.
- KB over HTTP (`kb_setup provider:http`): upgrade the KB server and every fleet client together. The server is the only source of truth; unreachable or 429/503 gives the retryable `E-KB-HTTP-UNREACHABLE`. Promote/demote need a server that lists them in `GET /api/kb/capabilities`.
- fleet-sprint: the KB demotion loop is on by default; turn it off per launch with `"kbDemotionLoop": "off"` (or `--kb-demotion-loop off`).
- Claude Code: the fleet status line is now the fleet-status plugin; run `/reload-plugins` or start a new session. A statusLine of your own is never touched.

### Added

- fleet-status Claude Code mod: a status row (busy/idle/offline members, expiring secrets) and a `/fleet-status` pane to view and remove members and to add, replace, delete or insert `{{secret.NAME}}` secrets. Secret values never pass through Claude Code.
- Bitbucket Cloud pull requests in fleet-sprint (open, find, update; relaunch updates the open PR), with real credential verification and no-prompt preflight.
- `kb_demote` (CONFIRMED -> INFERRED with reason and evidence, carried in the bible) and a sprint reviewer loop that re-checks CONFIRMED entries whose cited files the sprint changed and can demote ones no longer true (uneven for entries the sprint itself made untrue; redesign planned for 0.4.6).
- `apra-fleet kb profile developer` trims a session's `kb_*` tools to five.
- HTTP KB provider contract: `GET /api/kb/capabilities`, typed errors, repository/branch/commit on every request, bearer token read from a named fleet secret per request, configurable timeout. `apra-fleet kb serve` implements it.
- fleet-sprint sets aside BLOCKED beads and their dependents, stops when nothing can move, and pauses for decisions only a person can make.
- Linux ARM64 installer; installs, `apra-fleet update` and the dolt download pick the build by CPU.

### Fixed

- Fleet server memory growth over a day: short-lived MCP sessions are released and idle sessions evicted after 30 minutes.
- KB: member reads, `kb_setup` hooks in worktrees and with `core.hooksPath`, repository detection from client folders, `kb_harvest` continues past a failed capture.
- Code intelligence: retry hints, full rebuilds, corrupted/offline index reasons reported.
- fleet-sprint: stale claims reclaimed at launch, usage-limit resume fallback, lane order, reviewer diff base, sprint analysis files never committed.
- Windows: beads sync "Not enough memory resources"; git and shells started by full system path.
- Install: custom `APRA_FLEET_PORT` survives restarts and autostart; accurate install messages; clean supervisor shutdown.

### Security

- Dependency updates (`undici`, `vite`, `vitest`, `body-parser`, `fast-uri`, `ip-address`, `@hono/node-server`, `hono`); supervisor `Host` header check against DNS rebinding; tokens masked in all encoded forms in `provision_vcs_auth` output and logs.
- Known: zod advisory GHSA-mrhx-c7xc-m3w5 is not fixed yet (needs zod 4).

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.4.5)

## [0.4.4] - 2026-10-15

Changes server security, how members get their tools, and how the service
runs. Upgrade guide: [discussion #719](https://github.com/Apra-Labs/apra-fleet/discussions/719).

### Upgrade notes

- fleet-sprint users: stop sprints and the supervisor first (`E-FLEET-SE-RUNNING`; `--force` does not override). Restart the supervisor afterwards with `node ~/.apra-fleet/workflows/fleet-sprint/bin/serve.mjs`. After 0.4.3's `apra-fleet update`, check `apra-fleet --version`.
- Upgrade with the downloaded installer; if the 0.4.3 server is running it prints the exact `install --force` command. Members, credentials and KB are kept.
- Every `/mcp` request needs the install's access secret. Restart every LLM CLI session open during the upgrade (stale Claude Code sessions show `Dynamic Client Registration rejected (HTTP 404)`). Hand-written clients must send `X-Apra-Fleet-Member-Secret`.
- Run `update_member {member_id, fleet_install: "auto"}` once per remote member.
- Windows, if 0.4.3 was installed elevated: run `schtasks /delete /tn ApraFleet /f` from an elevated prompt, then install from a normal prompt.
- Breaking for KB callers: `repo_path`, `repo`, `repo_remote_url` removed from `kb_*` tools; a repo needs an `origin` remote; reads default to CONFIRMED only. Upgrade everyone exporting to the same repo together (bible format v3).
- Credentials no longer go on a command line: relay members and SSH members without SFTP that hold a stored credential must enable SFTP or clear it. Members given a Claude OAuth token as `api_key` under 0.4.3: run `provision_llm_auth {member_id}` once without `api_key`.
- fleet-sprint roleMaps: the beads role `orchestrator` is now `backlog`. Supervisor launches: drop the key (any other member is rejected with HTTP 400). CLI launches: rename it. A sprint branch equal to its base is rejected.
- Raise dollar budgets: Claude prompt-cache reads and writes are now costed, so reported cost can be up to about 15-20x what 0.4.3 showed.

### Added

- Knowledge Bank redesign: every member session works against its own repo's KB, remote members run a member install of apra-fleet, sprint roles get `kb_*`/`code_*` tools, bible format v3 with file hashes, `kb_bible_commit`.
- Per-install access secret on the loopback `/mcp` endpoint.
- User-level service on every OS; on Windows a hidden scheduled task revives a crashed server within 5 minutes; `apra-fleet stop` persists across logon and reboot.
- Supervisor-owned backlog member, cached beads view, HTTP 503 on launches it cannot verify; preflight catches missing `bd`, unset-up beads clone and branch == base.
- AGY (Antigravity) provider parity, including structured output on Windows.
- Nightly install/upgrade proof on Windows, Linux and macOS.

### Changed

- Sprints no longer write `CHANGELOG.md`; the cost block is in the PR body.
- Regression runner executes every part of the target's own playbook.
- Busy port is a loud startup error naming the holder; scripts auto-start the shared server.

### Fixed

- Expired Claude OAuth token classified as an auth failure and healed once.
- Windows: hidden child console windows, no installer hang for non-admin SSH users.
- SSH channels closed on all paths; sshd session-limit refusals surfaced.
- npm package ships the fleet-sprint supervisor sources.
- Role prompts forbid shell loops that Claude Code CLI 2.1.296+ refuses headless.

### Security

- Member credential values never on a command line (owner-only files over SFTP); Claude OAuth tokens stored as `CLAUDE_CODE_OAUTH_TOKEN`; `remove_member` never deletes a user-supplied SSH key; critical/high dependency and code-scanning alerts resolved.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.4.4)

## [0.4.3] - 2026-09-28

Required upgrades and deprecations:
[discussion #496](https://github.com/Apra-Labs/apra-fleet/discussions/496).

### Upgrade notes

- Beads `bd` 1.3.0 (via npm) is required on every member that runs sprints.
- Node.js 22.16+ and npm are required for fleet-se (fleet-sprint, supervisor, `bd`); apra-fleet core does not need them (`--workflows none`). Updating from 0.4.2 without Node.js leaves 0.4.2 running: run `apra-fleet install --force --workflows none` or install Node.js first.
- `{{secure.NAME}}` is deprecated; use `{{secret.NAME}}`. The `apra-fleet auth` CLI takes `secret.<name>` / `--secret`.
- Breaking: reason codes renamed to `secret_variable_not_found` / `_denied` / `_expired`, with no alias.
- `better-sqlite3` is no longer a dependency (KB uses `node:sqlite`).
- Beads-identity check is fatal: each member's workFolder must be a git clone with `origin` and a `sync.remote`. `fleet-se serve` fails at startup without a single `.beads` (use `--beads-dir`).
- Breaking for GitHub App users: add Workflows: Read and write and Actions: Read and write to the App and accept them on the installation, or PRs are skipped. See `docs/github-app-setup.md`.

### Added

- `execute_prompt` `fork` parameter to branch a new session from an existing one (Claude).
- `register_member` detects and self-heals a member's VCS provider; Azure DevOps legacy `*.visualstudio.com` hosts; PR descriptions capped at 3500 chars.
- AGY members run fleet-sprint roles end to end with per-project permissions.
- `memory-contract/v1`: spec, JSON schemas, bindings and conformance suite for the `kb_*`/`code_*` tools.
- Supervisor shows each sprint's merge target; beads maintenance playbook for `bd prune` / `bd flatten`.

### Fixed

- Windows dispatches complete on process exit instead of hanging on a leftover child; bounded test runners; stall detector catches frozen log tails; leaked busy locks released; no `ENAMETOOLONG` writing the workspace-trust file.
- VCS cleanup revokes the exact credential written; stale Dolt push no longer misread as an auth failure; `provision_vcs_auth` failures carry their cause.
- Fewer, cheaper beads syncs per sprint; child-bead creation refuses id collisions.
- Installer fails loudly before changing anything when Node.js/npm are missing; Windows `install --force` reuses an elevated task.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.4.3)

## [0.4.2] - 2026-09-07

### Added

- Windows members' real shell (Git Bash, PowerShell 7, PowerShell 5.1) is probed at registration and used by every Windows command builder.
- `Agent.unreservable` lets an orchestrator member be shared across concurrent sprints.
- Supervisor dashboard live refresh (`GET /state` + SSE `GET /events`); Backlog sort by creation time.
- Workflow engine pause/resume.
- Azure DevOps VCS auth groundwork (not yet a finished feature).

### Fixed

- fleet-sprint: stale bead snapshot after mid-cycle planning, false "Nothing to do" on standalone leaf beads, dispatches rejected when a KB entry named a secret placeholder.

### Removed

- Gemini provider support.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.4.2)

## [0.4.1] - 2026-08-19

### Added

- Deploy and test dispatches read required permissions from the project's deploy runbook and grant them before dispatch; pre-flight readiness check.
- Code intelligence tools (code graph, impact analysis, structural query) and the Knowledge Bible.
- Fleet supervisor runs from a normal install, no source checkout needed; shutdown/restart/auto-start docs per OS.
- GitHub credential setup also logs in the `gh` CLI.
- Email sending from the credential store or inline configuration.

### Changed

- Beads sync conflicts are resolved by a deterministic procedure instead of an LLM recovery ladder.
- Dispatch timeouts raised to stop false stalls.

### Fixed

- Permission grants written to the wrong location on remote members.
- Windows cross-shell command construction and credential probe under a non-default shell.
- Dependency security vulnerability.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.4.1)

## [0.4.0] - 2026-08-05

### Upgrade notes

- Breaking: MCP transport defaults to HTTP. `apra-fleet install`/`update` switch automatically; opt back in with `apra-fleet install --transport stdio`.
- Known issue: `apra-fleet install` with `--llm claude` can fail if `claude` is not on PATH; install Claude Code first.

### Added

- `apra-fleet workflow <name>`: run any agentic workflow from `~/.apra-fleet/workflows/<name>/` (see `docs/authoring-workflows.md`).
- Multi-sprint supervisor (preview) with live dashboard and Stop/Restart.
- Member `category`/`tags`, tag-based permission profiles, `llm_provider: none`.
- Separate Integ Test (per cycle) and Regression Test (per sprint) phases.

### Fixed

- fleet-sprint: false "empty response" failures, missed stalls, sync failures misreported as dispatch failures, self-recovering beads clones, concurrent sprints colliding over members.
- npm install ships the fleet-sprint engine and resolves `@apralabs/apra-fleet-client`.
- Windows `build:binary` and watchdog event-loop starvation.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.4.0)

## [0.3.6] - 2026-07-24

### Upgrade notes

- If you ran `apra-fleet secret --set <name> --persist` while an out-of-band prompt for the same secret was open, it may be stored empty. Re-run the command after upgrading.

### Fixed

- `apra-fleet secret --set <name> --persist` silently stored an empty value when out-of-band delivery and `--persist` both fired.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.3.6)

## [0.3.5] - 2026-07-20

### Upgrade notes

- Remote members' role agent files are provisioned on register, update and the first dispatch after upgrade; an offline member gets them on its next dispatch. Codex and Copilot members are skipped.

### Added

- Role agent files on remote members are verified by hash and re-provisioned when missing or stale (Claude, Gemini, Antigravity, OpenCode).
- Live member activity viewer.
- Member category and tags.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.3.5)

## [0.3.4] - 2026-07-01

### Fixed

- Claude model tiers use the `haiku`/`sonnet`/`opus` aliases instead of pinned dated model IDs, so new model generations are picked up automatically.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.3.4)

## [0.3.3] - 2026-06-30

### Upgrade notes

- Breaking for hand-edited MCP configs: the binary with no arguments now runs the installer. Change `args: []` to `args: ["run"]` (`--stdio` still works). Configs written by `install`/`update` are updated automatically.

### Added

- Double-clicking the downloaded installer installs apra-fleet.
- `apra-fleet run` / `apra-fleet start` start the MCP server.

### Changed

- Installer-written MCP configs pass `run` for every provider; `claude mcp add` passes all args.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.3.3)

## [0.3.2] - 2026-06-30

### Fixed

- Install pins the beads installer to 1.0.4 (1.0.5 was withdrawn upstream).

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.3.2)

## [0.3.1] - 2026-06-27

### Changed

- apra-pm: parallel checkpoint writes, doer token ceiling, per-phase execution summary written first by the harvester, doer closes a task before claiming the next.

### Fixed

- Claude+PM installs grant `Bash(*)` so sprint log/feedback writes are not dropped; missing `buildExecutionSummary` export.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.3.1)

## [0.3.0] - 2026-06-26

### Added

- OpenCode provider (`apra-fleet install --llm opencode`) for any OpenAI-compatible endpoint; models validated at `register_member`/`update_member`.
- `/auto-sprint` native Claude Code workflow (plan -> develop -> test -> harvest), installed by default.
- All eight PM agent roles installed to the provider's agents directory (was four).
- Per-member `model_tiers` map on `register_member` / `update_member`.

### Changed

- PM skill vendored from the apra-pm submodule; `/pm` commands and state files unchanged.

### Fixed

- Gemini unattended-field schema, OpenCode config and `opencode run` prompt, invalid `tracker_*` allow-list entry, `$HOME` expansion in `long_running` task directories.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.3.0)

## [0.2.2] - 2026-06-10

### Added

- npm install: `npm install -g @apralabs/apra-fleet` then `apra-fleet install`.
- `apra-fleet --version` shows the delivery mode; under npm, `apra-fleet update` redirects to `npm update -g`.
- User-level model tier mapping override.

### Fixed

- Out-of-band credential entry: browser fallback, broader terminal detection, gnome-terminal invocation.
- agy CLI installed from the official standalone installers; pre-commit hook self-update.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.2.2)

## [0.2.1] - 2026-05-28

### Added

- Antigravity (agy) provider (`apra-fleet install --llm agy`) with per-workspace tier mapping and `AGY.md`.
- Docs overhaul: shorter README, new install, troubleshooting, writing-skills, provider-guide and beads docs.

### Fixed

- `apra-fleet update` self-update; `install` no longer overwrites a custom `defaultModel`; `sessionId` shell-injection defense in the Windows agy wrapper; `hooks.json` written with mode 0600.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.2.1)

## [0.2.0] - 2026-05-17

### Upgrade notes

- Versions move to 3-part semver (`0.2.0`) from 4-part `0.1.9.x`.
- `apra-fleet auth <name>` no longer collects out-of-band credentials; use `apra-fleet secret --set <name>` (`--confirm <name>` for egress confirmation).

### Added

- End-to-end test harness across Claude/Gemini and Windows/Linux/macOS.
- Stall detector based on session-log activity.

### Fixed

- A local Claude member could resume the orchestrator's session; session ids are now minted up front (Claude and Gemini).
- `credential_store_set` on Windows; dependency vulnerabilities.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.2.0)

## [0.1.9.0] - 2026-05-06

### Added

- `apra-fleet uninstall` (`--dry-run`, `--force`, `--yes`, `--llm`, `--skill`), editing settings per key.
- Beads (`bd`) task tracking for PM, installed alongside fleet.

### Fixed

- Unknown CLI arguments rejected with a help hint; apra-fleet excluded from Gemini child-process MCP.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.1.9.0)

## [0.1.8.2] - 2026-05-04

### Fixed

- Update check supports N-part version tags.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.1.8.2)

## [0.1.8.1] - 2026-05-03

### Added

- `apra-fleet update` self-update, replaying install options.

### Fixed

- CLI help, version parse, `fleet_status` log path; Windows drive-letter paths in SFTP; Gemini MCP exclusion and BOM-free config on Windows; `execute_prompt` busy state cleared on all exit paths.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.1.8.1)

## [0.1.8.0] - 2026-04-30

### Added

- Structured JSONL logging (pino) to `~/.apra-fleet/data/logs/fleet-<pid>.log`; MCP cancellation reaches `execute_prompt`/`execute_command`.
- Session lifecycle management and credential trust model.
- Release update notifications; apra-fleet hidden from members' own MCP server list.

### Changed

- Gemini tiers move to the Gemini 3.x generation.

### Fixed

- Claude Code 2.1.113+ JSONL output parsed by `execute_prompt`; Windows stdout capture for native `claude.exe`.
- `stop_prompt`, `send_files` case-collision detection, stale task cleanup, SSH usernames with spaces, clearer SSH errors, credential TTL cleanup, full `remove_member` decommission.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.1.8.0)

## [0.1.7.0] - 2026-04-22

### Added

- Credential store (`credential_store_set` / `_list` / `_delete`) with out-of-band entry, encrypted at rest, referenced by name as a token (now `{{secret.NAME}}`) in commands and auth tools and redacted from output. `execute_prompt` rejects prompts containing such tokens.
- Out-of-band fallback for `provision_vcs_auth` and `provision_auth`; masked input.

### Fixed

- Out-of-band retry hang, wrong prompt label, ESM `__dirname`, clearing `cloud_activity_command`, headless hint.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.1.7.0)

## [0.1.6] - 2026-04-18

### Added

- First-run onboarding banner and contextual nudges.
- `install --help`, `--skill fleet|pm|all|none`, running-server guard and `--force`.

### Changed

- README rewritten around the doer-reviewer loop; user guide merged into the README; FAQ added.
- Bare `apra-fleet install` installs both skills.

### Fixed

- Unknown `llmProvider` throws; Codex `defaultModel` quoting; Claude session resume; statusline cleared when the last member is removed; unknown install flags rejected.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.1.6)

## [0.1.5] - 2026-04-15

### Added

- Open-source community health files and templates.

### Fixed

- Member uniqueness check uses host + port + folder.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.1.5)

## [0.1.4] - 2026-04-08

### Changed

- Breaking: `send_files` `destination_path` -> `dest_subdir` (paths outside `work_folder` rejected); `receive_files` `local_destination` -> `local_dest_dir`.

### Fixed

- Single `.fleet-task.md` task file and cleanup; skill doc inconsistencies.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.1.4)

## [0.1.3] - 2026-04-07

### Added

- Multi-provider members: Gemini, Codex and Copilot alongside Claude.
- `member_name` accepted wherever `member_id` is; `receive_files`; `cheap`/`standard`/`premium` model tiers; `server_version` in JSON output.
- Fleet and PM skills split; prompts delivered via a task file; out-of-band API key entry.

### Changed

- Renamed `update_agent_cli` -> `update_llm_cli`; removed `reset_session`; `cloud_ssh_key_path` merged into `key_path`.

### Fixed

- Windows VCS auth credential helper, Gemini session resume, macOS env persistence via `.zshenv`, shared SSH keys kept on `remove_member`, null-byte path rejection, `$HOME` expansion, env var name validation.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.1.3)

## [0.1.2] - 2026-03-24

### Added

- Cloud compute members on AWS EC2.
- Out-of-band password collection via a Unix socket.

### Fixed

- Local members can use git; planning commits no longer land on main; permission profiles installed to `profiles/`.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.1.2)

## [0.1.1] - 2026-03-16

No release notes were published.
[Compare v0.1.0...v0.1.1](https://github.com/Apra-Labs/apra-fleet/compare/v0.1.0...v0.1.1)

## [0.1.0] - 2026-03-14

### Added

- PM skill rewrite: `/pm init` project structure, reviewer gets requirements and design, PM owns git transport and PR lifecycle.
- `execute_prompt` returns token usage; commit/PR attribution off by default on members.

### Fixed

- SSH key auth verification (no pooled-connection reuse); `administrators_authorized_keys` for Windows admin users.

[Release notes](https://github.com/Apra-Labs/apra-fleet/releases/tag/v0.1.0)
