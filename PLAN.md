# Implementation Plan — #3, #4, #12

> Add max_turns parameter to execute_prompt, complete Apra Labs branding, and inject custom icon into SEA binary.

---

## Tasks

### Phase 1: execute_prompt max_turns (#3)

#### Task 1: Add max_turns parameter
- **Change:** Add `max_turns` (optional, default 50, min 1, max 500) to `executePromptSchema`. Add `maxTurns` param to `buildPromptCommand` in interface + both OS implementations. Replace hardcoded `--max-turns 50`.
- **Files:** `src/tools/execute-prompt.ts`, `src/os/os-commands.ts`, `src/os/linux.ts`, `src/os/windows.ts`
- **Done when:** `execute_prompt({..., max_turns: 10})` produces `claude -p ... --max-turns 10`

#### Task 2: Update tests
- **Change:** Verify max_turns passes through in platform tests. Verify default (50) when omitted.
- **Files:** `tests/platform.test.ts`, `tests/execute-prompt.test.ts`
- **Done when:** All tests pass

#### VERIFY: Phase 1

---

### Phase 2: Apra Labs Branding (#4)

#### Task 3: Update package.json metadata
- **Change:** Add `author: "Apra Labs"`, `homepage: "https://github.com/Apra-Labs/apra-fleet"`, `repository`, `bugs`. Update `description` (agents→members). Sync `version` to `0.1.0`.
- **Files:** `package.json`
- **Done when:** Fields present and accurate

#### Task 4: Update GitHub repo metadata
- **Change:** `gh repo edit` — set description, topics (`mcp`, `claude-code`, `fleet`, `ssh`, `orchestration`).
- **Files:** None (GitHub API)
- **Done when:** `gh repo view` shows updated info

#### VERIFY: Phase 2

---

### Phase 3: SEA Binary Icon (#12)

#### Task 5: Generate icon assets
- **Change:** Source logo committed at `assets/icons/logo-source.png` (730x500). Create square 512x512 `icon-512.png` (pad with transparent background). Run `node scripts/gen-ico.mjs` to generate `assets/icons/apra-fleet.ico`. Script already in repo (adapted from apra-focus). Commit the `.ico`.
- **Files:** `assets/icons/icon-512.png` (new), `assets/icons/apra-fleet.ico` (new)
- **Done when:** `.ico` exists with 16/32/48/256px sizes
- **Blockers:** sips (macOS) or ImageMagick for resizing

#### Task 6: Add icon injection to SEA packaging
- **Change:** In `scripts/package-sea.mjs`, add step BEFORE postject (critical ordering): detect `.exe` output → run `rcedit --set-icon assets/icons/apra-fleet.ico`. Follow apra-focus pattern: search for rcedit in PATH, .cmd, npm global root.
- **Files:** `scripts/package-sea.mjs`, `package.json` (add `rcedit` to devDependencies)
- **Done when:** Local Windows build produces binary with Apra Labs icon

#### Task 7: Update CI for icon
- **Change:** Add `npm install -g rcedit` to Windows build job. Commit the `.ico` to repo (no gen-ico step in CI — generated once, committed).
- **Files:** `.github/workflows/ci.yml`
- **Done when:** CI Windows build produces binary with custom icon

#### VERIFY: Phase 3

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| Logo 730x500, not square | Stretched icon | Pad to square before resizing |
| rcedit before postject ordering | Icon overwritten | Confirmed: rcedit MUST run before postject (apra-focus validated) |
| rcedit not found in CI | Windows build fails | `npm install -g rcedit` in CI step |
| max_turns=0 | claude -p error | Schema validates min 1 |

## Notes
- Base branch: main
- Each task = one commit
- VERIFY = checkpoint, stop and report
