# apra-fleet -- Code Intelligence Hardening Sprint Plan

Sprint epic: yashr-43h. Branch: `feat/code-intelligence-abstraction` (base: `main`).
Source of truth: `requirements.md` (design decisions inline; no design.md).

> Harden the code intelligence pipeline against three audited weaknesses:
> Fix 3 -- silent-empty failure mode (Phase 1, riskiest first),
> Fix 2 -- mid-sprint index staleness (Phase 2),
> Fix 1 -- prompt-dependence of tool routing (Phase 3).

## Planning context

- KB was cold at planning time (kb_session_prime returned zero top_entries; kb_query
  found nothing for gitnexus/client/fleet_status). All symbols in this plan are
  unexplored territory for the KB, so model assignments lean stronger where the
  work is non-mechanical.
- The gitnexus index itself was stale during planning (getGitNexusClient not found
  by code_context) -- a live demonstration of the Fix 2/Fix 3 problem. Facts below
  come from direct source reads and are anchored to current line numbers.
- Verified codebase facts every doer must know:
  - `src/tools/code-intelligence-gitnexus.ts` (53 lines): module-level
    `let sharedClient: Client | null` and `let connectionPromise: Promise<Client> | null`
    (lines 5-6); `getGitNexusClient()` (lines 8-30) spawns `npx -y gitnexus mcp`
    over `StdioClientTransport` with `stderr: 'pipe'`. `GitNexusProvider` methods
    `graph/impact/query/context` map to child tools `call_graph/impact/query/context`.
  - `src/tools/code-intelligence.ts`: zod schemas (`codeGraphSchema`,
    `codeImpactSchema`, `codeQuerySchema`, `codeContextSchema`) all carry an
    OPTIONAL `repo` param; `getProvider()` reads
    `~/.apra-fleet/data/code-intelligence/config.json`, defaults to gitnexus.
  - Tool registration: `src/index.ts` lines 310-325 (code_* tools, descriptions are
    the second argument to `server.tool(...)`); `fleet_status` registered at
    line 286, implemented by `fleetStatus()` in `src/tools/check-status.ts`
    (line 194), which supports `format: 'compact' | 'json'`.
  - Existing test `tests/code-intelligence.test.ts` mocks the MCP SDK via
    `vi.hoisted` + `vi.mock('@modelcontextprotocol/sdk/client/index.js')` and
    `vi.mock('@modelcontextprotocol/sdk/client/stdio.js')`. Because
    `sharedClient`/`connectionPromise` are module-level singletons, tests that
    exercise reset/reconnect behavior MUST use `vi.resetModules()` + dynamic
    `await import(...)` per test (or an exported test-only reset hook) so each
    test starts with a cold module.
  - `package.json` has NO lint script. VERIFY checkpoints run `npm run build`
    (tsc) and `npm test` (vitest run) only.

## Repo rules (apply to every task)

- ASCII only in all files: `-` for dashes, `->` for arrows, `[OK]` for checkmarks.
- Never push to `main`. All work stays on `feat/code-intelligence-abstraction`.
- No PR this sprint -- the user raises PRs explicitly. Push the branch only.
- Commit style: `<type>(<scope>): <description>`.

## Model assignment rules used

- `claude-haiku-4-5` -- mechanical edits with exact text given in this plan.
- `claude-sonnet-4-6` -- typical implementation with clear specs and test patterns.
- `claude-opus-4-8` -- hard design / async lifecycle / multi-file reasoning.

---

## Phase 1 -- Fix 3: silent-empty failure mode (riskiest first)

### T1.1 -- Connection resilience for the shared GitNexus client (F3.2)

- **Model:** claude-opus-4-8
- **Why opus:** requirements.md names F3.2 the riskiest work in the sprint (async
  lifecycle of a shared MCP client); KB has zero prior coverage of these symbols.
- **Files:** `src/tools/code-intelligence-gitnexus.ts`,
  `tests/code-intelligence.test.ts` (extend; add new describe blocks or a sibling
  test file `tests/code-intelligence-resilience.test.ts` if isolation demands it).
