# Implementation Plan: Track and Resolve npm Audit Vulnerabilities

**Issue:** #100  
**Complexity:** Complex (dependency updates, testing, potential breaking changes)

## Problem Summary

`npm audit` reports 6 high severity vulnerabilities in transitive dependencies. None are directly exploitable in apra-fleet's current CLI/MCP server architecture, but should be addressed before or shortly after open-source release.

## Analysis

- 6 high severity vulnerabilities in transitive dependencies
- Root cause: outdated `@modelcontextprotocol/sdk`
- Fix involves `npm audit fix` which adds 49 packages, changes 7
- Risk of breaking API changes from SDK update

## Implementation Plan

### Phase 1: Assessment
- [ ] Run `npm audit` to get current baseline
- [ ] Run `npm audit fix --dry-run` to see proposed changes
- [ ] Review changelog for `@modelcontextprotocol/sdk` between current and proposed versions
- [ ] Identify any breaking API changes

### Phase 2: Update Dependencies
- [ ] Create feature branch `fix/npm-audit-vulnerabilities`
- [ ] Run `npm audit fix`
- [ ] Review `package-lock.json` changes
- [ ] Update any code affected by SDK API changes

### Phase 3: Testing
- [ ] Run full test suite: `npm test`
- [ ] Manual testing of MCP server startup
- [ ] Test all MCP tools (register_member, execute_prompt, etc.)
- [ ] Verify no regressions in fleet operations

### Phase 4: Verification
- [ ] Confirm `npm audit` reports 0 high/critical vulnerabilities
- [ ] All existing tests pass
- [ ] No breaking changes to MCP tool interfaces
- [ ] Update documentation if SDK changes affect usage

## Estimated Effort
2-4 hours

## Files Affected
- `package.json` - Dependency version constraints
- `package-lock.json` - Locked dependency tree
- Potentially TypeScript files using MCP SDK APIs if breaking changes exist
