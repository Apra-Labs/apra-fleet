# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

Older versions do not receive security fixes. Please upgrade to the latest 0.1.x release.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email **contact@apralabs.com** with:
- A description of the vulnerability
- Steps to reproduce or a proof-of-concept
- Potential impact assessment
- Any suggested mitigations (optional)

## What to Expect

- **Acknowledgment**: within 2 business days
- **Status update**: within 7 business days (confirmed, investigating, or declined)
- **Fix timeline**: critical issues targeted within 30 days; others based on severity

We will coordinate disclosure timing with you and credit reporters in release notes unless you prefer to remain anonymous.

## Scope

apra-pm is a set of Markdown skill/agent definitions plus a small Node
installer and e2e harness. It runs no server and opens no network listeners. The
main areas of interest:

- The installer (`install.mjs`) -- it writes into your agent harness's config
  directory and merges permission entries into `settings.json`.
- The agents' permission surface -- what tools the orchestrator and subagents are
  allowed to run.

## Out of Scope

- Vulnerabilities in dependencies that have upstream fixes already available --
  please open a regular issue or PR.
- Issues requiring physical access to the host machine.
- Social engineering attacks.
- Behaviour of the underlying agent harness or model provider, which this project
  does not control.
