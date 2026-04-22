# Contributing to apra-fleet

Thank you for your interest in contributing! This document explains how to get involved.

## Reporting Bugs

Use the [Bug Report](https://github.com/Apra-Labs/apra-fleet/issues/new/choose) issue template on GitHub. Include as much detail as possible — reproduction steps, environment info, and error output are especially helpful.

## Requesting Features

Use the [Feature Request](https://github.com/Apra-Labs/apra-fleet/issues/new/choose) issue template. Describe the problem you're trying to solve, your proposed solution, and any alternatives you've considered.

## Development Setup

**Prerequisites:** Node.js 20+, npm

```bash
git clone https://github.com/Apra-Labs/apra-fleet.git
cd apra-fleet
npm install
npm run build
```

## Running Tests

```bash
npm test
```

For watch mode during development:

```bash
npm run test:watch
```

## Branch Naming

| Type | Pattern | Example |
|------|---------|---------|
| Feature | `feature/<short-description>` | `feature/ec2-support` |
| Bug fix | `fix/<short-description>` | `fix/ssh-timeout` |
| Docs | `docs/<short-description>` | `docs/contributing-guide` |

Always branch from `main`.

## Commit Message Convention

Use the [Conventional Commits](https://www.conventionalcommits.org/) format:

```
<type>(<scope>): <short summary>
```

Common types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`

Examples:
- `feat(members): add EC2 instance support`
- `fix(ssh): handle connection timeout gracefully`
- `docs: update contributing guide`

## Pull Request Process

1. Fork the repo and create your branch from `main`.
2. Make your changes, following the code style notes below.
3. Run `npm run build` and `npm test` — both must pass.
4. Open a PR against `main` using the PR template.
5. A maintainer will review your PR. Address any feedback.
6. Once approved, a maintainer will merge it.

## Code Style

- **Language:** TypeScript. Match the style of surrounding code.
- **Formatting:** No enforced formatter currently — keep indentation and style consistent with existing files.
- **No unnecessary abstractions:** Prefer simple, direct code over premature generalization.
- **Error handling:** Only handle errors at real system boundaries (user input, SSH, external APIs). Don't add fallbacks for scenarios that can't happen.

## For AI Agents

If you are an AI agent (or a human using an AI agent) contributing to this project, this section covers the patterns and conventions that matter most.

### Dev-mode install

Build and install from source without touching the packaged binary:

```bash
npm run build && node dist/index.js install
```

This registers the MCP server from your local `dist/` build. Skill files are read from `skills/` on disk — no rebuild needed to iterate on them.

### File map

| Path | What it contains |
|------|-----------------|
| `src/` | TypeScript source for the MCP server, CLI commands, and providers |
| `skills/fleet/` | Fleet skill — tools for managing members, tasks, and files |
| `skills/pm/` | PM skill — orchestration patterns, doer-reviewer loop, deploy flows |
| `hooks/` | Shell hooks that run on Claude Code events (statusline, pre-push, etc.) |
| `CLAUDE.md` | Role-specific instructions (not committed — each agent has its own) |
| `AGENTS.md` | Shared project context for all agents |

### Testing skill changes

Skills are Markdown files — edits take effect immediately without a rebuild. After editing `skills/fleet/` or `skills/pm/`:

1. Save the file.
2. In Claude Code, run `/mcp` to reload the MCP server.
3. The updated skill content is live.

Run `npm test` before committing to catch any regressions in the TypeScript layer.

### Doer-reviewer loop

The PM agent delegates tasks to doer members and assigns a separate reviewer. Code is never self-reviewed. When implementing multi-step work:

- The PM reads the plan (typically `PLAN.md`) and delegates one task at a time.
- Each doer commits and marks the task done in `progress.json`.
- A reviewer member inspects the diff before the PM proceeds.

### Sprint branch naming

| Type | Pattern | Example |
|------|---------|---------|
| Feature sprint | `feat/<desc>` | `feat/install-ux-and-docs` |
| Sprint (generic) | `sprint/<desc>` | `sprint/q2-hardening` |

Agent-driven work always happens on a sprint branch — never directly on `main`.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE) that covers this project.
