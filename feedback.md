## APPROVED

### T1.5 -- `repo` parameter added to fleet tool schemas (commit efb5c5a)

File: `src/tools/code-intelligence.ts`

All four schemas have `repo` as an optional string property:
- `codeGraphSchema`: `repo: z.string().optional().describe('Absolute path to the repository root. Required when multiple repositories are indexed.')`
- `codeImpactSchema`: same pattern
- `codeQuerySchema`: same pattern
- `codeContextSchema`: same pattern

Checklist:
- [OK] `repo` present in all four schemas (codeGraphSchema, codeImpactSchema, codeQuerySchema, codeContextSchema)
- [OK] NOT in `required` arrays -- uses `.optional()` throughout
- [OK] Description mentions specifying repo when multiple are indexed

### T2.4 -- routing instruction written to ~/.claude/CLAUDE.md on install (commit 08429e2)

File: `src/cli/install.ts` (lines 793-806, inside Step 9)

Checklist:
- [OK] Sentinel-guarded block appends routing instruction to ~/.claude/CLAUDE.md
- [OK] Sentinel: <!-- apra-fleet:code-intelligence -->
- [OK] Block is in a try/catch (non-fatal -- warns and continues on error)
- [OK] Creates ~/.claude/ dir if missing: fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true })
- [OK] Skips write if sentinel already present (idempotent): if (!existing.includes(sentinel))
- [OK] Routing instruction text tells Claude to prefer code_graph/impact/query/context over grep/file reads

### Build and test

- npm run build: PASS (no errors)
- npm test: 2 failures in tests/time-utils.test.ts -- confirmed pre-existing at commit 584862b (Phase 2 approved state), not introduced by T1.5 or T2.4
