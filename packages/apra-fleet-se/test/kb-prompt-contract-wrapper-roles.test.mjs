import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROLE_POLICIES } from '../fleet-sprint/role-policies.mjs';

// apra-fleet-9jmc.3.2 -- verification for apra-fleet-9jmc.3.1's fix: every role
// row whose kbInjection is 'wrapper' and whose postResult has no 'kb-apply'
// step is dispatched to a member that cannot reach the fleet KB tools (the
// fleet MCP server is disabled there -- see src/providers/claude.ts's
// composePermissionConfig) and whose kb_captures output, if any, is never
// applied by the engine. Its role prompt (apra-pm/agents/<agentType>.md) must
// therefore never mark KB tool calls as required, and must never instruct the
// role to populate a kb_captures output field.
//
// DATA-DRIVEN so a future role added to role-policies.mjs with this same
// shape (wrapper injection, no kb-apply) is caught automatically, without
// anyone remembering to add it to a hardcoded list here.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.join(__dirname, '..', 'apra-pm', 'agents');
const SCHEMAS_DIR = path.join(AGENTS_DIR, 'schemas');
// The hand-kept mirror of the derived set, in the root vitest suite. Cross-checked
// below so the two can never drift apart unnoticed.
const HAND_KEPT_MIRROR = path.join(__dirname, '..', '..', '..', 'tests', 'agent-contracts-kb-wiring.test.ts');

/**
 * Every ROLE_POLICIES row whose KB priming is self-serve ('wrapper') and
 * whose postResult never applies a captured kb_captures output ('kb-apply'
 * absent). This is exactly the population that cannot reach the fleet KB
 * tools AND has no working capture channel -- its prompt contract must be
 * truthful about both.
 */
function wrapperRowsWithoutKbApply(rolePolicies) {
    return Object.entries(rolePolicies).filter(([, row]) => {
        const postResult = Array.isArray(row.postResult) ? row.postResult : [];
        return row.kbInjection === 'wrapper' && !postResult.includes('kb-apply');
    });
}

/**
 * Dedupes the selected rows onto their prompt FILE (several roles share one
 * agent persona -- scoped-replan-planner/scoped-replan-plan-reviewer reuse
 * planner/plan-reviewer's prompt file via `agentType`), while keeping every
 * contributing role name for a failure message that can name the offending
 * row.
 * @returns {Map<string, string[]>} agentType (file stem) -> role names
 */
function dedupeByAgentType(rows) {
    const byAgentType = new Map();
    for (const [roleName, row] of rows) {
        if (!row.agentType) {
            throw new Error(`kb-prompt-contract test: role '${roleName}' is kbInjection 'wrapper' with no kb-apply but has no agentType to map to a prompt file.`);
        }
        const existing = byAgentType.get(row.agentType) ?? [];
        existing.push(roleName);
        byAgentType.set(row.agentType, existing);
    }
    return byAgentType;
}

