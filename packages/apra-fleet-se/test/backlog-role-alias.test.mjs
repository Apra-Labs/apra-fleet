import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_BACKLOG, BACKLOG_ALIAS_WARNING, resolveBacklogRoleAlias } from '../fleet-sprint/backlog-role.mjs';

test('backlog-only roleMap passes through with no warnings', () => {
    const r = resolveBacklogRoleAlias({ backlog: ['m1'], doer: ['d'] });
    assert.deepEqual(r.roleMap, { backlog: ['m1'], doer: ['d'] });
    assert.deepEqual(r.warnings, []);
});

test('orchestrator-only roleMap maps to backlog with one v0.5 deprecation warning', () => {
    const r = resolveBacklogRoleAlias({ orchestrator: ['m1'] });
    assert.deepEqual(r.roleMap, { backlog: ['m1'] });
    assert.equal(r.warnings.length, 1);
    assert.equal(r.warnings[0], BACKLOG_ALIAS_WARNING);
    assert.match(r.warnings[0], /v0\.5/);
    assert.match(r.warnings[0], /roleMap\.orchestrator/);
    assert.match(r.warnings[0], /roleMap\.backlog/);
});

test('both keys with equal lists are accepted (still warns)', () => {
    const r = resolveBacklogRoleAlias({ backlog: ['m1'], orchestrator: ['m1'] });
    assert.deepEqual(r.roleMap, { backlog: ['m1'] });
    assert.equal(r.warnings.length, 1);
});

test('both keys with different lists throw naming both keys', () => {
    assert.throws(
        () => resolveBacklogRoleAlias({ backlog: ['a'], orchestrator: ['b'] }),
        (e) => /"backlog"/.test(e.message) && /"orchestrator"/.test(e.message),
    );
});

test('undefined roleMap is a no-op and ROLE_BACKLOG is "backlog"', () => {
    assert.deepEqual(resolveBacklogRoleAlias(undefined), { roleMap: undefined, warnings: [] });
    assert.equal(ROLE_BACKLOG, 'backlog');
});
