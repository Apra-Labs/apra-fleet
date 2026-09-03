# Drift guard dry-run evidence (my-beads-db-27m.10, T1.5.1)

Acceptance criteria for this bead require the deliberate-failure dry-run to
be recorded in a committed file (not only a PR description, which a doer on
a branch cannot write). This is that record.

## What was touched

`src/tools/kb-feedback.ts`, `kbFeedbackSchema.reason` field: appended the
literal text `DRYRUN-TOUCH` to the zod `.describe()` string, then ran
`npm run build` (so `dist/tools/kb-feedback.js` picked up the new
description) WITHOUT running `npm run contract:generate` afterwards --
exactly the "edited a zod schema, forgot to regenerate" scenario this guard
exists to catch.

## Failing command and assertion

```
npm run contract:check
```

Output:

```
contract:generate --check: 1 mismatch(es):
  - .../memory-contract/v1/schemas/kb_feedback.request.json: CONTENT DIFFERS from what generation produces now
```

Exit code: nonzero (`process.exitCode = 1`, generate-contract.mjs's
`CHECK_MODE` branch, `MISMATCHES.length > 0`).

The same drift is caught by the in-tree vitest wrapper,
`tests/memory-contract-drift-guard.test.ts`, whose
`contract:check reports zero drift across schemas/, bindings/mcp/, and
bindings/openapi/` test failed with the identical mismatch message when run
against the touched tree (`npx vitest run
tests/memory-contract-drift-guard.test.ts`).

In CI this same drift would additionally be caught by the
`.github/workflows/ci.yml` `build-and-test` job's "Verify memory-contract
generated files are up to date" step (`npm run contract:generate` followed
by `git diff --exit-code -- memory-contract/v1/schemas
memory-contract/v1/bindings`), which fails on the same
`kb_feedback.request.json` file for the same underlying reason -- a real
dirty git diff, not just an in-memory `--check` mismatch.

## Revert and green confirmation

Reverted `src/tools/kb-feedback.ts` to drop `DRYRUN-TOUCH`, re-ran
`npm run build`, then re-ran `npm run contract:check`:

```
contract:generate --check: OK -- 23 tools, 46 schema files, 23 binding files, 1 openapi file, 21 projectable taxonomy codes, all match and cross-reference cleanly.
```

`git status --porcelain src/tools/kb-feedback.ts memory-contract/v1/schemas
memory-contract/v1/bindings` produced no output afterwards -- the tree was
restored to the committed state, confirming the guard has no side effects
of its own and the dry-run left nothing behind.
