import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROLE_POLICIES } from '../fleet-sprint/role-policies.mjs';

// apra-fleet-9jmc.2 -- verification for apra-fleet-9jmc.1's fix: every role
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

        const captureMatch = content.match(KB_CAPTURES_INSTRUCTION_RE);
        assert.ok(
            !captureMatch,
            `role(s) ${roleNames.join(', ')}: ${agentType}.md instructs populating a kb_captures output field ` +
            `(matched ${JSON.stringify(captureMatch && captureMatch[0])}), but this role's postResult has no 'kb-apply' ` +
            `step, so nothing in the engine ever reads/applies that field.`
        );
    }
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
