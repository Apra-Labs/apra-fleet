# Apra Fleet Architecture Vision

## Background
Historically, the ecosystem was split into `apra-fleet` (the core MCP server) and consumer repositories like `apra-pm` (which hosted skills, dynamic workflows like auto-sprint, and the fleet-client). However, the submodule approach created friction (e.g., requiring two installers for fleet and SE skills). 

Going forward, the architecture will unify these components into a highly cohesive monorepo, structured as domain-specific extensions building upon a powerful, generic core.

## The Modular Ecosystem

### 1. `apra-fleet-core`
**Responsibility:** The foundational infrastructure.
**Contents:**
- The `apra-fleet` MCP server
- `@apralabs/apra-fleet-client` (MCP client SDK and transports)
- `@apralabs/apra-fleet-workflow` (The dynamic workflow engine, pipeline abstractions, Dashboard Viewer, and Vetting Engine)

`apra-fleet-core` is purely horizontal. It has no knowledge of Software Engineering, Retail, or Logistics. It simply provides the rails for multi-agent orchestration via MCP.

### 2. Domain-Specific Editions

By decoupling the core from the skills, we can publish specialized "editions" of Apra Fleet tailored to specific industries. Each edition depends on `apra-fleet-core` and injects its own specialized hooks, skills, agents, and workflows.

#### `apra-fleet-se` (Software Engineering)
**Responsibility:** Automated software engineering capabilities (essentially what "today's apra-fleet" and `apra-pm` do combined).
**Contents:**
- SE-focused hooks (git, testing, linting)
- SE-focused skills & agents (planner, doer, reviewer)
- SE dynamic workflows (e.g., `auto-sprint`, PM-lite, multi-cycle code generation)

#### `apra-fleet-retail`
**Responsibility:** Retail industry operations.
**Contents:**
- Skills/agents for inventory management, CRM integration, supply chain querying, and dynamic workflows for retail operations.

#### `apra-fleet-logistics`
**Responsibility:** Supply chain and logistics orchestration.
**Contents:**
- Route planning agents, fleet tracking hooks, dynamic re-routing workflows.

#### `apra-fleet-legal`
**Responsibility:** Legal operations and compliance.
**Contents:**
- Contract analysis agents, compliance checking hooks, document drafting workflows.

#### `apra-fleet-healthcare`
**Responsibility:** Healthcare administration and clinical support.
**Contents:**
- HIPAA-compliant data routing agents, patient scheduling workflows, medical coding skills.

## Summary
This restructuring cleanly separates the *engine* (`apra-fleet-core`) from the *use-case*. Users no longer need complex, disjointed setups across multiple repos. Instead, they can install the edition of Apra Fleet that matches their industry (`apra-fleet-se`, `apra-fleet-legal`, etc.), which brings along the core infrastructure seamlessly as a dependency.
