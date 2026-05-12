# apra-fleet — gbrain Integration Plan

> Integrate gbrain as an optional knowledge and durability backend for apra-fleet. Fleet tools expose gbrain capabilities (brain query/write, code analysis, Minions job queue); PM and any orchestrator inherit access through existing fleet tools. No duplication — gbrain runs as a separate MCP server process, fleet connects as a client.

## Exploration Findings

### Codebase Patterns
- **Tool registration**: Zod schema + async handler in `src/tools/<name>.ts`, imported and registered in `src/index.ts` via `server.tool(name, desc, schema.shape, wrapTool(name, handler))`
- **Agent config**: `Agent` interface in `src/types.ts`, persisted in `~/.apra-fleet/data/registry.json` via `src/services/registry.ts`
- **Member resolution**: `memberIdentifier` spread + `resolveMember()` from `src/utils/resolve-member.ts`
- **Strategy pattern**: `getStrategy(agent)` returns SSH or local execution strategy
- **MCP SDK 1.27.0**: Has both server (`@modelcontextprotocol/sdk/server/mcp.js`) and client (`@modelcontextprotocol/sdk/client/index.js`) modules — client is available for connecting to gbrain

### Verified Assumptions
| Assumption | Verification |
|---|---|
| No existing gbrain code in repo | `grep -ri gbrain` returns only requirements.md and marketing pitches |
| Agent interface has no gbrain field | Read `src/types.ts` — confirmed |
| MCP SDK has client module | `require.resolve('@modelcontextprotocol/sdk/client/index.js')` succeeds |
| Tool registration is flat (no plugin system) | All 30 tools registered directly in `src/index.ts` |
| Reviewer template is `skills/pm/tpl-reviewer.md` | Read — 66 lines, uses `{{PLACEHOLDER}}` variables |
| Tests use vitest with `makeTestAgent()` + registry backup/restore | Read `tests/test-helpers.ts` and existing test files |

### Risk Register Items
| Risk | Impact | Mitigation |
|---|---|---|
| gbrain MCP server protocol version mismatch with fleet's SDK 1.27.0 | Connection fails silently | Phase 1 validates connection with version negotiation; VERIFY checkpoint tests real handshake |
| gbrain process not running when fleet tool is called | Tool returns confusing error | Graceful error: "gbrain not available — is the process running? See docs for setup" |
| Minions requires Postgres — PGLite may not support job queue | Minions dispatch unavailable without Postgres | Document PGLite vs Postgres capabilities clearly; Minions tools check DB backend before accepting jobs |
| gbrain tool names may change across versions | Fleet tools break silently | Pin to known gbrain tool names; gbrain client validates available tools on connect |
| Token overhead from brain queries in reviewer template | Exceeds 1% budget | Brain queries are opt-in and conditional; measure token cost in Phase 5 VERIFY |

---

## Tasks

### Phase 1: gbrain Client Service + Agent Config

> Foundation: the MCP client service that connects to gbrain, and the config fields that control opt-in. Every subsequent phase depends on this.

#### Task 1.1: Add `gbrain` field to Agent interface and registry
- **Change:** Add `gbrain?: boolean` to the `Agent` interface in `src/types.ts`. No migration needed — optional field, defaults to `undefined` (falsy). Add `gbrain?: boolean` to `FleetRegistry` interface-level config for fleet-wide gbrain server settings (process command, args, env).
- **Files:** `src/types.ts`
- **Tier:** cheap
- **Done when:** TypeScript compiles. Existing tests pass unchanged. `Agent` type accepts `gbrain: true`.
- **Blockers:** None

#### Task 1.2: Add `gbrain` to register_member and update_member schemas
- **Change:** Add `gbrain` field (optional boolean, default false) to `registerMemberSchema` and `updateMemberSchema`. In `registerMember()`, pass through to agent creation. In `updateMember()`, allow toggling. Display gbrain status in `listMembers` and `memberDetail` output.
- **Files:** `src/tools/register-member.ts`, `src/tools/update-member.ts`, `src/tools/list-members.ts`, `src/tools/member-detail.ts`
- **Tier:** cheap
- **Done when:** `register_member` with `gbrain: true` persists the field. `update_member` can toggle it. `list_members` shows gbrain status. `member_detail` shows gbrain status. Existing tests pass.
- **Blockers:** Task 1.1

