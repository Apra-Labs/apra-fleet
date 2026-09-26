# Contributing to apra-pm

Thank you for your interest in contributing! This document explains how to get
involved.

## Reporting Bugs

Use the [Bug Report](https://github.com/Apra-Labs/apra-fleet/issues/new/choose)
issue template. Include reproduction steps, environment info, and any error output.

## Requesting Features

Use the [Feature Request](https://github.com/Apra-Labs/apra-fleet/issues/new/choose)
issue template. Describe the problem, your proposed solution, and any alternatives.

## What this package is

apra-pm lives in the apra-fleet monorepo at `packages/apra-fleet-se/apra-pm/` and is
edited there. It is mostly Markdown -- a skill (`skills/pm/`) and the agent
definitions (`agents/`) that an AI coding harness loads as instructions -- plus a
small plain-Node installer, the auto-sprint workflow script, and an
end-to-end harness. There is no build step and no compiled source.

| Path | What it contains |
|------|------------------|
| `skills/pm/` | the skill: `SKILL.md` and sub-docs the orchestrator reads on demand |
| `agents/` | agent definitions shared by the pm skill and auto-sprint |
| `agents/schemas/` | machine-readable input/output contracts per role |
| `.claude/workflows/` | `auto-sprint.js` -- deterministic Claude Code workflow, including the `PURE_FUNCTIONS` cost-arithmetic block |
| `lib/` | `parse-sprint-args.mjs`, `vet-kb-work.mjs` -- standalone helpers |
| `test/` | `node --test` suites (`npm test`) |
| `sprint-logs/` | `calibration.json` + durable per-sprint JSONL cost logs |
| `install.mjs` | installer: copies the skill + agents into a provider config dir |
| `e2e/` | drives the skill headless against the toy repo and checks checkpoints |
| `docs/` | design intent and sprint workflow user guide |

## Development Setup

**Prerequisites:** Node.js 20+, git, and beads (`bd`).

```bash
git clone https://github.com/Apra-Labs/apra-fleet.git
cd apra-fleet
# enable this package's ASCII pre-commit guard (core.hooksPath is repo-wide and
# resolves from the repository root):
git config core.hooksPath packages/apra-fleet-se/apra-pm/.githooks
cd packages/apra-fleet-se/apra-pm
node install.mjs --llm claude         # install the skill + agents locally
```

Editing skills or agents takes effect immediately -- they are Markdown, with no
rebuild. Re-run `node install.mjs --force` to refresh your installed copy.

## Testing

Unit tests cover the pure functions in `.claude/workflows/auto-sprint.js` (extracted
from its `PURE_FUNCTIONS` block), the installer, the skill/agent text contracts, and
the `lib/` helpers:

```bash
npm test                              # run the unit suites (node built-in test runner)
node --check install.mjs              # syntax-check the installer
node e2e/run-e2e.mjs --suite s1       # run one e2e suite (needs the provider CLI + bd)
```

Agent and skill correctness is exercised end-to-end. See `e2e/` and the README
for details on running the suites.

## Branch Naming

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feat/<short-description>` | `feat/deploy-runbook` |
| Bug fix | `fix/<short-description>` | `fix/worktree-cleanup` |
| Docs | `docs/<short-description>` | `docs/contributing-guide` |

Always branch from `main`.

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):
`<type>(<scope>): <short summary>`. Common types: `feat`, `fix`, `docs`, `chore`,
`refactor`.

## Pull Request Process

1. Fork the repo and branch from `main`.
2. Make your changes, following the style notes below.
3. Syntax-check any changed JS (`node --check`) and run the relevant e2e suite.
4. Open a PR against `main` using the PR template.
5. A maintainer reviews; address feedback; once approved, a maintainer merges.

## Style

- **ASCII only:** no non-ASCII characters in committed files. Use `--` for
  em-dashes, `->` for arrows, `[OK]` for checkmarks. The pre-commit hook enforces this.
- **Affirmative prose:** describe what the skill does, not what it is not.
- **Provider-neutral:** the skill text names no specific provider or model. Concrete
  model choices are made by the planner agent at runtime.
- **Simple, direct code:** prefer plain Node with no dependencies in the installer
  and e2e harness.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE) that covers this project.
