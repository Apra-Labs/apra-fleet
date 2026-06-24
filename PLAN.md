# apra-fleet -- Implementation Plan

> Wrap code intelligence behind a fleet-owned abstraction. Fleet exposes four
> provider-agnostic tools (code_graph, code_impact, code_query, code_context).
> GitNexus is the first provider. Adding a new provider requires one interface
> implementation and one line in the provider map -- nothing else changes.

---

## Tasks

### Phase 1: Core abstraction + gitnexus provider

#### Task 1.1: Define CodeIntelligenceProvider interface
- **Change:** Create `src/tools/code-intelligence.ts` with:
  - `CodeIntelligenceProvider` interface (4 methods: graph, impact, query, context)
  - `PROVIDERS` map (gitnexus entry only)
  - `getProvider()` function that reads `~/.apra-fleet/data/code-intelligence/config.json`,
    defaults to `gitnexus` if missing, throws if provider key not in map
- **Files:** `src/tools/code-intelligence.ts` (new)
- **Tier:** standard
- **Done when:** file compiles clean with `tsc --noEmit`; interface has all 4 methods
  typed correctly; getProvider() falls back to gitnexus when config absent
- **Blockers:** none

#### Task 1.2: Implement gitnexus provider
- **Change:** Add `src/tools/code-intelligence-gitnexus.ts` implementing
  `CodeIntelligenceProvider`. Each method calls the corresponding gitnexus MCP
  tool via the MCP client already available in the fleet server context.
  - `graph(params)` -> gitnexus `call_graph`
  - `impact(params)` -> gitnexus `impact`
  - `query(params)` -> gitnexus `query`
  - `context(params)` -> gitnexus `context`
  Register provider in the PROVIDERS map in `code-intelligence.ts`.
- **Files:** `src/tools/code-intelligence-gitnexus.ts` (new), `src/tools/code-intelligence.ts`
- **Tier:** standard
- **Done when:** `tsc --noEmit` clean; each method passes params through to gitnexus
  unchanged and returns the response unchanged
- **Blockers:** need to confirm how gitnexus MCP tools are called from server-side
  tool handlers (check how existing MCP proxy tools work, if any)

#### Task 1.3: Register code_graph, code_impact, code_query, code_context in MCP server
- **Change:** In `src/index.ts`, register 4 new MCP tools. Each tool:
  - Has a schema matching the underlying gitnexus tool's input schema
  - Calls `getProvider()` then delegates to the appropriate provider method
  - Returns the provider response as its result
- **Files:** `src/index.ts`
- **Tier:** standard
- **Done when:** `tsc --noEmit` clean; all 4 tools appear in server tool list;
  calling `code_graph` with a valid symbol name returns a call graph

#### Task 1.4: Write unit tests for code intelligence abstraction
- **Change:** Add `src/tools/code-intelligence.test.ts` with tests for:
  - `getProvider()` falls back to `gitnexus` when config file is absent
  - `getProvider()` reads provider key from config.json
  - `getProvider()` throws with a clear message when provider key is not in PROVIDERS map
  - gitnexus provider: each method (graph, impact, query, context) passes params
    through to the underlying call and returns the response unchanged -- mock the
    MCP client call so this does not require a live gitnexus server
  Follow the test file naming and assertion patterns already in the repo (check
  existing `*.test.ts` files for style).
- **Files:** `src/tools/code-intelligence.test.ts` (new)
- **Tier:** standard
- **Done when:** `npm test` passes; all 6+ assertions above are present and pass;
  no tests are skipped or marked `.todo`
- **Blockers:** none

#### VERIFY: Phase 1
- `npm run build` clean
- `npm test` passes -- all new tests in code-intelligence.test.ts included
- Call `code_graph("handleIPChange")` on a test repo -- confirm result matches
  what `call_graph("handleIPChange")` returns directly from gitnexus
- Report: test results, any schema mismatches, any provider routing errors

---

### Phase 2: Installer + template updates

#### Task 2.1: Update install.ts Step 9 -- remove .mcp.json gitnexus entry
- **Change:** In `src/cli/install.ts` Step 9:
  - Remove the block that writes/merges gitnexus into `.mcp.json`
  - Add a block that removes the `mcpServers.gitnexus` entry from `.mcp.json`
    if it exists (clean up prior installs) -- skip silently if `.mcp.json`
    absent or gitnexus entry not present
  - Write `~/.apra-fleet/data/code-intelligence/config.json` with
    `{"provider": "gitnexus"}` (create dir if missing)
- **Files:** `src/cli/install.ts`
- **Tier:** cheap
- **Done when:** `npm run build` clean; running installer on a repo that has a
  gitnexus `.mcp.json` entry leaves that entry removed; config.json written correctly

#### Task 2.2: Update tpl-doer.md and tpl-reviewer.md
- **Change:** In `skills/pm/tpl-doer.md` and `skills/pm/tpl-reviewer.md`,
  replace the Knowledge Bank section:
  - `call_graph` -> `code_graph`
  - `impact` -> `code_impact`
  - `query` -> `code_query`
  - `context` -> `code_context`
  - Remove any mention of "GitNexus" by name from the template body
- **Files:** `skills/pm/tpl-doer.md`, `skills/pm/tpl-reviewer.md`
- **Tier:** cheap
- **Done when:** neither file contains the strings "gitnexus", "call_graph",
  "impact" (standalone), "GitNexus"; both files reference only fleet tool names

#### Task 2.3: Update knowledge-agent.md
- **Change:** In `skills/fleet/knowledge-agent.md` Phase 1 (Prime) section,
  replace gitnexus tool names with fleet tool names:
  - `call_graph` -> `code_graph`
  - `impact` -> `code_impact`
  - `query` -> `code_query`
  - Remove parenthetical "(call_graph, impact, query)" references
- **Files:** `skills/fleet/knowledge-agent.md`
- **Tier:** cheap
- **Done when:** file contains no gitnexus-specific tool names

#### VERIFY: Phase 2
- `npm run build` clean
- `npm test` passes
- Run `node dist/index.js install` on a repo that has gitnexus in `.mcp.json` --
  confirm gitnexus entry is removed from `.mcp.json` and
  `~/.apra-fleet/data/code-intelligence/config.json` is written
- Grep `skills/pm/tpl-doer.md` and `skills/fleet/knowledge-agent.md` for
  "gitnexus" and "call_graph" -- both must return no matches
- Report: test results, .mcp.json before/after diff, grep results

---

## Risk Register

| Risk | Impact | Mitigation |
|------|--------|------------|
| gitnexus MCP tools not directly callable from fleet server tool handlers -- they run in a separate process | HIGH | In Task 1.2 spike first: check if fleet can call another MCP server's tools server-side. If not, proxy via subprocess or HTTP instead of direct call. |
| Existing repos with gitnexus in .mcp.json stop working after install if fleet proxy is broken | MED | VERIFY Phase 1 gate: confirm code_graph returns correct results before Phase 2 removes .mcp.json entries |
| Template rename breaks existing dispatched sessions mid-sprint (doer has old context with call_graph) | LOW | Only in-flight sessions affected; new dispatches get updated template. Acceptable. |
| config.json missing on a machine that skips install | LOW | getProvider() defaults to gitnexus -- same behavior as before |

---

- **Base branch:** main
- **Implementation branch:** feat/code-intelligence-abstraction
