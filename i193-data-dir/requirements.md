# Requirements — #193 Per-instance data directory isolation

## Base Branch
`main`

## Goal
Allow multiple fleet instances on the same device to run with fully isolated data directories, eliminating race conditions on shared files (registry.json, statusline.txt, known_hosts, salt) and registry cross-contamination between projects.

## Scope
- `apra-fleet install --data-dir <path>` flag: writes `APRA_FLEET_DATA_DIR=<path>` into the MCP server env config so it is passed automatically on every server start
- `apra-fleet install --instance <name>` shorthand: equivalent to `--data-dir ~/.apra-fleet/instances/<name>`, also registers the MCP server as `apra-fleet-<name>`
- `apra-fleet workspace` subcommand: CLI to list, switch, and inspect named instances/workspaces
- Documentation: multi-instance setup guide in fleet skill SKILL.md and README

## Out of Scope
- Changes to `src/paths.ts` beyond what is needed (env var already fully respected)
- Changes to `scripts/fleet-statusline.sh` (already uses APRA_FLEET_DATA_DIR)
- Cross-instance credential sharing

## Constraints
- Default behaviour (no `--data-dir`) must be unchanged — single-instance users are unaffected
- Salt isolation: each instance gets its own salt file; credentials stored in one instance are not readable by another — document explicitly
- Node 18+ compatible

## Acceptance Criteria
- [ ] `apra-fleet install --data-dir <path>` writes the env var to MCP config and isolates all data under that path
- [ ] `apra-fleet install --instance <name>` registers as `apra-fleet-<name>` with data under `~/.apra-fleet/instances/<name>`
- [ ] `apra-fleet workspace` subcommand lists and switches instances
- [ ] Default install (no flags) behaviour unchanged
- [ ] Salt isolation documented in README / skill
- [ ] Unit tests cover --data-dir, --instance, and workspace commands
- [ ] All existing tests continue to pass