#### Task 1.3: Create gbrain MCP client service
- **Change:** Create `src/services/gbrain-client.ts` — a singleton service that:
  1. Spawns gbrain as a child process (stdio transport) when first needed, using configurable command/args from fleet config or env vars (`GBRAIN_COMMAND` default `npx -y gbrain`, `GBRAIN_ARGS`)
  2. Connects via MCP SDK Client class (`@modelcontextprotocol/sdk/client/index.js`) over `StdioClientTransport`
  3. Validates connection by listing available tools on connect
  4. Exposes `callTool(toolName: string, args: Record<string, unknown>): Promise<string>` — proxy any gbrain tool call
  5. Exposes `isConnected(): boolean` and `getAvailableTools(): string[]`
  6. Exposes `disconnect(): Promise<void>` — kills child process
  7. Handles reconnection on process crash (lazy reconnect on next `callTool`)
  8. Returns clear error messages when gbrain is not available
- **Files:** `src/services/gbrain-client.ts` (new)
- **Tier:** premium
- **Done when:** Unit tests verify: connect/disconnect lifecycle, callTool proxies correctly, error on unavailable gbrain, reconnect after crash. Mock the child process and MCP client in tests.
- **Blockers:** None (independent of Task 1.1/1.2 but logically grouped)

#### Task 1.4: Tests for Phase 1
- **Change:** Create `tests/gbrain-client.test.ts` with tests for:
  - gbrain client connect/disconnect lifecycle (mocked child process)
  - callTool returns gbrain response
  - callTool returns error when not connected
  - Reconnect on stale connection
  - Create `tests/gbrain-config.test.ts` with tests for:
  - register_member with gbrain field
  - update_member toggling gbrain
  - list_members showing gbrain status
- **Files:** `tests/gbrain-client.test.ts` (new), `tests/gbrain-config.test.ts` (new)
- **Tier:** premium
- **Done when:** All new tests pass. `npm test` passes.
- **Blockers:** Tasks 1.1, 1.2, 1.3

#### VERIFY: Phase 1 — gbrain client service + config
- `npm run build` succeeds
- `npm test` passes (all existing + new tests)
- TypeScript compiles with no errors
- A member registered with `gbrain: true` shows the field in `list_members` and `member_detail`
- gbrain client service can be instantiated and connect/disconnect (mocked in tests)

---

### Phase 2: Brain Query and Write Tools

> Core knowledge layer: fleet tools that proxy gbrain's brain-query and brain-write capabilities. These are the primary value — persistent knowledge across sessions.

#### Task 2.0: Create shared gbrain helpers
- **Change:** Create `src/utils/gbrain-helpers.ts` with shared utilities used by all gbrain tools in Phases 2-5:
  - `assertGbrainEnabled(agent: Agent): string | null` — returns error string if gbrain not enabled on agent, null if OK
  - `callGbrainTool(toolName: string, args: Record<string, unknown>): Promise<string>` — wraps `gbrainClient.callTool` with standard error handling (gbrain not available, connection errors, etc.)
- **Files:** `src/utils/gbrain-helpers.ts` (new)
- **Tier:** cheap
- **Done when:** Both helpers exported. TypeScript compiles. Unit tests verify assertGbrainEnabled returns error for non-gbrain agent and null for gbrain agent. callGbrainTool wraps errors correctly.
- **Blockers:** Task 1.3

#### Task 2.1: Create `brain_query` fleet tool
- **Change:** Create `src/tools/brain-query.ts`:
  - Schema: `memberIdentifier` (to verify gbrain is enabled on member) + `query: string` (the question to ask the brain) + `collection?: string` (optional brain collection/namespace)
  - Handler: resolve member, check `agent.gbrain === true`, call `gbrainClient.callTool('brain_query', { query, collection })`, return result
  - Error if member doesn't have gbrain enabled: "gbrain is not enabled on this member. Use update_member to enable it."
  - Error if gbrain not running: "gbrain server is not available. Ensure it is running — see docs."
  - Register in `src/index.ts`
- **Files:** `src/tools/brain-query.ts` (new), `src/index.ts`
- **Tier:** standard
- **Done when:** Tool registered, callable via MCP. Returns brain query results for gbrain-enabled member. Returns clear error for non-gbrain member.
- **Blockers:** Phase 1

#### Task 2.2: Create `brain_write` fleet tool
- **Change:** Create `src/tools/brain-write.ts`:
  - Schema: `memberIdentifier` + `content: string` (knowledge to store) + `collection?: string` + `metadata?: string` (optional JSON metadata)
  - Handler: resolve member, check `agent.gbrain === true`, call `gbrainClient.callTool('brain_write', { content, collection, metadata })`, return confirmation
  - Same error handling as brain_query
  - Register in `src/index.ts`
