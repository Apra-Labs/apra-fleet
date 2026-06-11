# Roadmap

This roadmap reflects current plans. Priorities shift based on community feedback.
Have an idea? [Open a feature request](https://github.com/Apra-Labs/apra-fleet/issues/new/choose).

Items marked [*] are good first issues for new contributors.

---

## Recently shipped

- [x] **npm packaging** -- `npm install -g @apralabs/apra-fleet` now works on all platforms (Node.js 22+); SEA binary and npm coexist on the same machine; delivery mode detection in `--version` output _(v0.2.2)_
- [x] **Self-update command** -- `apra-fleet update` replays install options; npm mode redirects to `npm update -g @apralabs/apra-fleet` _(v0.2.2)_
- [x] **Beads auto-install** -- `bd` issue tracker CLI installed automatically during `apra-fleet install` _(v0.2.2)_
- [x] **Model tier mapping override** -- per-provider cheap/standard/premium model customization via `~/.apra-fleet/config.json` _(v0.2.2)_
- [x] **HTTP+SSE transport** -- MCP HTTP+SSE transport enabling remote members to connect over the network _(v0.2.1)_
- [x] **Antigravity (agy) support** -- full agy provider support with custom model tier definitions _(v0.2.1)_

---

## Near-term (next 1-2 sprints)

- [ ] **Knowledge layer** -- Cached codebase context, learning persistence across sessions, KB Agent role that auto-harvests learnings on session close, and central KB server for team-wide knowledge sharing ([PR #296](https://github.com/Apra-Labs/apra-fleet/pull/296))
- [ ] **Agent file installation** -- `apra-fleet install` now writes planner/doer/reviewer/plan-reviewer agent definitions to the provider's agents directory (`~/.claude/agents/`, `~/.gemini/agents/`, etc.), making `execute_prompt` with `agent:` parameter work out of the box ([PR #289](https://github.com/Apra-Labs/apra-fleet/pull/289))
- [ ] **Blindfold security dependency** -- Extract credential security (auth-socket, credential-store, crypto, OOB collection) into the standalone `@apralabs/blindfold` package; removes `resolve_secure` MCP tool (security hardening); fleet consumes it as a dependency ([PR #274](https://github.com/Apra-Labs/apra-fleet/pull/274))
- [ ] **Member groups / tags** -- Tag members (e.g. `gpu`, `build`, `test`) and target prompts at groups; categorized grouping and status chips in `fleet_status` output ([PR #238](https://github.com/Apra-Labs/apra-fleet/pull/238))
- [ ] **Per-instance data dir isolation** -- `--data-dir` / `--instance` flags for `install` so multiple fleet instances on the same machine use isolated config/log directories ([PR #231](https://github.com/Apra-Labs/apra-fleet/pull/231), [issue #193](https://github.com/Apra-Labs/apra-fleet/issues/193))
- [ ] **Web dashboard** -- Browser UI for fleet topology, member status, live prompt monitoring, token/cloud cost visibility, git activity, and audit trail; VS Code extension embeds the same view with clickable file paths ([discussion #188](https://github.com/Apra-Labs/apra-fleet/discussions/188))
- [ ] **Session log export** -- One-click markdown export of `fleet logs` output from the dashboard; builds on session history and listing work ([issue #189](https://github.com/Apra-Labs/apra-fleet/issues/189)) [*]

## Medium-term (1-2 months)

- [ ] **gbrain integration** -- Persistent knowledge layer connecting agents to a local knowledge graph; 12 new fleet tools across brain query/write, code analysis, minion job queue, and course correction ([PR #266](https://github.com/Apra-Labs/apra-fleet/pull/266), [RFC #265](https://github.com/Apra-Labs/apra-fleet/discussions/265))
- [ ] **Multiple providers per member** -- Assign more than one LLM provider to a member and switch between them without re-registration ([issue #125](https://github.com/Apra-Labs/apra-fleet/issues/125))
- [ ] **Agent-to-agent communication** -- Members communicate directly, not only through coordinator ([discussion #196](https://github.com/Apra-Labs/apra-fleet/discussions/196), [issue #152](https://github.com/Apra-Labs/apra-fleet/issues/152))
- [ ] **Playbooks** -- JIT-compiled orchestration sequences: write environment-neutral runbooks once, fleet compiles them to native scripts per device and caches them; zero LLM cost on repeat runs with autonomous repair on failure ([discussion #194](https://github.com/Apra-Labs/apra-fleet/discussions/194))
- [ ] **PM as full product lifecycle manager** -- Extend the PM skill through deploy, integration verification, quality grading, log monitoring, and backlog reprioritization; closes the loop beyond PR approval ([discussion #198](https://github.com/Apra-Labs/apra-fleet/discussions/198))
- [ ] **Extension layer** -- Org-private skills and template overrides that survive fleet updates via a shadowing directory (`~/.apra-fleet/extensions/`); foundation for a community marketplace ([discussion #195](https://github.com/Apra-Labs/apra-fleet/discussions/195))
- [ ] **Expanded member targets** -- Docker containers, Kubernetes pods, WSL instances, Azure VMs, and GCP VMs as first-class fleet members ([issue #193](https://github.com/Apra-Labs/apra-fleet/issues/193))
- [ ] **Slack notifications** -- Notify a Slack channel when members go offline, get blocked, or complete a task ([issue #77](https://github.com/Apra-Labs/apra-fleet/issues/77))

## Long-term (3+ months)

- [ ] **Fleet-as-a-Service** -- Hosted version for teams that don't want to self-host
- [ ] **Multi-fleet federation** -- Connect multiple fleet servers for cross-team orchestration
- [ ] **Terraform / Pulumi provider** -- Infrastructure-as-code for fleet topology
- [ ] **Audit log** -- Immutable append-only record of all fleet operations and secret usage for enterprise governance ([issue #159](https://github.com/Apra-Labs/apra-fleet/issues/159)) [*]

---

## Contributing

Pick any item above (especially [*] ones), open an issue to discuss your approach, then submit a PR.
See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
