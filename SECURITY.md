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

## Credential Handling

Fleet is designed so that secrets never enter the LLM conversation or appear in logs. The following controls are in place:

- **Encryption at rest** — credentials stored via `credential_store_set` are encrypted with AES-256-GCM. Plaintext is never written to disk or config files.
- **Out-of-band collection** — secret values are always collected via a separate terminal window (OOB prompt), not through the chat interface. The LLM never sees the value during input.
- **LLM context isolation** — `{{secure.NAME}}` tokens are resolved server-side, after the LLM has finished generating the command. The plaintext value is substituted at execution time, not during prompt construction.
- **Output redaction** — any command output that contains a stored credential's plaintext value is automatically redacted to `[REDACTED:NAME]` before the result is returned to the LLM. This applies to stdout, stderr, and structured output.
- **Network egress policy** — each credential can be assigned an egress policy (`allow`, `confirm`, `deny`) controlling whether it can be sent to external hosts. The server enforces this before executing commands that would transmit the resolved value over the network.
- **No value retrieval** — `credential_store_list` returns credential names only. There is no API to retrieve stored plaintext — secrets are write-once from the credential store's perspective.

## Out of Scope

The following are not considered security vulnerabilities for this project:

- Vulnerabilities in dependencies that have upstream fixes already available — please open a regular issue or PR
- Issues requiring physical access to the host machine
- Social engineering attacks
- Denial-of-service via resource exhaustion on self-hosted deployments
- Security issues in third-party MCP servers or integrations not maintained by Apra Labs
