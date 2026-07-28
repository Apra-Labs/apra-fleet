<!-- llm-context: Live-smoke evidence record for apra-fleet-eft.74.8, corroborating
     apra-fleet-eft.74.1 (explicit interactive opt-in handshake) and apra-fleet-eft.74.2
     (self-heal eviction on interactive timeout) on branch feat/sprint-service-1. -->
<!-- keywords: eft.74, phantom session, interactive routing, execute_prompt, smoke test -->

# eft.74 live smoke retest evidence (apra-fleet-eft.74.8)

## Context

Ran integ-test-playbook.md's Part 2 (Setup) sandbox lifecycle -- fresh HOME,
`node dist/index.js install` (dev-mode), `node dist/index.js start` on the scratch
port `18700`, toy repo clone, sandbox-local git/Dolt remotes via
`scripts/sandbox-seed-beads.mjs`, and `register-member --type local --name toy-doer`
-- to reproduce the eft.74 bug's exact repro sequence: two sequential dispatches to
the SAME local member, in the same work folder, where each dispatched `claude -p`
subprocess connects back to the fleet server over HTTP MCP (member JWT, no pid
anchor) shortly after spawn.

`node dist/index.js install` succeeded cleanly (step [3/12] "Installing scripts..."
did not EISDIR on `scripts/agent-doc-partials/`) -- confirming apra-fleet-eft.84's
fix (`buildDevManifest()` in `src/cli/install.ts` now filters
`fs.readdirSync(..., { withFileTypes: true })` entries with `entry.isFile()`,
explicitly skipping subdirectories) is present on this branch and Part 2 is no
longer blocked at Setup, unblocking this retest.

Rather than the full `workflow fleet-sprint` toy-sprint scenario (steps 2-6 of the
playbook's `## Test scenario`, which need `packages/apra-fleet-workflow` +
`vendor/apra-pm/agents/schemas` workflow-subsystem assets not present in this dev
checkout -- `apra-fleet workflow --list` reported "No workflows installed"), this
retest drove `execute_prompt` directly against the sandbox's HTTP MCP endpoint
(`http://127.0.0.1:18700/mcp`) using the `@modelcontextprotocol/sdk` `Client` +
`StreamableHTTPClientTransport` already vendored in `node_modules` (the same client
stack `tests/transport-integration.test.ts` uses) -- an unauthenticated PM/tool
connection is trusted from the loopback-only bind per
`src/services/http-transport.ts`. This isolates exactly the mechanism under test
(two sequential `execute_prompt` calls to one member) without depending on the
separate workflow-subsystem packaging gap.

## Credential-provisioning note (not part of this bead's scope, filed separately)

