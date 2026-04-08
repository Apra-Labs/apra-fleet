# Implementation Plan: Track and Resolve Transitive Dependency Vulnerabilities

**Issue:** #100  
**Complexity:** Complex (dependency updates, testing, potential breaking changes)

## Problem Summary

`npm audit` reports 6 high severity vulnerabilities in transitive dependencies. None are directly exploitable in apra-fleet's current CLI/MCP server architecture, but should be addressed before or shortly after open-source release.

### Findings

All vulnerabilities are in transitive deps — not direct dependencies of apra-fleet.

| Package | Severity | Via | Notes |
|---------|----------|-----|-------|
| `hono` ≤4.12.11 | High | `@modelcontextprotocol/sdk` | Cookie injection, path traversal, prototype pollution — not exploitable unless hono routes are exposed publicly |
| `@hono/node-server` ≤1.19.12 | High | `@modelcontextprotocol/sdk` | Auth bypass in serveStatic — same caveat |
| `express-rate-limit` 8.2.0–8.2.1 | High | `@modelcontextprotocol/sdk` | IPv4-mapped IPv6 bypass |
| `path-to-regexp` 8.0.0–8.3.0 | High | `@modelcontextprotocol/sdk` → `express` | ReDoS via sequential optional groups |
| `vite` 7.0.0–7.3.1 | High | `vitest` (devDependency) | Path traversal, arbitrary file read — dev only, not in production binary |
| `picomatch` 4.0.0–4.0.3 | High | `vitest` (devDependency) | ReDoS, method injection — dev only |

**Root Cause:** Outdated version of `@modelcontextprotocol/sdk`. Updating the SDK should resolve the hono/express chain.

## Implementation Plan

### Phase 1: Assessment
- [ ] Run `npm audit` to get current baseline
- [ ] Run `npm audit fix --dry-run` to see proposed changes
- [ ] Review changelog for `@modelcontextprotocol/sdk` between current and proposed versions
- [ ] Identify any breaking API changes

### Phase 2: Update Dependencies
- [ ] Create feature branch `fix/npm-audit-vulnerabilities`
- [ ] Run `npm audit fix`
- [ ] Review `package-lock.json` changes (expected: adds 49 packages, changes 7)
- [ ] Update any code affected by SDK API changes

### Phase 3: Testing
- [ ] Run full test suite: `npm test`
- [ ] Manual testing of MCP server startup
- [ ] Test all MCP tools (register_member, execute_prompt, etc.)
- [ ] Verify no regressions in fleet operations
- [ ] Test edge cases:
  - Member registration
  - File transfers (send_files, receive_files)
  - Command execution (execute_command, execute_prompt)
  - Authentication flows

### Phase 4: Verification
- [ ] Confirm `npm audit` reports 0 high/critical vulnerabilities
- [ ] All existing tests pass
- [ ] No breaking changes to MCP tool interfaces
- [ ] Update documentation if SDK changes affect usage

## Files Affected

- `package.json` - Dependency version constraints
- `package-lock.json` - Locked dependency tree
- Potentially TypeScript files using MCP SDK APIs if breaking changes exist

## Estimated Effort

**2-4 hours** depending on SDK breaking changes

## Success Criteria

- [ ] `npm audit` reports 0 high/critical vulnerabilities
- [ ] All existing tests pass after fix
- [ ] No breaking changes to MCP tool interfaces
- [ ] Documentation updated if needed

## Why Deferred Previously

These vulnerabilities are not exploitable in apra-fleet's current deployment model (local CLI + SSH). Addressing them requires bumping `@modelcontextprotocol/sdk` which may introduce breaking API changes — warrants a dedicated sprint.

## Notes

- The fix is primarily a dependency update
- Main risk is breaking changes in the MCP SDK
- Should be addressed before public open-source release
- Dev-only vulnerabilities (vite, picomatch) have lower priority but should still be resolved