- **Files:** `src/tools/brain-write.ts` (new), `src/index.ts`
- **Tier:** standard
- **Done when:** Tool registered, callable via MCP. Writes to brain for gbrain-enabled member. Returns clear error for non-gbrain member.
- **Blockers:** Phase 1

#### Task 2.3: Tests for brain query/write tools
- **Change:** Create `tests/brain-tools.test.ts`:
  - brain_query with gbrain-enabled member returns result
  - brain_query with non-gbrain member returns error
  - brain_query with gbrain unavailable returns error
  - brain_write with gbrain-enabled member returns confirmation
  - brain_write with non-gbrain member returns error
  - Mock gbrainClient.callTool for all tests
- **Files:** `tests/brain-tools.test.ts` (new)
- **Tier:** standard
- **Done when:** All tests pass. `npm test` passes.
- **Blockers:** Tasks 2.1, 2.2

#### VERIFY: Phase 2 — Brain query/write tools
- `npm run build` succeeds
- `npm test` passes
- brain_query and brain_write tools appear in MCP tool list
- Tools enforce gbrain opt-in (error for non-gbrain members)

---

### Phase 3: Code Analysis Tools

> Symbol-level code analysis for reviewer workflows. Four tools wrapping gbrain's code analysis: callers, callees, definition, references.

#### Task 3.1: Create code analysis fleet tools
- **Change:** Create `src/tools/code-analysis.ts` — a single file with four tools sharing common patterns:
  - `codeCallersSchema` / `codeCallers`: Find all callers of a symbol. Schema: `memberIdentifier` + `symbol: string` + `file_path?: string` + `repo?: string`
  - `codeCalleesSchema` / `codeCallees`: Find all callees from a symbol. Same schema pattern.
  - `codeDefSchema` / `codeDef`: Find definition of a symbol. Same schema pattern.
  - `codeRefsSchema` / `codeRefs`: Find all references to a symbol. Same schema pattern.
  - All four: resolve member → check `agent.gbrain === true` → call `gbrainClient.callTool('code_callers'|'code_callees'|'code_def'|'code_refs', args)` → return result
  - Use shared helpers from Task 2.0: `assertGbrainEnabled(agent)` for opt-in check, `callGbrainTool()` for proxying
  - Register all four in `src/index.ts`
- **Files:** `src/tools/code-analysis.ts` (new), `src/index.ts`
- **Tier:** standard
- **Done when:** Four tools registered. Each callable via MCP. Each enforces gbrain opt-in. Each proxies to correct gbrain tool.
- **Blockers:** Phase 1

#### Task 3.2: Tests for code analysis tools
- **Change:** Create `tests/code-analysis.test.ts`:
  - Each of the four tools: enabled member returns result, non-gbrain member returns error
  - Verify correct gbrain tool name is called for each fleet tool
  - Mock gbrainClient.callTool
- **Files:** `tests/code-analysis.test.ts` (new)
- **Tier:** standard
- **Done when:** All tests pass. `npm test` passes.
- **Blockers:** Task 3.1

#### VERIFY: Phase 3 — Code analysis tools
- `npm run build` succeeds
- `npm test` passes
- code_callers, code_callees, code_def, code_refs tools appear in MCP tool list

---

### Phase 4: Minions Job Queue Integration

> Durable background work dispatch via gbrain's Minions. Postgres-backed crash recovery, stall detection, cascade cancel. Alternative to execute_prompt for deterministic work.

#### Task 4.1: Create Minions job queue tools
- **Change:** Create `src/tools/minions.ts` with four tools wrapping gbrain's Minions job queue:
  - `jobsSubmitSchema` / `jobsSubmit`: Submit a job to Minions queue
    - Schema: `memberIdentifier` + `job_type: string` + `payload: string` (JSON) + `priority?: number` (0-4, default 2) + `depends_on?: string[]` (job IDs for dependency chain)
    - Handler: resolve member → check `agent.gbrain === true` → call `gbrainClient.callTool('jobs_submit', { job_type, payload, priority, depends_on })` → return job ID and status
    - If gbrain not available or member not gbrain-enabled, return error suggesting execute_prompt as fallback
  - `jobsListSchema` / `jobsList`: List jobs in the queue
    - Schema: `memberIdentifier` + `status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'` + `limit?: number`
    - Handler: resolve member → check gbrain → call `gbrainClient.callTool('jobs_list', { status, limit })` → return job list
  - `jobsStatsSchema` / `jobsStats`: Get aggregate job queue statistics
    - Schema: `memberIdentifier`
    - Handler: resolve member → check gbrain → call `gbrainClient.callTool('jobs_stats', {})` → return queue stats (counts by status, avg duration, etc.)
  - `jobsWorkSchema` / `jobsWork`: Claim and execute the next available job
    - Schema: `memberIdentifier` + `job_type?: string` (optional filter)
    - Handler: resolve member → check gbrain → call `gbrainClient.callTool('jobs_work', { job_type })` → return claimed job details
  - Register all four in `src/index.ts`
