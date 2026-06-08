# blindfold-migration - Post-PR hardening review

**Reviewer:** reviewerAF
**Date:** 2026-05-22 15:42:00+05:30
**Verdict:** APPROVED

> See `git log -- blindfold-migration/feedback.md` for prior reviews (sprint final APPROVED previously).

---

## Goal of this change

Remove the resolve_secure MCP tool from blindfold to close a wire-level
leak: it returned plaintext credentials in MCP responses, placing them
into LLM context. blindfold becomes vault-management-only on the wire;
token resolution stays library-only and is consumed by hosts (apra-fleet).

---

## Verifications

### Wire surface (MCP tools registered): PASS
4 registerTool calls in blindfold/src/mcp/server.ts (lines 25, 34, 43, 52):
credential_store_set, credential_store_list, credential_store_delete,
credential_store_update. No resolve_secure registration.

### resolve_secure removed (file, registration, tests): PASS
- grep for resolve_secure, resolveSecureHandler, resolveSecureSchema in
  blindfold/src/ and blindfold/tests/: zero matches.
- blindfold/src/mcp/tools/resolve-secure.ts: file does not exist.
- No import of a resolve-secure module anywhere in the MCP server.

### Live MCP server tool list: PASS
JSON-RPC probe (tools/list) against `node dist/cli/index.js` after clean
rebuild from v0.0.2 source returned exactly 4 tools:
  credential_store_set
  credential_store_list
  credential_store_delete
  credential_store_update

NOTE: initial probe against a stale dist/ (pre-existing from a prior
checkout) showed 5 tools including resolve_secure. After `rm -rf dist &&
npm run build`, the rebuilt dist correctly registers only 4. The stale
dist was a local artifact, not a source-level issue -- the v0.0.2 source
at 580213c is correct.

### Library exports preserved: PASS
All 6 symbols exported from blindfold/src/index.ts (lines 24-29):
  resolveSecureTokens, resolveSecureField, redactOutput,
  containsSecureTokens, SECURE_TOKEN_RE, SEC_HANDLE_RE

### README updated with vault-only positioning: PASS
Section "Standalone vs host-integrated usage" at blindfold/README.md:70-94
(~25 lines). Explains vault-only MCP surface, why resolve_secure is
intentionally absent (plaintext would enter LLM context), and that host
integration (e.g. apra-fleet) is required for workflow use. ASCII-only
(no em-dashes, smart quotes, or emoji in the new section).

MCP tool reference table (lines 61-67) lists exactly 4 tools; no
resolve_secure row.

### blindfold v0.0.2 tag points at correct commit: PASS
gh api repos/Apra-Labs/blindfold/git/refs/tags/v0.0.2:
  object.sha = 580213c82e985832eaaa696416c6682783766804
Commit message: "feat(blindfold)!: remove resolve_secure MCP tool;
vault-only surface" -- mentions removal, ASCII-only, no AI attribution.

### apra-fleet submodule pointer advanced: PASS
git show --stat 80da6cc:
  blindfold | 2 +-
  1 file changed, 1 insertion(+), 1 deletion(-)
Only the submodule pointer changed. Commit message is clean.

### blindfold tests: 139/0
7 test files, 139 tests passing, 0 failing. All green.

### apra-fleet build + tests: PASS, 1169/3
npm run build (tsc): exit 0. npm test: 1169 passing, 3 failing (all
pre-existing baseline: 1 platform login-shell, 2 time-utils IST).
16/16 in credential-store-and-execute.test.ts.

### INC-1 isolation (registry diff lines): 0
Registry.json snapshot before and after npm test: zero diff lines.

### Spurious OOB pops: none
No unexpected terminal popups during any test run.

### ASCII + AI attribution sprint-wide: PASS
git log main..HEAD: 0 matches for claude/anthropic/ai-generated/
co-authored-by. All commits authored by mradul <mradul@apra.in>.

### execute_command integration spot-check: PASS
src/tools/execute-command.ts:11 imports resolveSecureTokens, redactOutput,
SEC_HANDLE_RE, registerTaskCredentials, collectOobConfirm from 'blindfold'.
Uses resolveSecureTokens at lines 73, 81 and redactOutput at lines 148, 175.
Integration test (credential-store-and-execute.test.ts): 16/16 pass.

---

## Summary

**APPROVED**

**HIGH findings:** 0
**MEDIUM findings:** 0
**LOW findings:** 0

The resolve_secure MCP tool is fully removed from blindfold v0.0.2 at
both the source and wire levels. The live MCP server (after clean build)
registers exactly 4 vault-management tools. All 6 library exports are
preserved for host consumption. The README documents the vault-only
positioning and the design rationale. The v0.0.2 tag on GitHub points at
the correct commit (580213c). apra-fleet's submodule bump (80da6cc) is a
clean single-file change. Build, tests, and INC-1 isolation all pass.
The wire-level credential leak is closed.
