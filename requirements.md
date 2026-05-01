# Issue #159 — Credential audit log

## Problem

When `{{secure.NAME}}` is resolved, there is no record of which member used which credential and when. Without an audit trail, post-incident review and compliance checks are blind.

## Goal

Append an entry to `~/.apra-fleet/data/credential-audit.log` on every credential lifecycle event. Log names only — never values.

## Log format

```
2026-04-20T05:12:34Z  RESOLVED  member=fleet-dev  credential=github_pat  tool=execute_command
2026-04-20T05:13:01Z  RESOLVED  member=fleet-dev  credential=github_pat  tool=execute_command
2026-04-20T05:14:22Z  SET       member=PM         credential=deploy_key   scope=fleet-dev
2026-04-20T05:14:55Z  DELETED   member=PM         credential=session_tok
2026-04-20T05:15:10Z  REJECTED  member=fleet-rev  credential=github_pat  reason=scope_violation
```

## Events to log

| Event | Trigger |
|-------|---------|
| `SET` | `credentialSet()` called |
| `DELETED` | `credentialDelete()` called |
| `RESOLVED` | `credentialResolve()` returns plaintext |
| `REJECTED` | `credentialResolve()` returns `{ denied }` or `{ expired }` |
| `EXPIRED` | `purgeExpiredCredentials()` removes a credential |

## Security properties

- Names only — no values, no ciphertext
- Append-only — no delete API; entries survive credential deletion
- File permissions: `0o600` (owner read/write only)
- Log rotation: cap at 10MB (configurable), rotate to `.1` suffix

## Files in scope

- `src/services/credential-audit.ts` (new) — audit log append function
- `src/services/credential-store.ts` — add audit calls at each event; add `tool?: string` param to `credentialResolve()`
- `src/tools/execute-command.ts`, `provision-auth.ts`, `provision-vcs-auth.ts`, `register-member.ts`, `setup-git-app.ts`, `update-member.ts`, `credential-store-update.ts` — pass `tool` name to `credentialResolve()`
- `tests/credential-audit.test.ts` (new)

## Notes

- Base branch: `main`
- No new MCP tool needed — audit is a side-effect of existing operations
- Pairs with credential scoping: scope violations become auditable `REJECTED` events
