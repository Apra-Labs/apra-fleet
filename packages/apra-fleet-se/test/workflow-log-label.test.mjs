import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FleetWorkflow } from '@apralabs/apra-fleet-workflow';
import { runOnce } from './helpers/mock-sprint-harness.mjs';

// apra-fleet-20i.1.3: end-to-end verification of the apra-fleet-20i.1
// streak -- apra-fleet-20i.1.1 added an optional `logPrefix` constructor arg
// to FleetWorkflow (prepended at the [Workflow Log]/[Dispatch]/[Command]
// console.log sites), and apra-fleet-20i.1.2 threaded each mock-sprint
// scenario's own tag through as that prefix plus an explicit
// '=== END scenario: <tag> (PASS/FAIL) ===' marker at scenario completion
// (see helpers/mock-sprint-harness.mjs's runOnce()). This file asserts the
// three acceptance criteria directly:
//   1. with logPrefix set, both [Workflow Log] and [Dispatch] lines carry it
//   2. an '=== END scenario: <tag> (PASS/FAIL) ===' line is emitted at
//      scenario completion
//   3. with no logPrefix (the default '' case -- the real single-sprint CLI
//      path in bin/cli.mjs), output stays unprefixed (regression guard)

// Captures every console.log call made during `fn()`, restoring the real
// console.log afterward (even if fn() throws) so a failure here can never
// leak a stubbed console.log into later tests in this file/process.
async function captureConsoleLog(fn) {
    const lines = [];
    const originalLog = console.log;
    console.log = (...args) => {
        lines.push(args.map(String).join(' '));
    };
    try {
        const result = await fn();
        return { result, lines };
    } finally {
        console.log = originalLog;
    }
}

test('logPrefix set (mock-sprint scenario tag): [Workflow Log]/[Dispatch] lines carry the prefix, END scenario marker emitted', async () => {
    const tag = 'run1';
    const { result, lines } = await captureConsoleLog(() => runOnce(tag));

    assert.ok(result && result.result && result.result.status === 'success', `expected the run1 mock sprint to succeed, got: ${JSON.stringify(result && result.result)}`);

    // Criterion 1a: [Workflow Log] lines are prefixed.
    const workflowLogLines = lines.filter((l) => l.includes('[Workflow Log]'));
    assert.ok(workflowLogLines.length > 0, `expected at least one [Workflow Log] line to have been logged during runOnce('${tag}'), captured ${lines.length} line(s): ${JSON.stringify(lines.slice(0, 20))}`);
    for (const l of workflowLogLines) {
        assert.ok(l.startsWith(`[${tag}] [Workflow Log]`), `expected [Workflow Log] line to start with the '[${tag}] ' logPrefix, got: ${JSON.stringify(l)}`);
    }

    // Criterion 1b: [Dispatch] lines are prefixed.
    const dispatchLines = lines.filter((l) => l.includes('[Dispatch]'));
    assert.ok(dispatchLines.length > 0, `expected at least one [Dispatch] line to have been logged during runOnce('${tag}'), captured ${lines.length} line(s): ${JSON.stringify(lines.slice(0, 20))}`);
    for (const l of dispatchLines) {
        assert.ok(l.startsWith(`[${tag}] [Dispatch]`), `expected [Dispatch] line to start with the '[${tag}] ' logPrefix, got: ${JSON.stringify(l)}`);
    }

    // Criterion 2: explicit per-scenario END marker at scenario completion.
    const endMarkerRe = new RegExp(`^=== END scenario: ${tag} \\((PASS|FAIL)\\) ===$`);
    const endMarkerLine = lines.find((l) => endMarkerRe.test(l));
    assert.ok(endMarkerLine, `expected an '=== END scenario: ${tag} (PASS/FAIL) ===' line, captured tail: ${JSON.stringify(lines.slice(-10))}`);
    assert.match(endMarkerLine, /\(PASS\)/, `expected the END scenario marker to report PASS for a successful run, got: ${JSON.stringify(endMarkerLine)}`);
});

test('default logPrefix ("" -- no third constructor arg): [Workflow Log] output is unprefixed (regression guard)', async () => {
    // Mirrors the real single-sprint CLI path (bin/cli.mjs), which
    // constructs `new FleetWorkflow(fleetApi)` with no third arg -- direct
    // wf.log() calls outside executeFile()/runWithContext() are the
    // documented unit-test pattern for FleetWorkflow (see the _store()
    // doc comment in packages/apra-fleet-workflow/src/workflow/index.mjs).
    const workflow = new FleetWorkflow({}, {});
    assert.strictEqual(workflow.logPrefix, '', `expected the default logPrefix to be the empty string, got: ${JSON.stringify(workflow.logPrefix)}`);

    const { lines } = await captureConsoleLog(() => {
        workflow.log('plain message, no scenario label');
    });

    assert.strictEqual(lines.length, 1, `expected exactly one console.log call, got: ${JSON.stringify(lines)}`);
    assert.strictEqual(lines[0], '[Workflow Log] plain message, no scenario label', `expected unprefixed [Workflow Log] output when logPrefix is unset, got: ${JSON.stringify(lines[0])}`);
});
