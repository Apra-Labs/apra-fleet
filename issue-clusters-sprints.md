# Issue Clusters & Sprint Plan

Derived from triage of all open issues + independent top-10 analysis by fleet-dev (Opus/premium) and fleet-rev (Sonnet/standard). 14 issues total: 8 shared picks, 2 premium-only (#75, #91), 2 standard-only (#179, #106), 2 honorable mentions (#152, #158).

Clustering principle: **loose coupling between clusters, high cohesion within**. Issues in the same cluster share a data model, code path, or design decision — splitting them across sprints would require touching the same code twice or produce an incoherent intermediate state.

---

## Cluster A — Session Lifecycle (Core Reliability)
**Issues: #147 · #160 · #148**

Must ship together. #147 introduces a PID registry at session launch — that registry is the prerequisite for both #148 (cancellation needs to know which PID to kill) and #160 (the rolling inactivity watchdog must hook into the same session tracking). All three touch `execute_prompt` session start/run/stop code. Doing them in separate sprints means touching the same watchdog logic twice and risking regressions between.

| Issue | Title | Dependency |
|-------|-------|------------|
| #147 | `execute_prompt`: kill previous agent instances before new session | — |
| #160 | Activity-aware timeout — extend on progress, kill only on inactivity | requires #147 PID registry |
| #148 | Background agents: no cancellation mechanism | requires #147 PID registry |

---

## Cluster B — Session Communication & Steering
**Issues: #75 · #152**

Both address the same gap: the PM can only fire and observe, never interrupt or redirect. #75 (mid-session PM↔member comms) is the foundation; #152 (inter-fleet agent-to-agent messaging) is the natural extension once that signaling primitive exists. #152 is architecturally premature until #75's model is in place.

| Issue | Title | Dependency |
|-------|-------|------------|
| #75 | Inter-session attention mechanism (PM↔member communication) | requires Cluster A |
| #152 | Inter-fleet messaging | requires #75 |

---

## Cluster C — Credential & Trust Model
**Issues: #163 · #157 · #158 · #54**

All four share the same architectural principle: *trust belongs at the member level, not per-call*. #163 and #157 both require a redesigned credential store data structure — doing one then the other means two incompatible schema migrations. #158 (TTL) adds one field to the same store. #54 (moving `dangerously_skip_permissions` to member registration) applies the same principle to the permissions model — different code path but must be designed in the same sprint so the trust model is consistent end-to-end.

| Issue | Title | Dependency |
|-------|-------|------------|
| #163 | `provision_vcs_auth` credential file isolation and provider coverage | co-equal with #157 |
| #157 | Credential scoping: restrict secret access to specific members | co-equal with #163 |
| #158 | Credential TTL | requires #157 store redesign |
| #54 | Remove `dangerously_skip_permissions` from `execute_prompt`, move to member-level | same design session as #163/#157 |

---

## Cluster D — Auth UX
**Issues: #106**

Standalone. Two-line environment-detection fix before attempting to spawn a GUI terminal on headless SSH sessions. No coupling to anything else. Can ship as a hotfix alongside Cluster A, or independently.

| Issue | Title | Dependency |
|-------|-------|------------|
| #106 | OOB password entry fails with misleading error on SSH/headless terminals | none |

---

## Cluster E — Member Configuration Flexibility
**Issues: #125 · #179**

Both expand what a member can be beyond its registration-time defaults. #125 (multiple providers per member) touches `register_member`/`update_member` in the MCP server binary. #179 (extension layer) is purely a skill-layer change — no binary changes, routing instructions in SKILL.md files only. Cohesive in purpose: both answer *"how do organizations configure fleet for their specific setup without forking?"* Doing them together lets onboarding docs and the skill-matrix extension (#179) reference the multi-provider capability (#125) coherently.

| Issue | Title | Dependency |
|-------|-------|------------|
| #125 | Multiple LLM providers per member | none |
| #179 | Local extension layer: org-private skills, template overrides, safe updates | none |

---

## Cluster F — Data & File Layer
**Issues: #98 · #91**

#98 (glob/directory support in `send_files`/`receive_files`) is a feature addition to the MCP server's file transfer tools. #91 (git worktree .git pointer corruption on Windows) is a bug in member-side git operations. Code paths don't overlap, but both are "data moving between PM and member" concerns and both affect Windows users heavily. Can be parallelized within the same sprint.

| Issue | Title | Dependency |
|-------|-------|------------|
| #98 | Glob patterns and directories in `send_files` and `receive_files` | none |
| #91 | Git worktree .git path corruption on Windows (bash/WSL) | none |

---

## Dependency Graph

```
Cluster A (Session Lifecycle: #147, #160, #148)
    └── Cluster B (Session Comms: #75 → #152)

Cluster C (Trust Model: #163, #157, #158, #54)   — independent of A/B

Cluster D (#106)   — independent, hotfix anytime

Cluster E (#125, #179)   — independent of all

Cluster F (#98, #91)   — independent of all
```

---

## Proposed Sprint Order

| Sprint | Clusters | Rationale |
|--------|----------|-----------|
| **Sprint 1** | A + D | Highest severity. A stabilizes the core dispatch loop. D is a two-line hotfix — free to include. |
| **Sprint 2** | C | Security model. No dependency on A, but platform stability from Sprint 1 is a good baseline before touching auth. |
| **Sprint 3** | B + F | B requires A stable. F is independent — runs in parallel with B. |
| **Sprint 4** | E | Member config flexibility. No dependencies. Ships when capacity allows. |