- **What to build:** Fix the two caching bugs in `getGitNexusClient()` and make
  dead-client failures actionable:
  1. Failure reset: if the `connectionPromise` rejects, clear `connectionPromise`
     (and leave `sharedClient` null) before the rejection propagates, so the NEXT
     call retries a fresh connection instead of awaiting the poisoned promise
     forever. Implement inside the async IIFE with try/catch (rethrow after
     clearing) or via `.catch` bookkeeping -- the observable contract is: call 1
     fails, call 2 attempts a brand-new connection.
  2. Transport death reset: after a successful connect, register close/error
     handlers (the MCP SDK exposes `transport.onclose` / `transport.onerror`, and
     `Client` has an `onclose` hook -- use whichever the installed SDK version
     provides; verify against `node_modules/@modelcontextprotocol/sdk`) that set
     `sharedClient = null` and `connectionPromise = null`, so the call after a
     child-process death reconnects instead of failing opaquely.
  3. Guarded callTool: wrap every `client.callTool(...)` in the four
     `GitNexusProvider` methods (extract one private helper, e.g.
     `callGitNexus(name, params)`, so the logic lives in ONE place) so that a
     thrown dead-client/connection error is caught and returned as a structured
     actionable error in the SAME shape as F3.1 (T1.2) -- a normal tool result
     whose text tells the agent code intelligence is offline and how to recover
     (mention starting/reinstalling gitnexus via `npx gitnexus analyze` /
     `/pm index`). Never an unhandled throw, never a silent empty result. After a
     caught dead-client error the module state must be reset so the next call
     reconnects.
- **Edge cases:** two concurrent first calls share one connection attempt (keep
  the single-flight `connectionPromise` semantics); a failure reset must not race
  a concurrent waiter into a null deref; handlers must not fire the reset for a
  client that was already replaced.
- **Tests (required by sprint done criteria):** using the existing
  `vi.hoisted`/`vi.mock` pattern plus `vi.resetModules()` + dynamic import per
  test: (a) `connect` rejects once -> first provider call errors with the
  actionable message shape, second call triggers a second `connect` attempt and
  succeeds; (b) after a successful call, simulating transport close then calling
  again creates a new client; (c) `callTool` throwing yields the structured error
  message, not a throw.
- **Done criteria:** `npm run build` clean; new tests green alongside all 4
  existing GitNexusProvider tests and 3 getProvider tests; no call path can
  return a silent empty on connection failure; ASCII only; committed as
  `fix(code-intelligence): reset shared client on connection failure` (or
  similar `fix(code-intelligence): ...`).

### T1.2 -- Pre-flight index check with actionable missing-index error (F3.1)

- **Model:** claude-sonnet-4-6
- **Files:** `src/tools/code-intelligence-gitnexus.ts` (or a small helper in
  `src/tools/code-intelligence.ts` if cleaner -- keep provider-agnostic logic out
  of the gitnexus file only if it stays one concern), plus tests.
- **What to build:** Before proxying any provider call whose `params` carry a
  `repo` value (all four schemas have optional `repo`): check
  `<repo>/.gitnexus/meta.json` exists with `fs.existsSync` (cheap, synchronous --
  requirement says existsSync explicitly). If absent, return the structured error
  WITHOUT forwarding the call to the child process, message verbatim from
  requirements.md:
  `"No code intelligence index found for <repo>. Run 'npx gitnexus analyze' in the repo (or /pm index) and retry."`
  (substitute the actual repo path for `<repo>`).
- **Edge cases (from requirements):** calls WITHOUT a `repo` param must be
  forwarded untouched -- the check only runs when `repo` is present and is a
  non-empty string. A `repo` pointing at a nonexistent directory also yields the
  missing-index error (existsSync covers it). The check must run before
  `getGitNexusClient()` is awaited so a missing index never spawns the child.
- **Tests (required by sprint done criteria):** create a temp dir WITHOUT
  `.gitnexus/` (use `fs.mkdtempSync(join(tmpdir(), ...))`), call each provider
  method with `repo` set to it, assert the exact error text and that
  `mockCallTool`/`mockConnect` were NOT called; plus one test that a call without
  `repo` still forwards to `callTool`.
- **Done criteria:** build clean, tests green, message matches requirements
  verbatim, no child spawn on missing index, ASCII only, committed.

### T1.3 -- Code intelligence health section in fleet_status (F3.3)

