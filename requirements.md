# Session-ID Collision Fix

Branch: e2e/local-only (fix is committed directly to this branch -- no separate branch)
Repo: Apra-Labs/apra-fleet
Beads: apra-fleet-projects-o81
Doer: fleet-dev   Reviewer: fleet-rev

## The bug

A local Claude fleet member can resume the ORCHESTRATOR's Claude session instead
of its own. A dispatch to the member then runs against the orchestrator's
context: the caller gets answers from unrelated in-progress work, token usage is
misattributed, and the per-member execute_prompt lock can leak (held with no live
process behind it).

## Root cause

The Claude provider drives the CLI with `claude -c` (continue most-recent
session) instead of `claude --resume <session-id>`. The stored session id is used
only as a boolean gate -- if truthy, append `-c` -- and is never passed to the
CLI. On a local member sharing the orchestrator's machine, OAuth, and working
directory, `-c` resumes whichever session is most recent, which is the
orchestrator's active session. The Gemini provider already does this correctly
via the buildResumeFlag helper.

Primary sites: src/providers/claude.ts:43-45 (buildPromptCommand) and
claude.ts:126-128 (resumeFlag). The resume idiom is hand-rolled at 8 sites total
(4 providers x 2 methods); only Gemini's are correct.

## CLI behavior (confirmed by probe 2026-05-16)

claude 2.1.142 and gemini 0.42.0 both:
- accept a caller-minted `--session-id <uuid>` to start a new session (exit 0);
- fail loud on `--resume <unknown-uuid>` (non-zero exit, descriptive error) -- no
  silent fallback to another session;
- reject a reused `--session-id` (non-zero exit).

## The fix -- mint the session id up front (unified, provider-agnostic)

1. provider.ts: add `buildSessionIdFlag(sessionId)` returning
   `--session-id "<sanitized>"`. Keep `buildResumeFlag(sessionId)` returning
   `--resume "<sanitized>"`. Same flag spelling for claude and gemini.

2. execute-prompt.ts: compute the session id BEFORE building the command:
       resuming  = input.resume && agent.sessionId && provider.supportsResume()
       sessionId = resuming ? agent.sessionId : randomUUID()
   sessionId is always defined and known up front. Pass {sessionId, resuming}
   into buildPromptCommand. At onPidCaptured, feed the stall detector
   resolveSessionLogPath(provider, sessionId, workFolder) directly. DELETE the
   fs.watch dir-guess block -- the filename.replace('.jsonl','') path-to-id guess
   around execute-prompt.ts:199-216.

3. claude.ts and gemini.ts: both buildPromptCommand (Linux path) and resumeFlag
   (Windows path) route through the two shared helpers -- resuming uses
   buildResumeFlag, new uses buildSessionIdFlag. DELETE `-c` (claude) and
   `--resume latest` (gemini). Linux and Windows paths must go through the same
   method so they cannot diverge.

4. parseResponse (both providers): still reads session_id from the result event,
   now as an assertion -- it must equal the id we minted or resumed. On mismatch:
   log loud, do NOT persist the wrong id.

5. Resume with no stored id: mint a fresh `--session-id`. Never `-c` or
   `--resume latest`. "Lost the id" honestly means "cannot resume" -- start a
   clean known session.

6. copilot.ts and codex.ts: untouched. Their CLIs cannot take a caller-supplied
   id; they keep the existing find-log-file.ts mtime-scan fallback. Add a code
   comment documenting this as the known exception.

## Tests

- Claude dispatch, resume=false: command contains `--session-id <uuid>`, never `-c`.
- Claude dispatch, resume=true with stored id: command contains `--resume <stored-id>`.
- Claude dispatch, resume=true with no stored id: fresh `--session-id`, not `-c`.
- Gemini equivalents: `--session-id` for new, `--resume <id>` for resume, no `--resume latest`.
- parseResponse: returned id == requested id passes; mismatch path is covered.
- Linux buildPromptCommand and Windows resumeFlag produce consistent flags for the
  same inputs (no two-OS divergence).
- New tests for new behavior; remove or update any test that asserted the old `-c`.

## Done criteria

- All 6 fix points implemented.
- No `-c` or `--resume latest` remains in the claude.ts / gemini.ts dispatch paths.
- All tests above pass; full `npm test` green.
- CI green on `e2e/local-only` after the fix commits.
- copilot.ts / codex.ts behavior unchanged; exception documented in a comment.

## Constraints

- ASCII only in every committed file (apra-fleet pre-commit hook rejects non-ASCII).
- Commit the fix directly to `e2e/local-only`. Do NOT create a separate branch.
  Do NOT push to main.
- Keep commits scoped to the fix: stage only the files this fix changes plus
  requirements.md. Do not commit unrelated working-tree noise.
- Do not change copilot.ts / codex.ts behavior.
