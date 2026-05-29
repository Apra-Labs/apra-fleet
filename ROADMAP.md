# Roadmap

This roadmap reflects current plans. Priorities shift based on community feedback.
Have an idea? [Open a feature request](https://github.com/Apra-Labs/apra-fleet/issues/new/choose).

Items marked [*] are good first issues for new contributors.

---

## Near-term (next 1-2 sprints)

- [ ] **npm publish** -- Publish to npm so users can `npx apra-fleet install` [*]
- [ ] **HTTP+SSE transport** -- MCP HTTP+SSE transport enabling remote members to connect over the network
- [ ] **Web dashboard** -- Browser UI for fleet topology, member status, live prompt monitoring, token/cloud cost visibility, git activity, and audit trail; VS Code extension embeds the same view with clickable file paths ([discussion #188](https://github.com/Apra-Labs/apra-fleet/discussions/188))
- [ ] **Memory plane integration** -- Connect fleet agents to codebase knowledge indices so task planning starts from a structured map of architecture and relevant files rather than blind token-expensive discovery; encompasses persistent inter-session memory and sprint-accumulated knowledge graphs ([RFC #265](https://github.com/Apra-Labs/apra-fleet/discussions/265), [discussion #249](https://github.com/Apra-Labs/apra-fleet/discussions/249), [PR #266](https://github.com/Apra-Labs/apra-fleet/pull/266))
- [ ] **Session log export** -- One-click markdown export of `fleet logs` output from the dashboard; builds on session history and listing work ([issue #189](https://github.com/Apra-Labs/apra-fleet/issues/189)) [*]
- [ ] **Member groups / tags** -- Tag members (e.g. `gpu`, `build`, `test`) and target prompts at groups; categorized grouping in status output ([PR #238](https://github.com/Apra-Labs/apra-fleet/pull/238))

## Medium-term (1-2 months)

- [ ] **Agent-to-agent communication** -- Members communicate directly, not only through coordinator ([discussion #196](https://github.com/Apra-Labs/apra-fleet/discussions/196), [issue #152](https://github.com/Apra-Labs/apra-fleet/issues/152))
- [ ] **Playbooks** -- JIT-compiled orchestration sequences: write environment-neutral runbooks once, fleet compiles them to native scripts per device and caches them; zero LLM cost on repeat runs with autonomous repair on failure ([discussion #194](https://github.com/Apra-Labs/apra-fleet/discussions/194))
- [ ] **PM as full product lifecycle manager** -- Extend the PM skill through deploy, integration verification, quality grading, log monitoring, and backlog reprioritization; closes the loop beyond PR approval ([discussion #198](https://github.com/Apra-Labs/apra-fleet/discussions/198))
- [ ] **Extension layer** -- Org-private skills and template overrides that survive fleet updates via a shadowing directory (`~/.apra-fleet/extensions/`); foundation for a community marketplace ([discussion #195](https://github.com/Apra-Labs/apra-fleet/discussions/195))
- [ ] **Expanded member targets** -- Docker containers, Kubernetes pods, WSL instances, Azure VMs, and GCP VMs as first-class fleet members; includes per-instance data dir isolation for multi-fleet on the same machine ([PR #231](https://github.com/Apra-Labs/apra-fleet/pull/231))
- [ ] **Multiple providers per member** -- Assign more than one LLM provider to a member and switch between them without re-registration ([issue #125](https://github.com/Apra-Labs/apra-fleet/issues/125))
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
