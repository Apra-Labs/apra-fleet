import { test, describe } from 'node:test';
import assert from 'node:assert';

import { installFatalDiagnosticsGuard } from '../auto-sprint/runner.js';

// apra-fleet-eft.20.3: the doer-dispatch boundary half of "surface a silent
// doer/orchestrator death instead of exiting quietly". installFatalDiagnosticsGuard()
// wraps the process-level 'unhandledRejection'/'uncaughtException' events so a
// crash that happens OUTSIDE any awaited call chain in runSprintCycle() (the
// apra-fleet-eft.20 smoke-test symptom: the process just went silent, no
// error, no exit line) still produces (a) an explicit [FATAL] log line and
// (b) a persisted terminal() state -- the SAME two signals the watchdog-side
// recorder produces for the PID-liveness path (see supervisor-watchdog.test.mjs).
//
// These tests deliberately do NOT use `process.emit('uncaughtException', ...)`
// / real rejected promises: node's own test runner installs its own
// process-level uncaughtException/unhandledRejection handling that would
// treat a real emission as an actual failing-test crash. Instead, we capture
// the exact listener functions installFatalDiagnosticsGuard() registers via
// `process.on` (spied, restored after each test) and invoke them directly --
// this exercises the guard's real handler logic without touching the live
// process event machinery.

/** Spy on process.on for 'uncaughtException'/'unhandledRejection' only, capturing the registered listener; all other events pass through untouched. Returns { getListener(event), restore() }. */
function spyOnProcessOn() {
    const original = process.on.bind(process);
    const captured = {};
    process.on = (event, listener) => {
        if (event === 'uncaughtException' || event === 'unhandledRejection') {
            captured[event] = listener;
            return process;
        }
        return original(event, listener);
    };
    return {
        getListener: (event) => captured[event],
        restore: () => { process.on = original; },
    };
}

describe('installFatalDiagnosticsGuard -- doer-dispatch boundary fatal diagnostics', () => {
    test('an uncaughtException is logged with [FATAL] + the last known phase, and persisted via publishState(terminal, ...)', () => {
        const spy = spyOnProcessOn();
        const logLines = [];
        const publishedStates = [];
        let uninstall;
        let err;
        try {
            uninstall = installFatalDiagnosticsGuard({
                log: (msg) => logLines.push(msg),
                publishState: (namespace, data) => publishedStates.push({ namespace, data }),
                phaseOf: () => 'Develop',
            });
            err = new Error('doer child stopped responding after Develop checkpoint');
            spy.getListener('uncaughtException')(err);
        } finally {
            spy.restore();
        }
        assert.ok(typeof uninstall === 'function');

        assert.ok(
            logLines.some((l) => l.includes('[FATAL]') && l.includes('uncaughtException') && l.includes('Develop')),
            `expected a [FATAL] uncaughtException line mentioning phase Develop, got: ${JSON.stringify(logLines)}`
        );
        assert.equal(publishedStates.length, 1);
        assert.equal(publishedStates[0].namespace, 'terminal');
        assert.equal(publishedStates[0].data.failed, true);
        assert.equal(publishedStates[0].data.terminalReason, 'uncaughtException');
        assert.ok(publishedStates[0].data.lastError, 'lastError must be persisted');
        assert.equal(publishedStates[0].data.lastError.phase, 'Develop');
        assert.equal(publishedStates[0].data.lastError.message, err.message);
    });

    test('an unhandledRejection is logged and persisted the same way as an uncaughtException', () => {
        const spy = spyOnProcessOn();
        const logLines = [];
        const publishedStates = [];
        let reason;
        try {
            installFatalDiagnosticsGuard({
                log: (msg) => logLines.push(msg),
                publishState: (namespace, data) => publishedStates.push({ namespace, data }),
                phaseOf: () => 'Develop',
            });
            reason = new Error('unhandled rejection mid-Develop');
            spy.getListener('unhandledRejection')(reason);
        } finally {
            spy.restore();
        }

        assert.ok(logLines.some((l) => l.includes('[FATAL]') && l.includes('unhandledRejection')));
        assert.equal(publishedStates.length, 1);
        assert.equal(publishedStates[0].data.terminalReason, 'unhandledRejection');
        assert.equal(publishedStates[0].data.lastError.message, reason.message);
    });

    test('uninstall() removes both listeners via process.off', () => {
        const removed = [];
        const originalOff = process.off.bind(process);
        const spy = spyOnProcessOn();
        process.off = (event, listener) => {
            if (event === 'uncaughtException' || event === 'unhandledRejection') {
                removed.push(event);
                return process;
            }
            return originalOff(event, listener);
        };
        try {
            const uninstall = installFatalDiagnosticsGuard({ log: () => {}, phaseOf: () => null });
            uninstall();
            assert.deepEqual(removed.sort(), ['unhandledRejection', 'uncaughtException'].sort());
        } finally {
            process.off = originalOff;
            spy.restore();
        }
    });

    test('a publishState that itself throws is caught -- the guard never crashes harder than the failure it is reporting', () => {
        const spy = spyOnProcessOn();
        const logLines = [];
        try {
            installFatalDiagnosticsGuard({
                log: (msg) => logLines.push(msg),
                publishState: () => { throw new Error('state backend unavailable'); },
                phaseOf: () => 'Develop',
            });
            assert.doesNotThrow(() => spy.getListener('uncaughtException')(new Error('boom')));
        } finally {
            spy.restore();
        }
        assert.ok(logLines.some((l) => l.includes('[FATAL]')));
        assert.ok(logLines.some((l) => l.includes('failed to persist terminal error state')));
    });

    test('works with no deps at all (log/publishState/phaseOf all optional) -- never throws', () => {
        const spy = spyOnProcessOn();
        try {
            installFatalDiagnosticsGuard();
            assert.doesNotThrow(() => spy.getListener('uncaughtException')(new Error('no deps supplied')));
        } finally {
            spy.restore();
        }
    });
});