- **Files:** `src/tools/minions.ts` (new), `src/index.ts`
- **Tier:** standard
- **Done when:** All four tools registered. Submit returns job ID. List returns filtered jobs. Stats returns queue metrics. Work claims next job. Error messages guide user when gbrain unavailable.
- **Blockers:** Phase 1

#### Task 4.2: Tests for Minions tools
- **Change:** Create `tests/minions.test.ts`:
  - jobs_submit on gbrain-enabled member returns job ID
  - jobs_submit on non-gbrain member returns error with fallback suggestion
  - jobs_list returns filtered job list
  - jobs_stats returns queue metrics
  - jobs_work claims next available job
  - jobs_submit with depends_on passes dependency chain
  - Mock gbrainClient.callTool
- **Files:** `tests/minions.test.ts` (new)
- **Tier:** standard
- **Done when:** All tests pass. `npm test` passes.
- **Blockers:** Task 4.1

#### VERIFY: Phase 4 — Minions integration
- `npm run build` succeeds
- `npm test` passes
- jobs_submit, jobs_list, jobs_stats, jobs_work tools appear in MCP tool list
- Routing guidance documented: deterministic work → Minions, judgment work → execute_prompt

---

### Phase 5: Reviewer Template + Course Correction Capture

> Two complementary features: (1) reviewers can query brain before approving, (2) user corrections during sprints are automatically captured to brain for future recall.

#### Task 5.1: Update reviewer template with conditional brain instructions
- **Change:** Update `skills/pm/tpl-reviewer.md` to add a conditional section for brain-aware reviews:
  - Add a new section between "Context Recovery" and "Review Model": `## Brain-Aware Review (gbrain enabled)` with instructions:
    - "Before reviewing each changed file, query brain: what do we know about this module/symbol?"
    - "Use code_callers and code_refs to assess blast radius of changes"
    - "Check brain for past corrections related to the changed areas"
  - Section is wrapped in a clearly marked optional block: `<!-- OPTIONAL: gbrain -->` / `<!-- /OPTIONAL: gbrain -->`. At template render time, PM includes the block when the member has `gbrain: true`, and strips it otherwise. This uses the same simple `{{PLACEHOLDER}}` token model the PM skill already supports — no Handlebars conditionals.
  - Also update the "What to check" section to add: "If gbrain enabled: check brain for known issues with changed symbols"
- **Files:** `skills/pm/tpl-reviewer.md`, `src/services/template-renderer.ts` (add optional-section stripping logic)
- **Tier:** standard
- **Done when:** Template includes brain instructions. Instructions are conditional on gbrain being enabled. Existing review flow unchanged when gbrain is not enabled.
- **Blockers:** None (template change, no code dependency)

#### Task 5.2: Create course correction capture service
- **Change:** Create `src/services/course-correction.ts`:
  - `captureCorrection(context: { repo?: string, member?: string, attempted: string, correction: string, reason?: string }): Promise<void>` — writes correction to brain via gbrainClient
  - Formats as structured knowledge: "On repo X, approach Y was attempted. User corrected to Z because: reason"
  - `recallCorrections(context: { repo?: string, query: string }): Promise<string>` — queries brain for past corrections relevant to current context
  - Both are no-ops if gbrain is not available (fail silently — corrections are best-effort)
- **Files:** `src/services/course-correction.ts` (new)
- **Tier:** standard
- **Done when:** captureCorrection writes to brain. recallCorrections queries brain. Both gracefully no-op when gbrain unavailable.
- **Blockers:** Phase 1 (gbrain client)