Step 3a/3b of the playbook computes `SECRET` from the runner's real
`~/.claude/.credentials.json` as a JSON object (`{accessToken, expiresAt, scopes,
...}`, refresh token stripped) whenever that file exists, then reuses the same
`SECRET` for both the credentials-file bonus write (`auth --oauth --llm claude`,
which JSON-aware-unwraps it via `parseClaudeOAuthSecret`) AND the member env-var
provisioning (`auth --oauth --member toy-doer`, which does NOT unwrap -- see
`provisionEnvVarForMember` in `src/cli/auth.ts`, `encryptPassword(token)` stores
the raw string verbatim). The result: `encryptedEnvVars.CLAUDE_CODE_OAUTH_TOKEN`
ends up holding the whole JSON blob instead of a bare token whenever the runner has
a real credentials file, which the Claude CLI rejects outright ("Authentication
failed on toy-doer") -- confirmed by reproducing it first (both dispatches failed
in ~4.4s with `exit=1`), then working around it for this retest by provisioning
`INTEG-TOY-DOER-TOKEN-RAW` from the bare `$CLAUDE_CODE_OAUTH_TOKEN` env var instead
(present in this runner's environment) and re-running `auth --oauth --member` with
that secret reference. This is an orthogonal credential-provisioning gap, not the
eft.74 phantom-session bug -- not fixed here per doer task scope (this bead is a
`[test]` bead for the live smoke retest itself); filed as apra-fleet-vak.

## Live evidence (this run)

Two sequential `execute_prompt` calls to `toy-doer` (`resume=false`, `timeout_s=120`,
`max_total_s=180`, distinct trivial prompts) via the sandbox's live server:

```
[first]  elapsed=6.0s  -> exit=0, response "eft74-smoke-first-ack",  session=e421d37a-8f75-4412-a650-779e0e2e9d9f
[second] elapsed=5.9s  -> exit=0, response "eft74-smoke-second-ack", session=3cc32afa-8e41-40a7-93fd-83a0761d598c
```

Both dispatches executed successfully and quickly -- neither burned anywhere near
the 120s inactivity timeout or the 180s hard ceiling, and each got a **distinct**
fresh session id (no forced resume onto a wedged session).

Fleet server log (`~/.apra-fleet/data/logs/fleet-<pid>.log` in the sandbox HOME),
the successful run after the credential fix, annotated:

```
{"tag":"execute_prompt","inv":"2xkap","mem":"toy-doer","msg":"[sonnet] resume=false timeout=120s ... first-ack ..."}
{"tag":"execute_prompt","inv":"2xkap","mem":"toy-doer","msg":"pid=64336"}
{"tag":"session","msg":"initialize jwt=false jwt_valid=false member_param=none"}
{"tag":"session","msg":"new sid=e52fe93d-... client=claude-code/2.1.212 caps=roots,elicitation member=false"}   <- dispatched subprocess's post-spawn MCP connect-back
{"tag":"execute_prompt","inv":"2xkap","mem":"toy-doer","msg":"exit=0 in=4 out=116 elapsed=6033ms"}               <- dispatch 1 completes normally
{"tag":"stall_remove","msg":"memberId=4d232ef9-... remaining=0"}
{"tag":"execute_prompt","inv":"t75yj","mem":"toy-doer","msg":"[sonnet] resume=false timeout=120s ... second-ack ..."}   <- dispatch 2 starts immediately after
{"tag":"execute_prompt","inv":"t75yj","mem":"toy-doer","msg":"pid=64379"}                                         <- fresh subprocess, NOT routed to the dispatch-1 connect-back session
{"tag":"session","msg":"new sid=015477bc-... client=claude-code/2.1.212 caps=roots,elicitation member=false"}    <- dispatch 2's own post-spawn connect-back
{"tag":"execute_prompt","inv":"t75yj","mem":"toy-doer","msg":"exit=0 in=4 out=116 elapsed=5863ms"}               <- dispatch 2 completes normally, no timeout
```

Key observations directly evidencing the fix (apra-fleet-eft.74.1/eft.74.2):

- Each dispatch's `claude -p` subprocess DOES connect back to the fleet server
  over HTTP MCP ~1s after spawn (`initialize jwt=false ... new sid=... client=
  claude-code/2.1.212 caps=roots,elicitation`) -- the exact pattern that used to
  register a pid-less phantom interactive session in the original bug.
- Every one of these connect-back sessions logs `member=false` -- confirming
  apra-fleet-eft.74.1's explicit-opt-in-handshake gate: a bare post-spawn MCP
  connect-back is no longer treated as an interactive-routable session for the
  member just because it carries JWT registration.
- Dispatch 2 gets its own fresh `pid=64379` (distinct from dispatch 1's
  `pid=64336`) and its own fresh session id -- it did NOT get routed to
  dispatch 1's lingering connect-back session, and did not wait out any
  interactive-route timeout.
- No `exit=1`/timeout/`warn` log lines appear anywhere in the successful run;
  both dispatches show `exit=0` with normal elapsed times (~6s), nowhere near
  the 120s/180s bounds.

## Regression check (eft.28/eft.50)

```
npx vitest run tests/execute-prompt-phantom-connectback.test.ts tests/execute-prompt-interactive.test.ts
```

Result: **18/18 tests pass**, including the eft.74.2 self-heal-eviction case and
the explicit "regression: existing eft.28/eft.50 dead-session guard ... is
unaffected -- still evicted and re-dispatched fresh" case in
`execute-prompt-phantom-connectback.test.ts`.

## Result

**PASS**: two sequential `execute_prompt` dispatches to the same local member, in
the same work folder, both executed successfully; the second did not time out or
wedge on the first dispatch's phantom post-spawn connect-back session. Server log
evidence confirms no lingering pid-less interactive session was reused across the
two dispatches. Existing eft.28/eft.50 regression tests remain green. This
corroborates apra-fleet-eft.74.1 and apra-fleet-eft.74.2 on `feat/sprint-service-1`,
with apra-fleet-eft.84's install fix confirmed in place to reach this point.