/** Extracts the "Knowledge Bank" step section: from its heading line to the next `## ` heading (or EOF). */
function extractKnowledgeBankSection(content) {
    const lines = content.split('\n');
    const startIdx = lines.findIndex((l) => /^#+.*Knowledge Bank/i.test(l));
    if (startIdx === -1) return null;
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
        if (/^##\s/.test(lines[i])) { endIdx = i; break; }
    }
    return { headingLine: lines[startIdx], section: lines.slice(startIdx, endIdx).join('\n') };
}

// Catches the exact pre-fix defect: "## Step 0 -- Knowledge Bank (required --
// do this BEFORE ...)". A generic "(required" anywhere else in the file
// (input contracts, unrelated field requirements) is NOT scoped by this --
// only the Knowledge Bank section's own heading/body is inspected.
const REQUIRED_KB_STEP_RE = /\(\s*required\b/i;

// Catches an INSTRUCTION to populate/emit a kb_captures output field --
// meaning-based (an imperative verb near the field name), not a single
// exact sentence, so a differently-worded instruction to the same effect
// still trips it. Deliberately does not fire on prose that merely explains
// the field exists and says to leave it empty (e.g. "omit it or send []").
const KB_CAPTURES_INSTRUCTION_RE = /\b(add|populate|emit|include|fill(?:\s+in)?|write)\b[\s\S]{0,100}?kb_captures/i;

// The heading check above only inspects kb.headingLine, so a prompt whose
// HEADING drops "(required" while its BODY still carries an unconditional
// imperative KB tool-call step -- exactly the shape this branch had at Step 0
// item 1, "Run ToolSearch with query ..." -- would pass vacuously. This second
// check scans the section BODY for an imperative verb (run/call/invoke)
// immediately preceding "ToolSearch" or an "mcp__*__kb_*" tool name, in a unit
// of prose that carries no guarding conditional.
const KB_TOOL_IMPERATIVE_RE = /\b(run|call|invoke)\b\s+(?:the\s+)?`?(ToolSearch|mcp__[\w-]+__kb_[\w-]+)/i;
const KB_CONDITIONAL_GUARD_RE = /\b(if|when|unless|optional|where\s+(?:available|reachable)|opportunistically|bonus\s+path)\b/i;

/**
 * Scans a Knowledge Bank step's full text (heading + body) for an
 * UNCONDITIONAL imperative KB tool-call instruction: an imperative verb next
 * to "ToolSearch"/"mcp__*__kb_*" with no guard word ("if"/"when"/"unless"/
 * "optional"/"where available"/etc) anywhere in the same UNIT of prose.
 *
 * A "unit" is one markdown paragraph, further split at each new numbered/
 * bulleted list item -- NOT a physical source line, because this repo's
 * prompt markdown hard-wraps a single sentence across several lines (e.g.
 * "1. Optional, only if you want a live lookup beyond the pre-fetched block,
 * run ToolSearch with query\n   `"select:...`" -- the guard word "Optional"
 * and the imperative "run ToolSearch" are one sentence but two physical
 * lines). A line-by-line scan would misread that as unconditional;
 * collapsing each item back to one string first reads it the way a person
 * would.
 *
 * @param {string} section
 * @returns {string|null} the first offending unit (whitespace-collapsed), or null
 */
function findUnconditionalKbToolCall(section) {
    const paragraphs = String(section || '').split(/\n\s*\n/);
    const units = [];
    for (const para of paragraphs) units.push(...para.split(/\n(?=\s*(?:\d+\.|[-*])\s)/));
    for (const unit of units) {
        const collapsed = unit.replace(/\s+/g, ' ').trim();
        if (KB_TOOL_IMPERATIVE_RE.test(collapsed) && !KB_CONDITIONAL_GUARD_RE.test(collapsed)) return collapsed;
    }
    return null;
}

test('wrapper-injection roles without a kb-apply step: derived set is non-empty and includes planner', () => {
    const rows = wrapperRowsWithoutKbApply(ROLE_POLICIES);
    const roleNames = rows.map(([name]) => name);
    assert.ok(rows.length > 0, 'expected at least one wrapper-injection role row with no kb-apply postResult step -- a vacuous empty set would make every assertion below pass trivially');
    assert.ok(
        roleNames.includes('planner'),
        `expected the derived set to include 'planner' (the role the parent bug named), got: ${JSON.stringify(roleNames)}`
    );
});

test('wrapper-injection roles without a kb-apply step: their prompt files require no KB tool calls and instruct no kb_captures output', () => {
    const rows = wrapperRowsWithoutKbApply(ROLE_POLICIES);
    const byAgentType = dedupeByAgentType(rows);

    // The seven affected rows (planner, scoped-replan-planner, plan-reviewer,
    // scoped-replan-plan-reviewer, deployer, integ-test-runner,
    // regression-test-runner) must collapse to exactly five distinct files --
    // the scoped-replan pair reuses planner/plan-reviewer's prompt.
    assert.ok(
        byAgentType.size < rows.length,
        `expected deduping by agentType to collapse the ${rows.length} affected role row(s) onto fewer prompt files, got ${byAgentType.size} distinct files for roles: ${JSON.stringify(rows.map(([n]) => n))}`
    );

    for (const [agentType, roleNames] of byAgentType) {
        const filePath = path.join(AGENTS_DIR, `${agentType}.md`);
        assert.ok(fs.existsSync(filePath), `role(s) ${roleNames.join(', ')} map to a prompt file that does not exist: ${filePath}`);
        const content = fs.readFileSync(filePath, 'utf8');

        const kb = extractKnowledgeBankSection(content);
        assert.ok(kb, `role(s) ${roleNames.join(', ')}: ${agentType}.md has no "Knowledge Bank" step to inspect`);

        assert.ok(
            !REQUIRED_KB_STEP_RE.test(kb.headingLine),
            `role(s) ${roleNames.join(', ')}: ${agentType}.md's Knowledge Bank heading still marks the step "(required" -- ` +
            `KB tool calls are unreachable on a dispatched member (fleet MCP server disabled), so this step must not be ` +
            `required. Heading line: ${JSON.stringify(kb.headingLine)}`
        );

        // The heading check above is not enough on its own -- a prompt could
        // drop "(required" from the heading while its BODY still states an
        // unconditional imperative KB tool-call step.
        const unconditionalLine = findUnconditionalKbToolCall(kb.section);
        assert.ok(
            !unconditionalLine,
            `role(s) ${roleNames.join(', ')}: ${agentType}.md's Knowledge Bank section body has an UNCONDITIONAL ` +
            `imperative KB tool-call instruction (no guarding if/when/unless/optional/"where available"/etc in that ` +
            `unit of prose) -- KB tool calls are unreachable on a dispatched member for this role, so the instruction ` +
            `must be conditional. Offending text: ${JSON.stringify(unconditionalLine)}`
        );

        const captureMatch = content.match(KB_CAPTURES_INSTRUCTION_RE);
        assert.ok(
            !captureMatch,
            `role(s) ${roleNames.join(', ')}: ${agentType}.md instructs populating a kb_captures output field ` +
            `(matched ${JSON.stringify(captureMatch && captureMatch[0])}), but this role's postResult has no 'kb-apply' ` +
            `step, so nothing in the engine ever reads/applies that field.`
        );
    }
});

test('the planner prompt and planner-output.json agree that kb_captures is inert for this role', () => {
    // A schema that advertises a working field while the prompt denies it is exactly
    // the contradiction this test exists to prevent, so BOTH halves are asserted here
    // rather than trusting either file alone.
    const schemaPath = path.join(SCHEMAS_DIR, 'planner-output.json');
    assert.ok(fs.existsSync(schemaPath), `expected the planner output schema at ${schemaPath}`);
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

    const promptPath = path.join(AGENTS_DIR, 'planner.md');
    const prompt = fs.readFileSync(promptPath, 'utf8');
    assert.equal(
        findKbCapturesInstruction(prompt),
        null,
        'planner.md must not instruct producing a kb_captures output -- the planner row has no kb-apply postResult step'
    );

    const captures = schema.properties?.kb_captures;
    if (captures === undefined) return; // dropping the field entirely also satisfies the contract

    assert.match(
        String(captures.description ?? ''),
        /ignored for this role|no apply path|silently dropped/i,
        'planner-output.json still declares kb_captures, so its description must state plainly that the field is ' +
        'ignored/has no apply path for this role -- otherwise the schema advertises a working field the prompt denies. ' +
        `Got: ${JSON.stringify(captures.description)}`
    );
});

/** The kb_captures-instruction scan, exposed for the schema-agreement test above. */
function findKbCapturesInstruction(content) {
    const m = String(content || '').match(KB_CAPTURES_INSTRUCTION_RE);
    return m ? m[0] : null;
}

test('the hand-kept OPTIONAL_KB_ROLES list in the root vitest suite matches the set derived here', () => {
    // AC: a drift between the two lists must FAIL a test rather than be left for a
    // reader to notice. This file is the source of truth (it derives from
    // role-policies.mjs); the root suite's literal is a mirror, read back out here.
    assert.ok(fs.existsSync(HAND_KEPT_MIRROR), `expected the hand-kept mirror at ${HAND_KEPT_MIRROR}`);
    const mirrorSrc = fs.readFileSync(HAND_KEPT_MIRROR, 'utf8');
    const literal = /const\s+OPTIONAL_KB_ROLES\s*=\s*\[([^\]]*)\]/.exec(mirrorSrc);
    assert.ok(literal, 'could not find an OPTIONAL_KB_ROLES array literal in the root vitest suite to compare against');

    const mirrored = literal[1]
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean)
        .sort();

    const derived = [...dedupeByAgentType(wrapperRowsWithoutKbApply(ROLE_POLICIES)).keys()].sort();

    assert.deepEqual(
        mirrored,
        derived,
        'DRIFT: the hand-kept OPTIONAL_KB_ROLES list in tests/agent-contracts-kb-wiring.test.ts no longer matches the ' +
        'set derived from role-policies.mjs (wrapper injection, no kb-apply, deduped by agentType). Update that ' +
        `literal to: ${JSON.stringify(derived)}`
    );
});

