# Agent File Installation -- Code Review

**Reviewer:** fiany
**Date:** 2026-05-30 02:35:00-0400
**Verdict:** APPROVED

> See the recent git history of this file to understand the context of this review.
> Commits reviewed: 04d8e94 (feat(install): write agent files to provider agentsDir during install),
> 152420c (feat(install): add agent file installation for claude, gemini, and agy)
> Build: PASS (tsc clean). Tests: 1492 passed, 6 skipped, 0 failed. ASCII: clean in new code.

---

## 1. Provider Directory Correctness

**PASS.** Each provider's `agentsDir` in `src/cli/config.ts` matches the requirements:

| Provider | agentsDir | Expected | Verdict |
|----------|-----------|----------|---------|
| Claude   | `~/.claude/agents` | `~/.claude/agents/*.md` | PASS |
| Gemini   | `~/.gemini/agents` | `~/.gemini/agents/*.md` | PASS |
| AGY      | `~/.gemini/antigravity-cli/agents` | `~/.gemini/antigravity-cli/agents/*.md` | PASS |
| Codex    | `undefined` | Skip silently | PASS |
| Copilot  | `undefined` | Skip silently | PASS |

The `agentsDir: string | undefined` type correctly models the skip-vs-write distinction.
The guard `const agentsStep = paths.agentsDir !== undefined` at line 508 controls whether
the install step runs.

---

## 2. AssetManifest Interface -- Both Paths

**PASS.** The `agents: Record<string, string>` field is added to the `AssetManifest`
interface (line 54). Both asset paths populate it correctly:

- **Dev mode** (`buildDevManifest`): Scans `agents/` directory with `fs.existsSync` guard,
  collects `*.md` files as `{ filename: 'agents/filename' }`. Correct.
- **SEA mode** (`scripts/gen-sea-config.mjs`): Same scan logic at lines 50-58. Agent files
  are added to the SEA `assets` object at lines 105-108, ensuring they are bundled into the
  binary. Manifest includes the agents field at line 68. Correct.

The `agents` count is logged during SEA config generation (line 77:
`Agents: ${Object.keys(agents).length} files`).

---

## 3. SEA Bundler -- All 4 Agent Files

**PASS.** The repo contains all 4 required agent files:

- `agents/doer.md`
- `agents/planner.md`
- `agents/reviewer.md`
- `agents/plan-reviewer.md`

The SEA bundler scans `agents/*.md` dynamically (not hardcoded), so all 4 files are
included automatically. Both the manifest and the SEA assets map are populated.

---

## 4. Agent Installation Logic

**PASS.** The install step (lines 682-690) is clean:

```
if (agentsStep) {
    console.log(`  [${coreSteps}/${totalSteps}] Installing agent files...`);
    fs.mkdirSync(paths.agentsDir!, { recursive: true });
    for (const [name, assetKey] of Object.entries(manifest.agents)) {
      const content = extractAsset(assetKey);
      writeAssetFile(path.join(paths.agentsDir!, name), content);
    }
}
```

- Creates directory with `recursive: true` (idempotent).
- Uses the same `extractAsset` + `writeAssetFile` pattern as hooks, scripts, and skills.
- Placement is correct: after PM skill (step 7), before Beads (step baseSteps).
- The `!` assertion on `paths.agentsDir` is safe because `agentsStep` guards it.

---

## 5. Step Count and Summary Log

**PASS.** The step numbering logic is correct:

```
const coreSteps = (installFleet && installPm) ? 8 : installFleet ? 7 : installPm ? 8 : 6;
const baseSteps = coreSteps + (agentsStep ? 1 : 0);
const totalSteps = baseSteps + (serviceStep ? 1 : 0);
```

Traced for the default case (Claude, --skill all, dev mode):
- coreSteps = 8 (steps 1-7 + agents gets step 8)
- baseSteps = 9 (Beads gets step 9)
- totalSteps = 9 (no service step in dev mode)

For Claude, SEA, HTTP, --skill none:
- coreSteps = 6, baseSteps = 7, totalSteps = 8
- Agents: [6/8], Beads: [7/8], Service: [8/8]

For Codex, --skill none:
- coreSteps = 6, agentsStep = false, baseSteps = 6, totalSteps = 6
- Beads: [6/6], no agents step. Correct.

The summary line includes `Agents: ${paths.agentsDir}` conditionally (line 750):
```
${agentsStep ? `\n  Agents:      ${paths.agentsDir}` : ''}
```

