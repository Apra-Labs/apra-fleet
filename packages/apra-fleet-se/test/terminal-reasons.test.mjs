import { test, describe } from 'node:test';
import assert from 'node:assert';

import * as errors from '../fleet-sprint/errors.mjs';
import {
    TERMINAL_REASON_CLASSES, classifyTerminalReason, RELAUNCH_GATE_REASONS,
} from '../src/supervisor/terminal-reasons.mjs';
import { DETERMINISTIC_TERMINAL_REASONS } from '../src/supervisor/history.mjs';

// Instantiate with minimal args: some classes demand a typed `reason`, whose
// allowed values are named in the constructor's TypeError message.
function instantiate(C) {
    try { return new C('x'); } catch (err) {
        const m = /\(([A-Z_, ]+)\)/.exec(String(err && err.message));
        if (!m) throw err;
        return new C('x', { reason: m[1].split(',')[0].trim(), member: 'm', runbook: 'r' });
    }
}

function errorReasons() {
    const out = [];
    for (const [name, C] of Object.entries(errors)) {
        if (typeof C === 'function' && C.prototype instanceof Error) {
            const e = instantiate(C);
            out.push({ exportName: name, reason: e.code ?? e.name });
        }
    }
    return out;
}

describe('terminal reason class table', () => {
    test('every errors.mjs Error subclass plus the open-set reasons is in exactly one class', () => {
        const classes = Object.entries(TERMINAL_REASON_CLASSES);
        const universe = [
            ...errorReasons(),
            ...['BEADS_SYNC_CONFLICT', 'UNKNOWN_ABORT', 'SIGINT', 'SIGTERM'].map((r) => ({ exportName: r, reason: r })),
        ];
        assert.ok(universe.length >= 17, 'enumeration found the error classes');
        for (const { exportName, reason } of universe) {
            const homes = classes.filter(([, set]) => set.has(reason)).map(([c]) => c);
            assert.equal(homes.length, 1, `${exportName} (${reason}) must be in exactly one class, found: [${homes}]`);
        }
    });

    test('table and its sets are frozen', () => {
        assert.ok(Object.isFrozen(TERMINAL_REASON_CLASSES));
        for (const set of Object.values(TERMINAL_REASON_CLASSES)) assert.ok(Object.isFrozen(set));
        assert.deepEqual(Object.keys(TERMINAL_REASON_CLASSES).sort(), ['deterministic', 'engine-bug', 'judgement', 'transient']);
    });

    test('unknown, null, undefined and non-string reasons are engine-bug', () => {
        for (const v of ['SOMETHING_NEW', null, undefined, 42, {}]) assert.equal(classifyTerminalReason(v), 'engine-bug');
    });

    test('known reasons classify to their class', () => {
        assert.equal(classifyTerminalReason('BEADS_SYNC_CONFLICT'), 'deterministic');
        assert.equal(classifyTerminalReason('SPRINT_STALLED'), 'judgement');
        assert.equal(classifyTerminalReason('SIGTERM'), 'transient');
    });

    test('RELAUNCH_GATE_REASONS is exactly {BEADS_SYNC_CONFLICT} and a subset of deterministic', () => {
        assert.deepEqual([...RELAUNCH_GATE_REASONS], ['BEADS_SYNC_CONFLICT']);
        for (const r of RELAUNCH_GATE_REASONS) assert.ok(TERMINAL_REASON_CLASSES.deterministic.has(r));
    });

    test('history DETERMINISTIC_TERMINAL_REASONS is still exactly {BEADS_SYNC_CONFLICT}', () => {
        assert.deepEqual([...DETERMINISTIC_TERMINAL_REASONS], ['BEADS_SYNC_CONFLICT']);
    });
});