#### Task 5.3: Create `course_correction` fleet tool
- **Change:** Create `src/tools/course-correction.ts`:
  - `courseCorrectionCaptureSchema` / `courseCorrectionCapture`: Capture a user correction
    - Schema: `attempted: string` + `correction: string` + `reason?: string` + `repo?: string` + `member_name?: string`
    - Handler: call `captureCorrection()` from service
  - `courseCorrectionRecallSchema` / `courseCorrectionRecall`: Recall past corrections
    - Schema: `query: string` + `repo?: string`
    - Handler: call `recallCorrections()` from service
  - Register both in `src/index.ts`
- **Files:** `src/tools/course-correction.ts` (new), `src/index.ts`
- **Tier:** standard
- **Done when:** Both tools registered. Capture writes correction to brain. Recall returns relevant past corrections. Tools work without member resolution (corrections are fleet-level, not member-specific).
- **Blockers:** Task 5.2

#### Task 5.4: Wire course_correction_capture into PM sprint execution flow
- **Change:** Update sprint templates and/or `execute_prompt` to invoke `course_correction_capture` when a user correction is detected during sprint execution:
  - **Option A (template-based):** Add explicit `course_correction_capture` call-sites in `skills/pm/single-pair-sprint.md` and `skills/pm/doer-reviewer.md` at the post-iteration review step. After each doer iteration, if the reviewer or user has issued a correction, the template instructs PM to call `course_correction_capture` with the attempted approach and the correction.
  - **Option B (middleware-based):** Add a lightweight hook in `src/tools/execute-prompt.ts` that pattern-matches user responses for correction signals (e.g. "no, instead…", "don't do X", "wrong approach") and automatically calls `captureCorrection()` from the course-correction service. This is transparent to the template.
  - Choose Option A for explicitness and auditability. Add a clearly marked section in each sprint template: `<!-- OPTIONAL: gbrain -->` block with course correction capture instructions at the post-iteration checkpoint.
- **Files:** `skills/pm/single-pair-sprint.md`, `skills/pm/doer-reviewer.md`
- **Tier:** standard
- **Done when:** Sprint templates include course_correction_capture call-sites. Corrections made during gbrain-enabled sprints are persisted to brain. Non-gbrain sprints are unaffected.
- **Blockers:** Tasks 5.2, 5.3

#### Task 5.5: Tests for Phase 5
- **Change:** Create `tests/course-correction.test.ts`:
  - captureCorrection writes to brain with correct format
  - captureCorrection no-ops when gbrain unavailable
  - recallCorrections returns brain results
  - recallCorrections returns empty when gbrain unavailable
  - Fleet tools route to service correctly
- **Files:** `tests/course-correction.test.ts` (new)
- **Tier:** standard
- **Done when:** All tests pass. `npm test` passes.
- **Blockers:** Tasks 5.2, 5.3

#### VERIFY: Phase 5 — Reviewer template + course correction
- `npm run build` succeeds
- `npm test` passes
- Reviewer template includes conditional brain instructions
- course_correction_capture and course_correction_recall tools appear in MCP tool list
- Corrections are captured and recallable through brain

---

### Phase 6: Documentation + Integration Validation

> Documentation, integration wiring, and final validation that all pieces work together without breaking existing workflows.

#### Task 6.1: DRY audit of gbrain helpers
- **Change:** Audit all gbrain tools created in Phases 2-5 to verify they consistently use the shared helpers from `src/utils/gbrain-helpers.ts` (created in Task 2.0). Fix any tools that inline their own gbrain-enabled checks or error handling instead of using `assertGbrainEnabled` / `callGbrainTool`. No new files — helpers already exist.
- **Files:** `src/tools/brain-query.ts`, `src/tools/brain-write.ts`, `src/tools/code-analysis.ts`, `src/tools/minions.ts`, `src/tools/course-correction.ts`
- **Tier:** cheap
- **Done when:** All gbrain tools use shared helpers from `src/utils/gbrain-helpers.ts`. No duplicated error handling. All tests still pass.
- **Blockers:** Phases 2-5

#### Task 6.2: Wire gbrain client lifecycle into server startup/shutdown
- **Change:** In `src/index.ts`:
  - Import gbrain client service
  - On SIGINT/SIGTERM: call `gbrainClient.disconnect()` before process exit
  - Register all gbrain tools (brain_query, brain_write, code_callers, code_callees, code_def, code_refs, jobs_submit, jobs_list, jobs_stats, jobs_work, course_correction_capture, course_correction_recall) — verify all are present
  - Lazy initialization: gbrain client connects on first tool call, not on server startup (so fleet starts fast even without gbrain)
