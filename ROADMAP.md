# Roadmap

This roadmap reflects current plans. Priorities shift based on community feedback.
Have an idea? [Open a feature request](https://github.com/Apra-Labs/apra-fleet/issues/new/choose).

Items marked [*] are good first issues for new contributors.

---

## Near-term (next 1-2 sprints)

- [ ] **npm publish** -- Publish to npm so users can `npx apra-fleet install` [*]
- [ ] **HTTP+SSE transport** -- MCP HTTP+SSE transport enabling remote members to connect over the network
- [ ] **Web dashboard** -- Browser UI for fleet status, member management, and live prompt monitoring [*]
- [ ] **Expanded member targets** -- Docker containers, Kubernetes pods, WSL instances, Azure VMs, and GCP VMs as first-class fleet members
- [ ] **Cursor / Windsurf integration guide** -- Step-by-step docs for non-Claude-Code AI assistants [*]
- [ ] **Member groups / tags** -- Tag members (e.g. `gpu`, `build`, `test`) and target prompts at groups
- [ ] **Session log export** -- Export prompt execution history as markdown [*]

## Medium-term (3-6 months)

- [ ] **Agent-to-agent communication** -- Members communicate directly, not only through coordinator
- [ ] **Plugin system** -- Community-built plugins for custom tools and providers
- [ ] **Result aggregation** -- Merge outputs from parallel member executions into a unified report
- [ ] **Cost dashboard** -- Visualize token and cloud spend across members

## Long-term (6+ months)

- [ ] **Distributed task queue** -- Priority-based job scheduling with retry and dead-letter handling
- [ ] **Fleet-as-a-Service** -- Hosted version for teams that don't want to self-host
- [ ] **Terraform / Pulumi provider** -- Infrastructure-as-code for fleet topology
- [ ] **Audit log** -- Immutable log of all fleet operations for enterprise governance [*]
- [ ] **Multi-fleet federation** -- Connect multiple fleet servers for cross-team orchestration

---

## Contributing

Pick any item above (especially [*] ones), open an issue to discuss your approach, then submit a PR.
See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.
