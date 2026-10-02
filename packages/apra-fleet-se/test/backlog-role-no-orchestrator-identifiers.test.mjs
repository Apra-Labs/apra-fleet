import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Grep guard: the beads-member role is `backlog`; the old `orchestrator`
// spelling lives ONLY in the alias module (fleet-sprint/backlog-role.mjs).
// It fails on any role-sense reintroduction in fleet-sprint, bin and src
// (JS/MJS only; docs/ and node_modules excluded):
//  (a) ANY compound identifier containing orchestrator in any casing. At
//      planning every such hit was role-sense: orchestratorMember,
//      getOrchestratorMember, plannerSharesOrchestratorClone,
//      orchestratorProbe, orchestratorHasDb, orchestratorRoleMapMembers,
//      ROLE_ORCHESTRATOR, ORCHESTRATOR_ROLE.
//  (b) roleMap.orchestrator and roleMap bracket-access of the string
//      orchestrator.
//  (c) "orchestrator member" (any case) and the "orchestrator '<name>'" label.
// Hyphenated or bare engine-sense words (orchestrator-side, "the orchestrator
// applies", ORCHESTRATOR standing alone) are intentionally NOT matched.

const PKG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['fleet-sprint', 'bin', 'src'].map((d) => path.join(PKG, d));
const ALLOWLIST = new Set([path.join(PKG, 'fleet-sprint', 'backlog-role.mjs')]);

export const PATTERNS = [
    ['compound identifier', /[A-Za-z0-9_]*(orchestrator|Orchestrator|ORCHESTRATOR)[A-Z0-9_][A-Za-z0-9_]*/],
    ['prefixed identifier (ROLE_ORCHESTRATOR, fooOrchestrator)', /[A-Za-z0-9]_ORCHESTRATOR|[a-z0-9]Orchestrator/],
    ['roleMap.orchestrator', /roleMap\.orchestrator\b/],
    ['roleMap bracket access', /roleMap\[\s*['"`]orchestrator['"`]\s*\]/],
    ['orchestrator member', /orchestrator member/i],
    ["orchestrator '<name>' label", /orchestrator '/],
];

function walk(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.name === 'node_modules' || e.name === 'docs') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (/\.(mjs|js)$/.test(e.name)) out.push(p);
    }
    return out;
}

export function scan(text) {
    const hits = [];
    text.split('\n').forEach((line, i) => {
        for (const [name, re] of PATTERNS) if (re.test(line)) hits.push(`${i + 1}: [${name}] ${line.trim().slice(0, 120)}`);
    });
    return hits;
}

test('no role-sense orchestrator identifiers/strings outside the alias module', () => {
    const offenders = [];
    for (const root of ROOTS) {
        for (const file of walk(root)) {
            if (ALLOWLIST.has(file)) continue;
            for (const h of scan(fs.readFileSync(file, 'utf8'))) offenders.push(`${path.relative(PKG, file)}:${h}`);
        }
    }
    assert.deepEqual(offenders, [], `role-sense orchestrator text must be renamed to backlog:\n${offenders.join('\n')}`);
});

test('the patterns catch each reintroduced name and spare engine-sense words', () => {
    for (const bad of ['orchestratorMember', 'orchestratorProbe', 'plannerSharesOrchestratorClone', 'ORCHESTRATOR_ROLE',
        'getOrchestratorMember', 'orchestratorHasDb', 'orchestratorRoleMapMembers', 'ROLE_ORCHESTRATOR',
        'x = roleMap.orchestrator', "roleMap['orchestrator']", 'the Orchestrator Member', "label: `orchestrator '${m}'`"]) {
        assert.ok(scan(bad).length > 0, `expected a hit for: ${bad}`);
    }
    for (const ok of ['orchestrator-side bookkeeping', 'the orchestrator applies your verdict', 'ORCHESTRATOR alone', 'the orchestrator process']) {
        assert.deepEqual(scan(ok), [], `engine-sense text must stay legal: ${ok}`);
    }
});