// ---------------------------------------------------------------------------
// findUnconditionalKbToolCall() in isolation -- fabricated fixtures, not real
// prompt files, so the catch/no-catch behaviour is pinned independently of
// whatever the current apra-pm/agents/*.md content happens to say.
// ---------------------------------------------------------------------------

test('findUnconditionalKbToolCall: catches the vacuous-pass regression shape (heading has no "(required", body has an unconditional "Run ToolSearch")', () => {
    // Mirrors the actual pre-fix Step 0 item 1 ("Run ToolSearch with query
    // ...") with no guarding "if"/"when" anywhere in that unit. The
    // heading-only check would pass this vacuously because the heading below
    // never says "(required".
    const content = [
        '## Step 0 -- Knowledge Bank (do this BEFORE any other work)',
        '',
        '1. Run ToolSearch with query',
        '   `"select:mcp__apra-fleet__kb_session_prime,mcp__apra-fleet__kb_query"`',
        '2. Call `mcp__apra-fleet__kb_session_prime` with `repo_path` set to the repo.',
        '',
        '## Step 1 -- Next section',
    ].join('\n');

    const kb = extractKnowledgeBankSection(content);
    assert.ok(kb, 'fixture must have an extractable Knowledge Bank section');
    assert.ok(!REQUIRED_KB_STEP_RE.test(kb.headingLine), 'premise: the heading-only check must NOT catch this fixture');

    const offending = findUnconditionalKbToolCall(kb.section);
    assert.ok(offending, 'the body-level check must catch what the heading-only check missed');
    assert.match(offending, /Run ToolSearch/);
});

