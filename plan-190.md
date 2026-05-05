## Planning Session
- Member: fleet-dev2
- Date: 2026-05-01
- Gemini session: 5a72fea9 (start fresh session on fleet-dev2 to resume planning context)

---

# CODEX session resume and session listing — Implementation Plan

> Fix the CODEX provider so that `execute_prompt(resume=true)` actually resumes sessions. Currently `parseResponse()` always returns `sessionId: undefined` and the resume branch in `buildPromptCommand()` never fires. Research the codex CLI's NDJSON output to find the session ID event, then implement capture + resume.

---

## Tasks

### Phase 1: Research

#### Task 1: Capture codex NDJSON session ID event format
- **Change:** On a live codex member, run `codex exec "say hello" --json` and capture the full NDJSON output. Identify the event that contains the session or conversation ID (likely `event.type === "session_created"`, `"session"`, `"conversation_id"`, or similar). Also run `codex exec --help` and `codex --version` and record output. Write findings to `docs/research-190-codex-session.md` on the branch — include: event type name, field path for the ID, exact CLI flag for resume, codex CLI version tested.
- **Files:** `docs/research-190-codex-session.md` (new)
- **Tier:** cheap
- **Done when:** Research doc committed with: session ID event type, field path, resume CLI flag, codex version. If codex CLI has no session ID in its output, document that explicitly and set `supportsResume(): false` as the fix.
- **Blockers:** none

#### Task 2: Research codex session listing
- **Change:** Run `codex --help` and `codex sessions --help` (or equivalent) on the live member to determine whether the codex CLI supports listing past sessions. Append findings to `docs/research-190-codex-session.md` — include: command that lists sessions (if any), output format, whether session IDs match what `parseResponse()` would return.
- **Files:** `docs/research-190-codex-session.md` (append)
- **Tier:** cheap
- **Done when:** Research doc updated with session listing findings (supported with command, or not supported with explanation)
- **Blockers:** none

#### VERIFY: Phase 1
- `docs/research-190-codex-session.md` committed
- Session ID event type and resume flag identified (or `supportsResume()=false` documented)
- `npm run build` passes

---

### Phase 2: Implement session ID capture and resume

#### Task 3: Update `parseResponse()` to extract session ID from NDJSON
- **Change:** In `src/providers/codex.ts`, update `parseResponse()` to scan NDJSON events for the session ID (using the event type and field path identified in Task 1). Assign the found ID to the `sessionId` field of the returned `ParsedResponse`. If no session ID event is found in the output, return `sessionId: undefined` as before. If research (Task 1) showed the CLI has no session ID, instead set `supportsResume(): false` and leave `parseResponse()` unchanged.
- **Files:** `src/providers/codex.ts`
- **Tier:** standard
- **Done when:** After `execute_prompt` on a codex member, `fleet_status` shows a non-null session ID for that member; `parseResponse()` unit test passes with a fixture NDJSON containing the session event
- **Blockers:** Task 1

#### Task 4: Fix `buildPromptCommand()` resume invocation
- **Change:** In `src/providers/codex.ts`, update `buildPromptCommand()` to pass the session ID correctly when `sessionId` is provided, using the CLI flag identified in Task 1 (e.g. `--continue "${sessionId}"` or `--session "${sessionId}"`). Sanitize the session ID with `sanitizeSessionId()` from `provider.ts` before interpolating. Remove the bare `cmd += ' resume'` placeholder.
- **Files:** `src/providers/codex.ts`
- **Tier:** standard
- **Done when:** `buildPromptCommand({..., sessionId: 'abc123'})` produces a command string containing the correct resume flag with the sanitized ID; existing command-string unit test updated to cover the resume case
- **Blockers:** Tasks 1, 3

#### VERIFY: Phase 2
- `npm run build` passes
- `npm test` passes
- Manual: two sequential `execute_prompt(resume=true)` calls on a codex member share context (second call refers to something said in the first)

---

### Phase 3: Session listing

#### Task 5: Implement session listing for codex (or document as unsupported)
- **Change:** Based on Task 2 research: **If** the codex CLI supports listing sessions — implement a `listSessions()` method on `CodexProvider` that runs the listing command and parses the output into `SessionEntry[]`. **If** it does not — add a comment in `codex.ts` noting the gap with a reference to issue #190, and ensure `supportsSessionList()` (if it exists) returns `false`. Either way, commit a record of the decision.
- **Files:** `src/providers/codex.ts`, possibly `src/providers/provider.ts` (if interface needs updating)
- **Tier:** standard
- **Done when:** Session listing works end-to-end, OR `supportsSessionList()` returns `false` with a documented reason
- **Blockers:** Task 2

#### VERIFY: Phase 3
- `npm run build` passes
- `npm test` passes

---

### Phase 4: Tests

#### Task 6: Unit tests for `parseResponse()` session ID extraction
- **Change:** In `tests/providers/codex.test.ts` (create if absent), add fixtures: (a) NDJSON with a valid session ID event → assert `sessionId` is captured correctly; (b) NDJSON with no session event → assert `sessionId` is `undefined`; (c) existing message parsing tests — ensure they still pass after the `parseResponse()` change.
- **Files:** `tests/providers/codex.test.ts`
- **Tier:** standard
- **Done when:** `npm test` passes with all cases covered
- **Blockers:** Task 3

#### Task 7: Unit tests for `buildPromptCommand()` resume path
- **Change:** In `tests/providers/codex.test.ts`, add: (a) call with `sessionId: undefined` → assert resume flag absent; (b) call with `sessionId: 'abc123'` → assert correct resume flag and sanitized ID in the command string.
- **Files:** `tests/providers/codex.test.ts`
- **Tier:** standard
- **Done when:** `npm test` passes with both cases covered
- **Blockers:** Task 4

#### VERIFY: Phase 4
- `npm test` passes clean across all suites
- Manual integration: `/pm status` on a codex member shows session ID; `resume=true` call continues prior context

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| codex CLI emits no session ID in NDJSON output | high | Task 1 research identifies this; fallback is `supportsResume(): false` to stop misleading callers |
| codex CLI resume flag differs by version | med | Task 1 captures exact CLI version; pin minimum version in `installCommand()` comment |
| `sanitizeSessionId()` rejects codex session ID format (e.g. UUID with colons) | low | Check sanitizer regex in `provider.ts` against actual ID format found in Task 1 |
| Session listing not supported by codex CLI | low | Document and expose via `supportsSessionList(): false`; no user-visible regression |

## Notes
- Base branch: `main`
- Implementation branch: `feat/codex-session-resume`
- Each task = one git commit
- VERIFY = checkpoint, stop and report
- Phase 1 must run on a live codex member — ensure one is registered before starting
