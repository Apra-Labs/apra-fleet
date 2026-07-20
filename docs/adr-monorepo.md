# Architecture Decision Record (ADR): Monorepo and Domain-Specific Editions

## 1. Context & Background
Historically, the ecosystem was split into `apra-fleet` (the core MCP server) and consumer repositories like `apra-pm` (which hosted skills, dynamic workflows like auto-sprint, and the fleet-client). However, the submodule approach created friction (e.g., requiring two installers for fleet and SE skills). 

Going forward, the architecture will unify these components into a highly cohesive structure organized around domain-specific extensions building upon a powerful, generic core. 

## 2. The Modular Ecosystem

### 2.1 `apra-fleet-core`
**Responsibility:** The foundational infrastructure.
**Contents:**
- The `apra-fleet` MCP server
- `@apralabs/apra-fleet-client` (MCP client SDK and transports)
- `@apralabs/apra-fleet-workflow` (The dynamic workflow engine, pipeline abstractions, Dashboard Viewer, and Vetting Engine)

`apra-fleet-core` is purely horizontal. It has no knowledge of Software Engineering, Retail, or Logistics. It simply provides the rails for multi-agent orchestration via MCP.

### 2.2 Domain-Specific Editions
By decoupling the core from the skills, we publish specialized "editions" of Apra Fleet tailored to specific industries. Each edition depends on `apra-fleet-core`.

- **`apra-fleet-se` (Software Engineering):** Automated software engineering capabilities (essentially what "today's apra-fleet" and `apra-pm` do combined). Includes SE-focused hooks (git, testing), skills (planner, doer, reviewer), and workflows (`auto-sprint`).
- **`apra-fleet-retail`:** Skills/agents for inventory management, CRM integration, supply chain querying.
- **`apra-fleet-logistics`:** Route planning agents, fleet tracking hooks, dynamic re-routing workflows.
- **`apra-fleet-legal`:** Contract analysis agents, compliance checking hooks, document drafting workflows.
- **`apra-fleet-healthcare`:** HIPAA-compliant data routing agents, patient scheduling workflows.

## 3. Decision: The Monorepo Strategy

To support this Core + Industry Editions architecture, we have evaluated the "Existential Question" of adopting a Monorepo.

### 3.1 Why a Monorepo is Highly Advantageous
1. **Atomic Refactoring:** Changes to the `WorkflowEngine` signature in `apra-fleet-core` can be simultaneously updated in `apra-fleet-se`'s workflows in the exact same Pull Request. This eliminates version mismatch nightmares.
2. **Zero Integration Friction:** Developers do not have to wait for `apra-fleet-core` to be published to NPM to test how a new infrastructure feature impacts the retail or logistics editions. Local NPM Workspaces seamlessly link them together.
3. **Unified Tooling:** One `npm install`, one testing framework, one formatting rule set, and centralized CI/CD pipelines.

### 3.2 The Primary Risk & Licensing Dealbreaker
A monorepo setup has one critical architectural flaw: **Git does not support folder-level read permissions.** 

- **The Dealbreaker:** If the strategy involves open-sourcing `apra-fleet-core` to build a community, but keeping `apra-fleet-legal` or `apra-fleet-healthcare` as proprietary, closed-source enterprise products, a single monorepo *cannot* be used for the proprietary editions.
- **Other Cons:** As the number of editions grows, developers experience noise and scale issues (cloning healthcare code when they only work on retail), though tools like Turborepo or Git Sparse-Checkout mitigate this. Versioning also becomes more complex requiring tools like Lerna or Changesets to bump package versions correctly.

### 4. Conclusion
We will adopt the Monorepo structure for maximum developer velocity **assuming a uniform licensing/access model**. 

*If* proprietary boundaries are required in the future for specific enterprise editions, those specific editions will be extracted into private polyrepos, while `apra-fleet-core` and open editions (like `apra-fleet-se`) remain in the central monorepo.