test('findUnconditionalKbToolCall: does NOT flag a properly-guarded body (the current, already-fixed wrapper-role shape)', () => {
    // Mirrors the real, already-fixed wrapper-role prompts (planner.md,
    // deployer.md, etc): every imperative KB tool call is guarded by an
    // "Optional, only if you want a live lookup ..." / "... if it is reachable"
    // clause in the SAME unit of prose, hard-wrapped across physical lines
    // exactly as the real files are. This pins the absence of a false positive.
    const content = [
        '## Step 0 -- Knowledge Bank (do this BEFORE any other work)',
        '',
        '1. Optional, only if you want a live lookup beyond the pre-fetched block, run ToolSearch with query',
        '   `"select:mcp__apra-fleet__kb_session_prime,mcp__apra-fleet__kb_capture"`',
        '2. If, and only if, a live lookup is available, you may call',
        '   `mcp__apra-fleet__kb_session_prime` with `repo_path` set to the repo you are planning for.',
        '',
        '## Step 1 -- Next section',
    ].join('\n');

    const kb = extractKnowledgeBankSection(content);
    assert.ok(kb, 'fixture must have an extractable Knowledge Bank section');
    assert.equal(findUnconditionalKbToolCall(kb.section), null);
});

test('findUnconditionalKbToolCall: catches an unconditional "call mcp__*__kb_*" (not just "run ToolSearch")', () => {
    const section = [
        '## Step 0 -- Knowledge Bank',
        '',
        '1. Call `mcp__apra-fleet__kb_session_prime` with `repo_path` set to the repo.',
    ].join('\n');
    const offending = findUnconditionalKbToolCall(section);
    assert.ok(offending);
    assert.match(offending, /kb_session_prime/);
});

test('KB_CAPTURES_INSTRUCTION_RE: flags an instruction to populate the field, but not prose saying it is inert', () => {
    assert.ok(
        KB_CAPTURES_INSTRUCTION_RE.test('add it to your structured output\'s `kb_captures` array as you go'),
        'an instruction to add entries to kb_captures must be flagged'
    );
    assert.ok(
        !KB_CAPTURES_INSTRUCTION_RE.test('The schema also declares a `kb_captures` array, but the engine does not read or apply that field for this role.'),
        'prose that merely explains the field is inert must NOT be flagged'
    );
});

test('wrapper-injection roles without a kb-apply step: harvester, doer and reviewer are excluded (they have kb-apply)', () => {
    const rows = wrapperRowsWithoutKbApply(ROLE_POLICIES);
    const roleNames = rows.map(([name]) => name);
    for (const excluded of ['harvester', 'doer', 'doer-resume', 'reviewer', 'final-review']) {
        assert.ok(
            !roleNames.includes(excluded),
            `'${excluded}' has a kb-apply postResult step (or is not wrapper-injection) and must not appear in the ` +
            `derived defective set, got: ${JSON.stringify(roleNames)}`
        );
    }
});
