# Contributing to apra-fleet

Thank you for your interest in contributing! This document explains how to get involved.

## Reporting Bugs

Use the [Bug Report](.github/ISSUE_TEMPLATE/bug_report.yml) issue template on GitHub. Include as much detail as possible — reproduction steps, environment info, and error output are especially helpful.

## Requesting Features

Use the [Feature Request](.github/ISSUE_TEMPLATE/feature_request.yml) issue template. Describe the problem you're trying to solve, your proposed solution, and any alternatives you've considered.

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

## License

By contributing, you agree that your contributions will be licensed under the [CC BY-SA 3.0](LICENSE) license that covers this project.