- **Model:** claude-sonnet-4-6
- **Files:** `src/tools/check-status.ts` (implementation `fleetStatus()` at
  line 194; add a small helper, e.g. `codeIntelligenceHealth(cwd)`), optional new
  test file `tests/fleet-status-code-intelligence.test.ts`.
- **What to build:** Add a code intelligence section to `fleet_status` output for
  the current working repo: if `process.cwd()` contains `.gitnexus/meta.json`,
  read it (`lastCommit`, `indexedAt`, `stats` with files/nodes/edges -- this is
  the documented meta.json shape) and report:
  - index present yes/no
  - nodes / edges / files from `stats`
  - `indexedAt`
  - `lastCommit` vs current git HEAD: "matching" or "N commits behind" (get HEAD
    via `git rev-parse HEAD`, count via `git rev-list --count <lastCommit>..HEAD`;
    both against `process.cwd()`).
  Surface it in BOTH formats: a `codeIntelligence` key in the `json` payload and
  one extra line in `compact` output (e.g.
  `code-intel: index present | 1234 nodes / 5678 edges / 90 files | indexed <indexedAt> | matching HEAD`).
  If no index: `code-intel: no index (run 'npx gitnexus analyze' or /pm index)`.
- **Edge cases:** MUST be read-only and fast -- no child MCP spawn, no network;
  degrade gracefully (never throw, never fail fleet_status) when: meta.json is
  missing or unparseable, git is unavailable, `lastCommit` is unknown to the
  local git (rev-list fails -> report `indexed <lastCommit:8>, HEAD comparison
  unavailable`). Wrap git calls in try/catch with a short timeout.
- **Tests:** unit-test the helper with a temp dir: (a) no .gitnexus -> absent
  report; (b) meta.json present + mocked/undefined git -> graceful degradation;
  (c) parse of stats fields.
- **Done criteria:** `fleet_status` shows the section in compact and json formats,
  never throws when git/meta.json unavailable, build + tests green, ASCII only,
  committed.

### T1.4 -- VERIFY Phase 1

- **Type:** verify (no model)
- Run `npm run build` (tsc must be clean). Lint: not configured in package.json --
  skip and note in progress.json. Run `npm test` (vitest, full suite green,
  including the new F3.1 and F3.2 tests).
- Run `npx gitnexus analyze` after tests pass (non-fatal if it errors).
- Push the branch: `git push origin feat/code-intelligence-abstraction`.
  Never push to main. Do NOT open a PR.

---

## Phase 2 -- Fix 2: mid-sprint staleness

### T2.1 -- Freshness metadata in tool responses (F2.2)

- **Model:** claude-sonnet-4-6
- **Files:** `src/tools/code-intelligence-gitnexus.ts` (append logic), a pure
  function (exported for tests -- put it in `src/tools/code-intelligence.ts` or a
  small `src/tools/code-intelligence-freshness.ts`), tests.
