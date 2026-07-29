# Roadmap

This roadmap is grounded in the repo's actual git history and issue tracker
(beads), not aspiration. "Shipped" means it is on `main`. "In flight" means
there is a recently-active branch with real commits behind it. The forward
sections are a projection of where the current trajectory leads; priorities
shift based on what the fleet itself surfaces while building this codebase.

Have an idea? [Open a feature request](https://github.com/Apra-Labs/apra-fleet/issues/new/choose).

---

## What's shipped

### The fleet-sprint engine and the workflow platform (v0.4.0 line)

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
  sprints, history, backlog tree) on one reverse-proxied port. Shipped in
  the big v0.4.0 merge (`732dc38d`) and hardened in #362; still gated
  "preview" because the full end-to-end supervisor smoke cycle has not yet
  passed cleanly.
- **Sprint reliability hardening (#362 and the mac1 dogfood run)** --
  credential-auth self-heal via `provision_vcs_auth`, orphaned-CLI
  recovery, PID-liveness "lease of life" so a flaky channel no longer
  produces false empty-response failures, a stall detector that watches
  all transcript activity (not just chat) and kills confirmed stalls,
  and dispatch-vs-sync failure separation so a Dolt/git push hiccup no
  longer burns a full LLM re-dispatch (`apra-fleet-6z8.*`).
- **MCP transport defaults to streamable HTTP** -- one long-lived
  `apra-fleet run` server on `localhost:7523/mcp` shared by every
  provider, replacing per-session stdio subprocesses; `--stdio` remains
  as an alias.
- **apra-pm "comes home"** -- the `vendor/apra-pm` submodule is gone;
  apra-pm is a package-local dependency at `packages/apra-fleet-se/apra-pm`,
  which removed a whole class of silent submodule drift in CI/e2e/packaging.
- **Deterministic e2e harness** -- fleet setup/teardown is a script, not
  an LLM improvisation (#353), checkpoint consolidation is deterministic
  (#360), and turn-budget/git-auth/log-collection flakes were fixed (#359).

### Providers and members (v0.3.x line)

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
  provisions them to remote members too (#336).
- **Member categories and tags** -- `category` plus up to 10 `tags` on
  register/update, tag-filtered `list_members`, and tag-driven
  `compose_permissions` profile merging (#314). This shipped what the old
  roadmap called "member groups".
- **No-LLM members** -- `llm_provider: none` for machines that only run
  commands or host services (GPU nodes, relays).
- **Live member activity viewer** -- `apra-fleet watch` streams what every
  member is doing (#319).
- **CLI ergonomics** -- `install` is the default action, `run` starts the
  MCP server (v0.3.3); bare Claude model aliases instead of pinned dated
  IDs (v0.3.4); npm packaging and the SEA binary coexist, including the
  Windows `build:binary` fix.

### Shipped, then deliberately pulled back

- **Knowledge bank v1 (#296)** -- kb_query/kb_harvest/kb_promote MCP
  tools, KB server, HTTP provider -- landed on `main` and was then
  reverted (#303). The capability is being re-approached through the
  code-intelligence abstraction (see in flight below) with eval evidence
  this time, rather than re-landed wholesale.

---

## Currently in flight

These are the recently-active branches with substantive work behind them,
described honestly.

1. **Supervisor viewer parity -- `feat/supervisor-viewer-parity`** (active
   today). Bringing the apra-fleet-se supervisor dashboard up to parity
   with the fleet-sprint viewer: server-side beads data for a Backlog
   tree, Sprints/Backlog tabs, server-side filtering, header filters,
   multi-select, workflow-UX language, plus Windows fixes (bd spawn via
   shell, POSIX-only agent-existence check in execute_prompt). Mid-to-late
   stage: the views exist and are being polished, not scaffolded.

2. **apra-fleet-se productization and packaging -- `kj/fix-apra-fleet-se`
   on top of `feat/sprint-service-1`** (active today). Making the
   supervisor service actually installable and runnable outside the dev
   tree: ESM bundle require-shim for CJS deps, shipping all runner
   siblings, dev-manifest fixes for the retired vendor path, plus
   supervisor test hardening (contention-aware scaled timeouts, live smoke
   retest evidence for the eft.5x-8x bug family, engine round-resume
   semantics). Late stage for packaging; the end-to-end supervisor smoke
   gate is the remaining exit criterion.

3. **Code intelligence / knowledge layer, round two --
   `feat/code-intelligence-abstraction`, `chore/merge-main-into-code-intel`,
   and the `test/kb-eval-a`/`test/kb-eval-b` A/B eval branches** (active
   this week). A pluggable code-intel provider abstraction
   (codebase-memory-mcp as default), a per-member `codeIntelProvider`
   field with per-member routing in tool dispatch, repo-scoped
   `kb_harvest` auto-harvest wired to execute_prompt completion, and
   paired eval sprints measuring whether the KB actually helps. Mid stage:
   core routing and harvest provenance are implemented and tested; the
   merge-back branch (`chore/merge-main-into-code-intel`) is reconciling
   it with current main.

4. **Live dogfood hardening channel -- `fleet-sprint/mac1`** (active
   today). Not a feature branch but a real fleet-sprint run on a macOS
   member whose output is a steady stream of engine fixes: non-ASCII
   sanitization in task descriptions, stall-poller timestamp scoping,
   failed-streak exclusion from review dispatch, cost usage field-name
   fix, POSIX-sh pipefail guards. This loop is now the primary way engine
   bugs get found.

5. **agy dynamic agent transform -- `feat/agy-agent-transform`** (last
   commits ~5 days ago). Transforms fleet agent definitions into
   Antigravity-native rules at dispatch time and fixes session resume
   (FLEET_SESSION_ID parsing, `--continue` fallback). Small and mid stage.

---

## Near-term (next few weeks)

The near-term is dominated by finishing what v0.4.0 opened, not by new
surface area.

- **Pass the supervisor end-to-end smoke gate and drop the "preview"
  label.** The declared acceptance for the sprint-service epic -- a full
  plan-develop-review-harvest cycle through apra-fleet-se against a live
  sandbox -- has failed five attempted cycles; the root causes found so
  far (phantom interactive sessions, dead-session timeouts, duplicate
  doer commits on retry) are fixed but not yet proven together. This is
  the single most important open item in the repo.
- **Cut the v0.4.0 release.** `docs/release-notes-v0.4.0.md` is drafted
  and `package.json` already says 0.4.0; landing supervisor-viewer-parity
  and the se packaging fixes is what stands between the draft and a tag.
- **Merge supervisor viewer parity** so the supervisor dashboard is a
  strict superset of the fleet-sprint viewer, and make apra-fleet-se the
  single supported entry point for running sprints (the CLI stays as the
  low-level path).
- **Land the code-intelligence abstraction with eval evidence.** The
  kb-eval A/B branches exist precisely to avoid a second #303-style
  revert: merge only what the paired sprints show is a measurable win,
  behind the per-member/per-repo provider routing that already has tests.
- **Windows parity as a standing near-term theme.** The recent bug record
  (POSIX-only agent checks, bd ENOENT spawns, pipefail on non-bash shells,
  the silent Windows SEA build failure) says cross-platform drift is the
  most common regression class; expect continued small fixes plus
  regression guards rather than one big effort.
- **Finish and merge the agy agent transform** so all providers get role
  agents through one transform pipeline instead of provider-specific hacks.

## Mid-term (1-3 months)

Extrapolating from what the architecture is clearly reaching toward:

- **Hub-spoke cloud mode becomes usable.** The groundwork is already in
  the tree -- `packages/fleet-api-contract`, `docs/hub-spoke-master-plan.md`,
  the wire-protocol and hub-service-deployment docs, and the identity
  model shipped in v0.4.0 -- but `apra-fleet join` / spoke mode is not
  end-to-end yet. With HTTP transport now the default and the supervisor
  a long-lived service, a hub that remote spokes attach to is the natural
  next step, and it is the prerequisite for any hosted offering.
- **Dashboard auth and RBAC.** `docs/dashboard-oauth-rbac-design.md`
  exists for a reason: the moment the supervisor dashboard is the front
  door to a shared, always-on service (and especially a hub), it needs
  login and roles. Expect this to ride immediately behind hub-spoke.
- **A second real workflow on apra-fleet-workflow.** The engine was
  explicitly built for more than fleet-sprint (`docs/authoring-workflows.md`,
  the workflow-core boundary refactoring doc). The credible proof that
  "any workflow" is real is a shipped second workflow -- likely something
  operational (release playbook automation or an e2e/integration runner)
  since those already exist as semi-manual scripts in this repo.
- **Knowledge layer graduates from experiment to default.** If the
  kb-eval results hold up, the trajectory is: code-intel provider on by
  default for sprint members, repo-scoped harvest on session close, and
  then the central/team KB server re-landed from the reverted #296 work --
  in that order, each behind evidence.
- **Cost governance surfaces in the dashboard.** The pieces exist
  (`docs/cost-model.md`, `get_member_model_pricing`, per-turn cost
  calculation that just got a field-name fix on mac1); the missing piece
  is per-sprint/per-member cost rollups where operators actually look --
  the supervisor dashboard.
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

### Deliberately not on the roadmap (revisited from the previous version)

Items the old roadmap carried that the evidence does not currently
support prioritizing: gbrain integration (superseded by the
code-intelligence abstraction), Playbooks as a separate feature (largely
subsumed by the workflow engine), Slack notifications and a Terraform
provider (no recent activity or demand signal in the tracker). They can
return if demand shows up.

---

## Contributing

Pick an item above, open an issue to discuss your approach, then submit a
PR. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
