import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectBacklogMember, formatBacklogSelection, resolveBacklogRoleAlias } from '../fleet-sprint/backlog-role.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const M = ['m0', 'm1', 'm2'];

const CASES = [
    { name: 'explicit backlog wins even when not members[0]', roleMap: { backlog: ['m2'], doer: ['m0'] }, want: 'm2', explicit: true },
    { name: 'no roleMap -> members[0]', roleMap: undefined, want: 'm0', explicit: false },
    { name: 'generalist later in the list is chosen', roleMap: { reviewer: ['m0'], doer: ['m1'] }, want: 'm2', explicit: false },
    { name: 'all mapped, one to doer -> first doer-mapped (not members[0])', roleMap: { reviewer: ['m0'], doer: ['m2'], planner: ['m1'] }, want: 'm2', explicit: false },
    { name: 'all mapped, none to doer -> members[0]', roleMap: { reviewer: ['m0'], planner: ['m1', 'm2'] }, want: 'm0', explicit: false },
];

for (const c of CASES) {
    test(`selectBacklogMember: ${c.name}`, () => {
        const r = selectBacklogMember({ roleMap: c.roleMap, members: M });
        assert.equal(r.member, c.want);
        assert.equal(r.explicit, c.explicit);
    });
}

test('selectBacklogMember: deprecated orchestrator alias (resolved first) behaves like backlog', () => {
    const { roleMap } = resolveBacklogRoleAlias({ orchestrator: ['m2'] });
    const r = selectBacklogMember({ roleMap, members: M });
    assert.deepEqual([r.member, r.explicit], ['m2', true]);
});

test('selectBacklogMember: reason strings are distinct per branch', () => {
    const reasons = CASES.map((c) => selectBacklogMember({ roleMap: c.roleMap, members: M }).reason);
    assert.equal(new Set(reasons).size, reasons.length, reasons.join(' | '));
});

test('formatBacklogSelection: loud line for auto-select, null when explicit', () => {
    const auto = selectBacklogMember({ roleMap: undefined, members: M });
    assert.match(formatBacklogSelection(auto), /^backlog: m0 \(auto-selected: .+\)$/);
    assert.equal(formatBacklogSelection(selectBacklogMember({ roleMap: { backlog: ['m1'] }, members: M })), null);
});

test('cli.mjs and runner.js both use the shared selector and keep no independent resolution', () => {
    const cli = fs.readFileSync(path.join(__dirname, '../bin/cli.mjs'), 'utf8');
    const runner = fs.readFileSync(path.join(__dirname, '../fleet-sprint/runner.js'), 'utf8');
    for (const raw of [cli, runner]) {
        const src = raw.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
        assert.match(src, /selectBacklogMember\(\{ roleMap/);
        assert.doesNotMatch(src, /getMemberForRole\(ROLE_BACKLOG\)/);
        assert.doesNotMatch(src, /roleMap\[ROLE_BACKLOG\]\[0\]/);
    }
});