- **Files:** `src/index.ts`
- **Tier:** standard
- **Done when:** All gbrain tools registered in server. Graceful shutdown disconnects gbrain. Fleet starts normally without gbrain running.
- **Blockers:** Task 6.1

#### Task 6.3: Documentation
- **Change:** Add gbrain section to `README.md`:
  - Installation: how to install/run gbrain alongside fleet
  - Configuration: `GBRAIN_COMMAND` env var, per-member `gbrain: true` opt-in
  - Available tools: brain_query, brain_write, code_callers, code_callees, code_def, code_refs, jobs_submit, jobs_list, jobs_stats, jobs_work, course_correction_capture, course_correction_recall
  - Routing guidance: when to use Minions vs execute_prompt
  - PGLite vs Postgres: what each supports
  - Reviewer workflow: how brain-aware reviews work
- **Files:** `README.md`
- **Tier:** standard
- **Done when:** README covers all gbrain features. Install instructions are accurate. Tool descriptions match implementations.
- **Blockers:** Task 6.2

#### Task 6.4: Final integration tests
- **Change:** Create `tests/gbrain-integration.test.ts`:
  - Verify all 12 gbrain tools are registered on server (mock server)
  - Verify fleet starts without gbrain (no crash, tools return appropriate errors)
  - Verify existing tools (execute_prompt, list_members, etc.) work unchanged
  - Verify agent with gbrain: true serializes/deserializes correctly in registry
  - Token overhead estimation: measure added schema size vs existing (must be < 1% overhead assertion)
- **Files:** `tests/gbrain-integration.test.ts` (new)
- **Tier:** standard
- **Done when:** All integration tests pass. `npm test` passes. `npm run build` succeeds. No regressions in existing functionality.
- **Blockers:** Tasks 6.1, 6.2

#### VERIFY: Phase 6 — Documentation + integration
- `npm run build` succeeds
- `npm test` passes (all tests, including new integration tests)
- README has gbrain documentation
- Fleet starts cleanly without gbrain running
- All 12 gbrain tools registered
- Existing fleet workflows unchanged
- Token overhead < 1% validated

---

## Risk Register

| Risk | Impact | Mitigation |
|---|---|---|
| gbrain MCP protocol version mismatch | Connection fails | Validate on connect; pin SDK version; document compatible gbrain versions |
| gbrain process not running | All gbrain tools return errors | Lazy connect + clear error messages guiding user to start gbrain |
| Minions requires Postgres (PGLite insufficient) | Minions dispatch fails | Document requirement; minions tools check availability before accepting jobs |
| gbrain tool names change between versions | Fleet tools call wrong tool names | Pin known tool names; validate available tools on connect; version check |
| Token overhead from 12 new tool schemas | Exceeds 1% budget | Measure schema token count vs existing; gbrain tools use compact descriptions |
| Child process management on Windows | Spawn/kill semantics differ | Use Node.js child_process with `shell: true` on Windows; test on Windows |
| Course correction capture adds latency | Slows sprint execution | Capture is fire-and-forget (no await on brain write in hot path) |

## Notes

- **gbrain tool name mapping**: Fleet tool names match gbrain's canonical underscore names: `brain_query`, `brain_write`, `code_callers`, `code_callees`, `code_def`, `code_refs`, `jobs_submit`, `jobs_list`, `jobs_stats`, `jobs_work`. No name translation needed — fleet passes tool names through directly.
- **No fleet config file change**: gbrain server settings use environment variables (`GBRAIN_COMMAND`, `GBRAIN_ARGS`) rather than adding a new config file. Per-member opt-in uses the existing `Agent` interface field.
- **PM gets gbrain for free**: PM accesses gbrain through fleet tools (brain_query, brain_write, etc.) — no separate gbrain MCP config needed on PM. This is the existing fleet architecture: PM calls fleet tools, fleet tools call gbrain.
- **Reviewer template uses optional sections**: `<!-- OPTIONAL: gbrain -->...<!-- /OPTIONAL: gbrain -->` markers delineate brain-aware review instructions. The PM template renderer strips these sections when `gbrain` is not enabled for the member. This avoids Handlebars-style `{{#if}}` conditionals — the PM skill only supports simple `{{PLACEHOLDER}}` token substitution.
- **Existing workflows unchanged**: All changes are additive. No existing tool schemas, handlers, or behaviors are modified. The only existing file modifications are: `src/types.ts` (add optional field), `src/index.ts` (add imports and registrations), tool schemas for register/update/list/detail (add optional field), `skills/pm/tpl-reviewer.md` (add conditional section), `README.md` (add section).