- **What to build:**
  1. Pure function (unit-testable, no IO), e.g.
     `freshnessNote(lastCommit: string | undefined, head: string | undefined): string | null`
     returning `null` when either side is missing or they match, else the note
     verbatim from requirements.md:
     `"[code-intelligence] index is behind repo HEAD (indexed <lastCommit:8> vs HEAD <head:8>). Results may miss recent changes; run 'npx gitnexus analyze' to refresh."`
     where `<lastCommit:8>`/`<head:8>` are the first 8 chars of each SHA.
  2. Wiring: when a provider call carries `repo` AND `<repo>/.gitnexus/meta.json`
     exists (this runs naturally after T1.2's pre-flight passes), read
     `meta.json.lastCommit`, get `git rev-parse HEAD` for that repo, and when they
     differ APPEND the note to the tool response text. Do NOT block or fail the
     call: any error reading meta.json or running git means "no note", never a
     thrown error. Preserve the response shape (MCP content array from the child)
     -- append the note as additional text content or suffix the text block;
     keep it consistent across all four methods (do it in the shared
     `callGitNexus` helper from T1.1).
- **Edge cases:** no `repo` param -> no note; git missing -> no note; identical
  SHAs -> no note; note appended at most once per response.
- **Tests (required by sprint done criteria):** pure-function cases: match ->
  null, differ -> exact string with 8-char truncation, undefined either side ->
  null, short SHAs (< 8 chars) do not crash. Plus one wiring test asserting the
  note lands in the response when meta lastCommit differs from a stubbed HEAD.
- **Done criteria:** pure function exported and covered by unit tests; note text
  matches requirements verbatim; a failing git/meta read never fails the call;
  build + tests green; ASCII only; committed.

### T2.2 -- Re-index at VERIFY checkpoints in PM skill docs (F2.1)

- **Model:** claude-haiku-4-5
- **Files:** `skills/pm/doer-reviewer-loop.md`, `skills/pm/index.md`.
- **What to build (docs-only, mechanical):**
  1. In `doer-reviewer-loop.md`, doer template (the block starting
     "You are executing a plan.", currently lines 160-180): extend the VERIFY
     checkpoint sentence ("run it -- build, linter, and full test suite") so the
     sequence is: build, linter, full test suite, then `npx gitnexus analyze`
     (after all pass, BEFORE pushing). State explicitly that the analyze step is
     non-fatal: an analyze failure must not fail the VERIFY -- record it in
     progress.json and continue.
  2. In `skills/pm/index.md`, "When to run" section: add a bullet that VERIFY
     checkpoints re-run `npx gitnexus analyze` automatically (incremental via
     fileHashes in `.gitnexus/meta.json`, takes seconds), so mid-sprint symbols
     stay visible to later phases.
- **Edge cases:** touch ONLY these two files; do not reflow unrelated template
  text; keep line width consistent with surrounding prose; ASCII only.
- **Done criteria:** both files updated, wording states non-fatal explicitly,
  `git diff` shows changes confined to the two files, committed as
  `docs(pm): re-index at VERIFY checkpoints`.

### T2.3 -- VERIFY Phase 2

- **Type:** verify (no model)
- Run `npm run build`; lint not configured -- skip and note. Run `npm test`
  (full suite green including F2.2 pure-function tests).
- Run `npx gitnexus analyze` after tests pass (non-fatal).
- Push the branch: `git push origin feat/code-intelligence-abstraction`.
  Never push to main. Do NOT open a PR.

---

## Phase 3 -- Fix 1: prompt-dependence of tool routing

### T3.1 -- Routing guidance in the four tool descriptions (F1.1)

- **Model:** claude-haiku-4-5
- **Files:** `src/index.ts` (registrations, lines 310-325 -- the description
  string is the second argument to each `server.tool(...)` call). Check
  `src/tools/code-intelligence.ts` too: its schemas describe params, not tools;
  only change it if a tool-level description string actually lives there
  (currently it does not -- src/index.ts is the single registration point).
- **What to build (mechanical, exact text):** append one sentence to each of the
  four descriptions (code_graph, code_impact, code_query, code_context):
  `Prefer this over Glob/Grep/file reads for structural questions (symbol lookup, call chains, impact) -- the answer is pre-indexed.`
- **Edge cases:** keep each description a single string on its existing line
  style; do not alter schemas, handler bodies, or other tools' descriptions;
  ASCII only (use `--`, never an em dash).
- **Done criteria:** all four descriptions carry the sentence; `npm run build`
  clean; diff touches only description strings; committed as
  `feat(code-intelligence): routing guidance in tool descriptions`.

### T3.2 -- Code intelligence + KB paragraph in reviewer dispatch template (F1.2)

- **Model:** claude-haiku-4-5
- **Files:** `skills/pm/doer-reviewer-loop.md` -- reviewer template only (the
  block starting "You are reviewing code.", currently lines 184-194). Verified
  during planning: the planner and doer templates in this file already carry
  KB/code-intelligence paragraphs; the reviewer template has none.
- **What to build:** add a paragraph in the same style as the doer template's
  (lines 174-179), adapted to review work:
  - `kb_session_prime` at session start with hint_symbols/hint_modules derived
    from the diff under review;
  - `code_impact` for "who else calls this changed method" questions;
  - `kb_query` before reading an unfamiliar file -- trust CONFIRMED/INFERRED
    entries and skip the source read;
  - never Glob/Grep for structural queries when code intelligence tools are
    available.
- **Edge cases:** do not modify the planner/doer/plan-reviewer templates; keep
  the template's inline-prompt formatting (it is a fenced block); ASCII only.
- **Done criteria:** reviewer template carries the paragraph, other templates
  byte-identical, committed as `docs(pm): code intelligence instructions in
  reviewer dispatch template`.

### T3.3 -- Fill CI gap in tpl-planner.md; confirm fleet-mode templates (F1.3)

- **Model:** claude-haiku-4-5 (stays haiku because the exact paragraph to insert
  is given verbatim below -- no drafting judgment required).
- **Files:** `skills/pm/tpl-planner.md` (edit -- gap confirmed),
  `skills/pm/tpl-doer.md`, `skills/pm/tpl-reviewer.md` (read-and-confirm).
- **Verified reality (plan review, 2026-07-06):** each template must contain
  BOTH: (a) a kb_session_prime instruction, and (b) code intelligence tool
  guidance (code_graph/code_impact/code_query/code_context, prefer over
  Glob/Grep). tpl-doer.md (lines 47, 57) and tpl-reviewer.md (lines 76-79) carry
  both elements. tpl-planner.md carries ONLY the kb_session_prime instruction
  (line 8) and has NO code intelligence tool guidance -- grep for
  `code_graph|code_impact|code_query|code_context|code intelligence|Glob/Grep`
  returns zero hits in that file. A gap exists and must be fixed.
- **What to do:**
  1. In `skills/pm/tpl-planner.md`, insert the following section verbatim after
     the "Knowledge Bank" section (i.e. after the line "If the KB is empty
     (first sprint on this repo), skip and proceed normally.", currently
     line 21) and before the "## Planning Model" heading:

     ```
     ## Code Intelligence (use while planning)

     For symbol lookups, call chain tracing, and impact analysis while planning,
     use the fleet code intelligence tools (code_graph, code_impact, code_query,
     code_context) -- e.g. code_query to locate an implementation you are about
     to write tasks against, code_context to see its callers and flows. Never
     use Glob/Grep or file reads for structural questions -- the answer is
     pre-indexed.
     ```

     Keep a blank line above and below the new section; do not alter any other
     part of the file.
  2. Read `tpl-doer.md` and `tpl-reviewer.md` and confirm both elements are
     present in each; make no edits to them unless an element is genuinely
     missing (not expected). Record the confirmation (per file, what was found
     and where) plus the tpl-planner.md fix in progress.json notes for this task.
- **Done criteria:** tpl-planner.md contains the new section exactly as given
  (ASCII only); tpl-doer.md and tpl-reviewer.md are byte-identical unless a real
  gap was found; written confirmation per file in progress.json; committed as
  `docs(pm): fill code intelligence gaps in fleet-mode templates`.

### T3.4 -- VERIFY Phase 3 (sprint-final)

- **Type:** verify (no model)
- Run `npm run build`; lint not configured -- skip and note. Run `npm test`
  (full suite green: F3.1 missing-index, F3.2 connection reset, F2.2 freshness,
  plus all pre-existing tests).
- Sweep for the sprint-wide done criteria: ASCII only in every touched file
  (`git diff main...feat/code-intelligence-abstraction` contains no non-ASCII
  bytes).
- Run `npx gitnexus analyze` after tests pass (non-fatal).
- Push the branch: `git push origin feat/code-intelligence-abstraction`.
  Never push to main. Do NOT open a PR -- the user raises PRs explicitly.

---

## Task summary

| Task | Fix  | Concern                                   | Model             |
|------|------|-------------------------------------------|-------------------|
| T1.1 | F3.2 | Shared client connection resilience       | claude-opus-4-8   |
| T1.2 | F3.1 | Pre-flight index check + error            | claude-sonnet-4-6 |
| T1.3 | F3.3 | fleet_status health section               | claude-sonnet-4-6 |
| T1.4 | --   | VERIFY Phase 1                            | (verify, none)    |
| T2.1 | F2.2 | Freshness note + pure comparison fn       | claude-sonnet-4-6 |
| T2.2 | F2.1 | Re-index at VERIFY (PM skill docs)        | claude-haiku-4-5  |
| T2.3 | --   | VERIFY Phase 2                            | (verify, none)    |
| T3.1 | F1.1 | Tool description routing guidance         | claude-haiku-4-5  |
| T3.2 | F1.2 | Reviewer dispatch template paragraph      | claude-haiku-4-5  |
| T3.3 | F1.3 | Fill tpl-planner CI gap + confirm tpls    | claude-haiku-4-5  |
| T3.4 | --   | VERIFY Phase 3 + sprint done criteria     | (verify, none)    |
