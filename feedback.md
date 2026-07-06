# Review: code_graph retarget off non-existent call_graph tool (yashr-5t9)

Reviewer: pm-reviewer
Scope: commit f4fa648 -- src/tools/code-intelligence-gitnexus.ts,
tests/code-intelligence.test.ts, docs/code-intelligence-child-surface.md.
Bug: GitNexusProvider.graph() called child tool 'call_graph', which does not
exist in gitnexus 1.6.7, so code_graph always returned isError
"Unknown tool: call_graph".

## Verdict: APPROVED

graph() is correctly retargeted to compose two depth-bounded cypher CALLS
traversals (callers + callees), the user-controlled symbol is safely bound as a
cypher param (no interpolation), the query works live against the real child,
the response mapping is correct and degraded-safe, and the new regression test
genuinely fails on the old mapping and passes on the fix. Build clean; only the
2 known pre-existing timezone failures (yashr-302). Two LOW, non-blocking notes.

## Checklist results

1. Retarget correctness -- PASS. graph() no longer calls call_graph; it issues
   callGitNexus('cypher', ...) twice. Both queries are depth-bounded
   `:CodeRelation*1..2 {type: "CALLS"}` (GRAPH_MAX_DEPTH=2) in both directions
   (callers: `(caller)-[..]->(target)` WHERE target.name; callees:
   `(source)-[..]->(callee)` WHERE source.name). The only value concatenated
   into the query string is the integer constant GRAPH_MAX_DEPTH/GRAPH_ROW_LIMIT
   (Cypher cannot parameterize variable-length bounds); the user-controlled
   `symbol` is bound via the params object `params: { symbol }`, never
   interpolated -- no injection surface. Routes through callGitNexus, inheriting
   pre-flight index check, resilience, and freshness wiring. Does NOT parse lbug.

2. LOAD-BEARING live verification -- PASS. Spawned `npx -y gitnexus mcp` over
   stdio exactly as getGitNexusClient does (throwaway script, not committed) and
   ran the EXACT GRAPH_CALLERS_QUERY / GRAPH_CALLEES_QUERY graph() sends.
   - listTools() -> 13 tools; call_graph ABSENT; cypher present. Confirms the
     bug and the choice of child tool.
   - CALLERS(callGitNexus) -> isError:false, row_count 11, {markdown,row_count}
     shape with a depth column: depth-1 callers (context, flow, graph, impact,
     map, query, tests) and depth-2 (kbSessionPrime, test file) -- real,
     correct, multi-hop.
   - CALLEES(callGitNexus) -> isError:false, row_count 9: depth-1
     (getGitNexusClient, appendFreshnessNote, computeFreshnessNote,
     offlineResult, missingIndexResult, resetConnection) and depth-2
     (freshnessNote, logError, maybeScheduleReindex).
   The query is well-formed and returns meaningful caller/callee rows. No error,
   no empty result.

3. Response mapping -- PASS. mapGraphRows -> extractCypherPayload (strips the
   "\n\n---\n" hint suffix) -> parseMarkdownTable -> {name, filePath, depth}.
   Column names (name|filePath|depth) match the live markdown exactly.
   asciiSanitizeLabel is applied to each row's name and to the top-level symbol
   echo. Empty table -> [] (parseMarkdownTable guards < 2 lines). isError is
   short-circuited in graph() BEFORE mapping (callers checked first, so a broken
   index does not fan out a second call). Unexpected shape -> extractCypherPayload
   returns null -> mapGraphRows returns [] rather than throwing. (Minor: filePath
   is not ASCII-sanitized, but paths are ASCII in practice -- not a defect.)

4. Regression test -- PASS, genuinely guards the bug class. The "child-tool
   surface guard" exercises every provider method that reaches the child, then
   derives invokedToolNames DYNAMICALLY from mockCallTool.mock.calls (not a
   hardcoded list of invoked names), asserting (a) it never contains
   'call_graph' and (b) every invoked name is present in the child surface.
   Under the old graph()->'call_graph' mapping, 'call_graph' would be recorded
   and is absent from the surface, so BOTH assertions fail; the composition test
   independently expects exactly 2 'cypher' calls, which the old single
   call_graph call also fails. Verified by construction (product code was not
   modified to run the negative case, per the no-product-edits constraint).
   Limitation (see LOW-2): the surface list is a hardcoded/mocked
   CHILD_SURFACE_1_6_7, so the test catches a fleet-side mapping to a name absent
   from the documented surface, but does NOT catch the real child renaming an
   existing tool -- that live drift check is delegated to the out-of-band probe +
   doc, as the test comments state.

5. Test migration -- PASS, no coverage lost. The freshness (F2.2), resilience
   (F3.2), and pre-flight (F3.1) tests previously used graph() purely as a
   generic callGitNexus passthrough vehicle. Since graph() is no longer a
   passthrough (it reshapes and, by design, does not carry the freshness note),
   they were correctly moved to impact(), which is a true passthrough exercising
   the identical callGitNexus wiring. The pre-flight assertion that previously
   expected `{name:'call_graph', arguments:{symbol}}` now correctly expects
   `{name:'impact', ...}`. New graph() tests (shape, unicode sanitization, error
   short-circuit) add the coverage the removed passthrough test used to imply.

6. build + test -- PASS. `npm run build` (tsc) exit 0. Full suite: 1773 passed,
   2 failed, 14 skipped -- both failures are the known pre-existing timezone
   tests in tests/time-utils.test.ts (yashr-302). code-intelligence.test.ts:
   57/57 pass. No other regressions.

7. ASCII + doc -- PASS with LOW-1. Doc: clean, updated to reality (finding
   retitled "RESOLVED (yashr-5t9)", backlog bead marked DONE, live re-verification
   recorded). Source: the only non-ASCII is the pre-existing UNICODE_ARROW_PATTERN
   regex (line 227), unchanged by this commit. Test: one NEW literal unicode arrow
   at line 203 (see LOW-1).

## Findings

HIGH: none.

MEDIUM: none.

LOW-1 (ASCII convention, non-blocking): tests/code-intelligence.test.ts line 203
introduces a literal non-ASCII arrow in a fixture
(`'| Rem->ove | src/a.ts | 1 |'` written with U+2192) to exercise
asciiSanitizeLabel over a returned graph-node name. This matches five
pre-existing accepted fixtures in the same file (lines 718/726/775/899/927) and
the load-bearing sanitizer regex the prior review already deemed acceptable, so
it is consistent with codebase precedent rather than a new class of violation.
Strictly, the project ASCII-only rule could be honored by using a
JS unicode escape (backslash-u-2192) instead of the literal glyph. No functional impact; optional cleanup.

LOW-2 (test design, informational): the child-tool surface guard asserts against
a hardcoded/mocked CHILD_SURFACE_1_6_7 rather than a live listTools(). It
therefore guards the exact shipped bug (fleet maps to a tool name that never
existed on the documented surface) and would catch any future fleet-side mapping
to an undocumented tool, but it would NOT catch the real gitnexus child renaming
an existing tool out from under the fleet. That live-drift concern is explicitly
delegated to the out-of-band probe + doc in the test comments. Acceptable as
scoped; a future enhancement could add a slow/tagged live-spawn contract test.

## Rationale

The retarget removes the dead call_graph mapping, binds the only user-controlled
value as a cypher param, is confirmed working live against the real 1.6.7 child
(13 tools, call_graph absent; both queries return real depth-1/2 rows in the
{markdown,row_count} shape), maps responses safely, migrates the reused
passthrough tests without losing coverage, and adds a regression test that fails
on the old mapping -- with a clean build and only pre-existing timezone failures.
APPROVED.
