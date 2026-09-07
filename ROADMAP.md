# Roadmap

This roadmap is grounded in the repo's actual git history and issue tracker
(beads), not aspiration. "Shipped" means it is on `main`. The forward
sections are a projection of where the current trajectory leads; priorities
shift based on what the fleet itself surfaces while building this codebase.
For what is actively being worked on right now, read the beads backlog
(`bd ready`) rather than this file.

Have an idea? [Open a feature request](https://github.com/Apra-Labs/apra-fleet/issues/new/choose).

---

## What's shipped

### The fleet-sprint engine and the workflow platform

- **`fleet-sprint`: an autonomous multi-agent sprint engine** -- plan ->
  develop -> review -> harvest cycles run by planner/doer/reviewer role
  agents against a real git repo, with beads (`bd`) as the task DAG and
  Dolt as the sync backend. Renamed from `auto-sprint` to end the
  confusion with Claude Code's unrelated `/auto-sprint` script; source
  lives in `packages/apra-fleet-se/fleet-sprint/`, and this repository is
  itself built by it (see the dashboard recording in README.md).
- **`apra-fleet workflow <name>`: a general-purpose workflow runner** --
  the `packages/apra-fleet-workflow` engine gives workflows typed errors,
  budget enforcement, resumable/replayable runs, and cooperative `/stop`
  cancellation. fleet-sprint is the first workflow shipped on it.
- **`apra-fleet-se`: an always-on multi-sprint supervisor (preview)** --
  runs several sprints concurrently against a shared fleet with a
  member + issue-scope reservation ledger, a PID-liveness watchdog with
  restart re-adoption, orchestrator-bracketed git+Dolt sync with a
  scripted-first conflict ladder, and a sprint-stack dashboard (running
  sprints, history, backlog tree) on one reverse-proxied port. Still gated
  "preview" until the full end-to-end supervisor smoke cycle passes
  cleanly.
- **Sprint reliability hardening** --
  credential-auth self-heal via `provision_vcs_auth`, orphaned-CLI
  recovery, PID-liveness "lease of life" so a flaky channel no longer
  produces false empty-response failures, a stall detector that watches
  all transcript activity (not just chat) and kills confirmed stalls,
  and dispatch-vs-sync failure separation so a Dolt/git push hiccup no
  longer burns a full LLM re-dispatch.
- **MCP transport defaults to streamable HTTP** -- one long-lived
  `apra-fleet run` server on `localhost:7523/mcp` shared by every
  provider, replacing per-session stdio subprocesses; `--stdio` remains
  as an alias.
- **apra-pm "comes home"** -- the `vendor/apra-pm` submodule is gone;
  apra-pm is a package-local dependency at `packages/apra-fleet-se/apra-pm`,
  which removed a whole class of silent submodule drift in CI/e2e/packaging.
- **Deterministic e2e harness** -- fleet setup/teardown is a script, not
  an LLM improvisation; checkpoint consolidation is deterministic; and the
  turn-budget, git-auth, and log-collection flakes are fixed.

### Providers and members

- **OpenCode provider** -- full adapter (NDJSON parseResponse, session
  management, permissions/auth), per-member `model_tiers` with
  dispatch-time resolution and validation against available models,
  GLM-4.5-Air premium default, e2e suites on GitHub-hosted runners, and
  `docs/opencode-getting-started.md`. This is the door to local/self-hosted
  OpenAI-compatible models.
- **Antigravity (agy) provider maturation** -- `--agent` flag dispatch,
  session-resume fixes, safety rationalization (`docs/agy-safety-rationalization.md`).
- **Role-agent file installation, including remote members** --
  `apra-fleet install` writes planner/doer/reviewer/plan-reviewer agent
  definitions into each provider's agents directory, and `update_member`
  provisions them to remote members too.
- **Member categories and tags** -- `category` plus up to 10 `tags` on
  register/update, tag-filtered `list_members`, and tag-driven
  `compose_permissions` profile merging. This shipped what the old
  roadmap called "member groups".
- **No-LLM members** -- `llm_provider: none` for machines that only run
  commands or host services (GPU nodes, relays).
- **Live member activity viewer** -- `apra-fleet watch` streams what every
  member is doing.
- **CLI ergonomics** -- `install` is the default action and `run` starts
  the MCP server; bare Claude model aliases instead of pinned dated IDs;
  npm packaging and the SEA binary coexist on every supported platform.

### The knowledge layer

- **Knowledge Bank MCP tools** -- `kb_session_prime`, `kb_capture`,
  `kb_query`, `kb_harvest`, `kb_promote`, `kb_export` and the rest of the
  `kb_*` family, scoped per repo and opt-in per repo (`kb_setup`). See
  [docs/knowledge-layer.md](docs/knowledge-layer.md).
- **Code-intelligence provider abstraction** -- `code_graph`,
  `code_impact`, `code_query`, `code_context` route through a pluggable
  provider, selected per member via `codeIntelProvider`, with repo-scoped
  `kb_harvest` firing automatically after `execute_prompt`.

---

## Near-term (next few weeks)

The near-term is dominated by finishing what the supervisor opened, not by
new surface area.

- **Pass the supervisor end-to-end smoke gate and drop the "preview"
  label.** The declared acceptance for the supervisor -- a full
  plan-develop-review-harvest cycle through apra-fleet-se against a live
  sandbox -- is not yet proven end to end. This is the single most
  important open item in the repo.
- **Supervisor dashboard parity** so it is a strict superset of the
  fleet-sprint viewer, and make apra-fleet-se the single supported entry
  point for running sprints (the CLI stays as the low-level path).
- **Prove the knowledge layer's value with eval evidence** before turning
  it on by default: merge only what paired eval sprints show is a
  measurable win, behind the per-member/per-repo provider routing that
  already has tests.
- **Windows parity as a standing theme.** The bug record (POSIX-only agent
  checks, bd ENOENT spawns, pipefail on non-bash shells, silent Windows
  SEA build failures) says cross-platform drift is the most common
  regression class; expect continued small fixes plus regression guards
  rather than one big effort.
- **One transform pipeline for role agents** across all providers, instead
  of provider-specific handling of agent definitions.

## Mid-term (1-3 months)

Extrapolating from what the architecture is clearly reaching toward:

- **Hub-spoke cloud mode becomes usable.** The groundwork is already in
  the tree -- `packages/fleet-api-contract`, `docs/hub-spoke-master-plan.md`,
  the wire-protocol and hub-service-deployment docs, the identity model,
  and the `apra-fleet join` / `apra-fleet spoke` CLI commands -- but spoke
  mode is not end-to-end yet. With HTTP transport the default and the
  supervisor a long-lived service, a hub that remote spokes attach to is
  the natural next step, and it is the prerequisite for any hosted
  offering.
- **Dashboard auth and RBAC.** `docs/dashboard-oauth-rbac-design.md`
  exists for a reason: the moment the supervisor dashboard is the front
  door to a shared, always-on service (and especially a hub), it needs
  login and roles. Expect this to ride immediately behind hub-spoke.
- **A second real workflow on apra-fleet-workflow.** The engine was
  explicitly built for more than fleet-sprint (see
  `docs/authoring-workflows.md`). The credible proof that "any workflow"
  is real is a shipped second workflow -- likely something operational
  (release playbook automation or an e2e/integration runner) since those
  already exist as semi-manual scripts in this repo.
- **Knowledge layer graduates from opt-in to default.** If the eval
  results hold up, the trajectory is: code-intel provider on by default
  for sprint members, repo-scoped harvest on session close, and then a
  central/team KB server -- in that order, each behind evidence.
- **Cost governance surfaces in the dashboard.** The pieces exist
  (`docs/cost-model.md`, `get_member_model_pricing`, per-turn cost
  calculation); the missing piece is per-sprint/per-member cost rollups
  where operators actually look -- the supervisor dashboard.
- **Sprint calibration data starts steering sprints.** The engine already
  writes `sprint calibration` and `sprint-analysis` commits every cycle;
  the obvious next step is feeding that history back into planning
  (cycle-count estimates, model-tier selection, stall-timeout tuning)
  instead of only recording it.

## Long-term (3-12+ months)

- **Hosted fleet / fleet-as-a-service on the hub-spoke foundation.** Once
  spoke mode and dashboard RBAC exist, a managed hub is mostly an ops
  problem, not an architecture problem. Multi-fleet federation
  (hub-of-hubs) is the step after, and should stay speculative until at
  least two independent hubs exist in practice.
- **Workflows beyond software engineering.** The README already markets
  "any domain" (retail replenishment, logistics exceptions, intake
  triage); making that true requires the mid-term items first: a proven
  second workflow, workflow authoring docs that outsiders can follow, and
  an extension/distribution story for workflows that are not baked into
  the repo.
- **Enterprise governance: audit trail and policy.** The security
  substrate is unusually strong already (OOB secrets, per-provider
  permission composition, the permission-block-surfacing convention); the
  missing enterprise piece is an immutable audit log of fleet operations
  and secret usage, which becomes mandatory the moment a hosted hub has
  more than one tenant.
- **Close the self-development loop fully.** The endgame the dogfooding
  is pointing at: the supervisor runs continuously against this repo,
  fleet-sprint files, fixes, reviews, and ships its own bugs with the
  human as reviewer-of-last-resort, and the calibration/KB layers make
  each sprint measurably cheaper than the last. Everything above --
  supervisor smoke gate, knowledge layer, cost rollups, calibration
  feedback -- is a component of that loop.

### Deliberately not on the roadmap

Items the evidence does not currently
support prioritizing: gbrain integration (superseded by the
code-intelligence abstraction), Playbooks as a separate feature (largely
subsumed by the workflow engine), Slack notifications and a Terraform
provider (no recent activity or demand signal in the tracker). They can
return if demand shows up.

---

## Contributing

Pick an item above, open an issue to discuss your approach, then submit a
PR. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