**NOTE:** The `installPm ? 8` branch in the `coreSteps` ternary is dead code -- `installPm`
can only be true when `installFleet` is also true (the `skillMode === 'pm'` case sets both).
Not a bug, just unreachable. Pre-existing from the original `totalSteps` formula.

---

## 6. Test Coverage

**PASS.** Five new test cases cover the agent installation feature:

| Test | What it verifies | Verdict |
|------|------------------|---------|
| Claude agents | `mkdirSync(~/.claude/agents)` + `writeFileSync(doer.md, planner.md)` | PASS |
| Gemini agents | `mkdirSync(~/.gemini/agents)` + `writeFileSync(doer.md)` | PASS |
| AGY agents | `mkdirSync(~/.gemini/antigravity-cli/agents)` + `writeFileSync(doer.md)` | PASS |
| Codex skip | No `writeFileSync` calls to `~/.codex/agents/` | PASS |
| Copilot skip | No `writeFileSync` calls to `~/.copilot/agents/` | PASS |

The `setupWithAgents()` helper properly mocks the FS layer to simulate the agents
directory containing `['doer.md', 'planner.md']`. Tests verify both directory creation
(mkdirSync with recursive) and file writes (writeFileSync with correct paths).

Existing test updates are also correct:
- `install-force.test.ts`: Mock manifest updated to include `agents: {}`. PASS.
- `install.test.ts`: Mock manifests updated, Beads step number expectation changed
  from `[8/8]` to `[9/9]` (accounts for new agents step for Claude). PASS.
- `install-service.test.ts`: Mock manifests updated, step number expectations updated. PASS.

---

## 7. Scope Beyond Agent Installation (Transport Changes)

The first commit (04d8e94) also includes transport-related changes that were part of
earlier work on this branch but landed in the same diff:

- **Codex HTTP transport** (`mergeCodexConfig`): URL-based config for HTTP mode, command+args
  for stdio. PASS -- clean conditional, TOML round-trip verified by tests.
- **Transport flag parsing** (`--transport http|stdio`): Correct parsing with `=` and
  space-separated variants. Unknown value exits with error. Added to known flags set.
  14 new transport tests covering all 5 providers x both modes + invalid flag. PASS.
- **Service registration step** in install: SEA + HTTP only. Matches PLAN.md T11. PASS.

These changes are well-tested and consistent with the install feature. No concerns.

---

## 8. File Hygiene

**PASS.** Files changed in the two commits under review:

| File | Justification |
|------|---------------|
| `src/cli/config.ts` | Add `agentsDir` to ProviderInstallConfig | Justified |
| `src/cli/install.ts` | Agent step + transport + service step | Justified |
| `scripts/gen-sea-config.mjs` | Bundle agents in SEA | Justified |
| `tests/install-multi-provider.test.ts` | New agent + transport tests | Justified |
| `tests/install-force.test.ts` | Update mock manifest | Justified |
| `tests/install.test.ts` | Update mock manifest + step numbers | Justified |
| `tests/install-service.test.ts` | Update mock manifest + step numbers | Justified |
| `requirements.md` | Trimmed to current scope | Justified |
| `llms-full.txt` | Regenerated (em-dash cleanup) | Justified |

No temp files, no tool configs, no stale artifacts.

---

## 9. ASCII Compliance

**PASS for new code.** All new source code in the two commits is ASCII-only. The
`install.ts` comment was changed from em-dash to `--`:
```
-  // shell:true required on Windows -- npm global packages install as .cmd wrappers
```

**NOTE (pre-existing):** The test name on line 401 of `install-multi-provider.test.ts`
contains an em-dash (`--`  rendered as `\xe2\x80\x94`), but this line was introduced in
commit af2788b (earlier on this branch), not in these two commits. Not a regression.

---

## Summary

The agent file installation feature is correctly implemented across all dimensions:

- **Provider paths:** All 5 providers handle correctly (3 write, 2 skip).
- **Both asset paths:** Dev-mode `buildDevManifest` and SEA `gen-sea-config.mjs` both
  collect and bundle agent files.
- **Install logic:** Clean loop using existing `extractAsset` + `writeAssetFile` pattern.
- **Step numbering:** Correct dynamic calculation across all skill/agent/service
  combinations.
- **Tests:** 5 new agent tests + 14 transport tests, all existing tests updated and passing.
- **Build + tests:** tsc clean, 1492 tests passed, 0 failed.

No blocking issues found. One non-blocking note about dead code in the coreSteps ternary
(pre-existing). One pre-existing ASCII issue in a test name from an earlier commit.

**Verdict: APPROVED.** The feature is ready to merge.
