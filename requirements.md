# Requirements — yashr-agc — gbrain Integration for apra-fleet

## Base Branch
`main` — branch to fork from and merge back to

## Goal
Integrate gbrain into the fleet layer as an optional knowledge and durability backend. Fleet tools expose gbrain capabilities; PM and any orchestrator inherits access through existing fleet tools. No duplication.

## Scope

### 1. gbrain as fleet-level MCP peer
- Fleet server discovers and connects to gbrain MCP server when configured
- New fleet tools surface gbrain capabilities: brain query, brain write, code analysis
- Members opt-in via config (e.g. `gbrain: true` on register/update)
- PM gets gbrain access through fleet — no separate gbrain MCP config needed

### 2. Minions for durable background work
- Fleet wraps gbrain's Minions job queue as an alternative dispatch mode
- Postgres-backed durability: crash recovery, stall detection, cascade cancel
- Routing rule: deterministic work → Minions, judgment work → execute_prompt (existing)
- Opt-in per member via fleet config
- Job status queryable through existing fleet tools (e.g. `monitor_task` extension or new tool)

### 3. Code analysis tools for reviewers
- Fleet exposes gbrain's code analysis (`code-callers`, `code-callees`, `code-def`, `code-refs`) as fleet tools
- Reviewer workflow can query symbol-level impact before approving changes
- Target repos: BluNVR, ECS, larger codebases with recurring multi-session work
- Opt-in per member — not default for small repos like apra-fleet itself

### 4. Reviewer template — brain-aware reviews
- Update `tpl-reviewer.md` to instruct reviewers to query brain before approving
- Reviewer checks: "what do we know about this symbol/module?" via brain query
- Reviewer uses code-callers/code-refs to assess blast radius of changes
- Brain-aware review is opt-in — template conditionally includes brain instructions when member has gbrain enabled

### 5. Course correction capture — learn from user interventions
- When user interrupts and corrects a plan, fixes an approach, or overrides a decision mid-sprint, that feedback is automatically written to brain
- Brain stores: what was attempted, what the user corrected, why (if stated)
- Next sprint, brain recall surfaces past corrections: "user previously rejected approach X on this repo because Y"
- Applies to: plan corrections, scope changes, architectural overrides, "no don't do that" moments
- Capture happens at the fleet layer (not PM) — any orchestrator benefits

## Out of Scope
- Replacing beads for task tracking — beads stays
- Per-member brains on every member by default — opt-in only
- gbrain's full 34-skill ecosystem — cherry-pick what fleet needs
- Auto-enrichment of people/companies — not relevant for code repos
- Duplicate gbrain access at PM layer — PM uses fleet, fleet uses gbrain

## Constraints
- gbrain runs as a separate process — fleet does not embed it
- Must work on Windows (fleet host) and Linux (remote members)
- PGLite for basic usage, Postgres optional for Minions durability
- Token overhead < 1% of existing agent session costs
- Purely additive — existing fleet workflows unchanged

## Acceptance Criteria
- [ ] Fleet can connect to gbrain MCP server and expose brain query/write tools
- [ ] Knowledge persists across sessions without manual intervention
- [ ] At least one member can dispatch deterministic work via Minions with crash recovery
- [ ] Reviewer can query code-callers/code-refs through fleet tools on a target repo
- [ ] Reviewer template conditionally includes brain query instructions when gbrain is enabled
- [ ] User course corrections mid-sprint are captured to brain automatically
- [ ] On next sprint, brain recalls relevant past corrections when similar context arises
- [ ] Existing fleet workflows (execute_prompt, beads, PM commands) work unchanged
- [ ] Documentation covers install, config, and opt-in per member
- [ ] Token overhead validated < 1% on a real sprint task
