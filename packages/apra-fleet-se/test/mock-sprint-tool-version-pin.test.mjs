import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { BeadsIdentityError, BEADS_IDENTITY_FAILURE_REASONS } from '../fleet-sprint/errors.mjs';
import { BEADS_VERSION, DOLT_VERSION } from '../fleet-sprint/tool-version-pin.mjs';

// =============================================================================
// The sprint-start bd/dolt version pin, end to end through the real runner.js:
// before ANY beads mutation on ANY member (member beads set-up, the first
// D-pull), every beads-touching member answers `bd --version` and
// `dolt version`; a bd outside the pinned major.minor (newer or older) stops
// the sprint naming every offending member, with zero dispatches and no
// bootstrap / config set / dolt remote / dolt pull / dolt push anywhere.
//
// Default harness answers (bd-replay.mjs): every member reports the engine's
// own pins. The harness `beadsIdentity` option overrides one member's
// `bdVersion` / `doltVersion` answer. No real bd remote is touched.
// =============================================================================

const escapeRe = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const check = (cond, msg) => assert.ok(cond, msg);
const PIN_MM = BEADS_VERSION.split('.').slice(0, 2).join('.');
const PIN_DOLT = DOLT_VERSION.replace(/^v/, '');

// Every beads set-up or sync command that must never reach a member once a
// version mismatch is known.
const SETUP_OR_SYNC = /^(?:[^\s=]+=\S+\s+)*bd (?:bootstrap|config set|dolt remote|dolt pull|dolt push)\b/;

const approvedReviewer = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});

function terminalText(r) {
    const terminal = r.states.find((s) => (s.namespace || (s.payload && s.payload.namespace)) === 'terminal');
    return terminal ? JSON.stringify(terminal) : '';
}

function assertStoppedAtPreflight(r, { member, found }) {
    check(r.error instanceof BeadsIdentityError, `expected a BeadsIdentityError abort, got: ${r.error && (r.error.constructor.name + ': ' + r.error.message)}`);
    check(r.error.reason === BEADS_IDENTITY_FAILURE_REASONS.VERSION_MISMATCH, `expected VERSION_MISMATCH, got ${r.error.reason}: ${r.error.message}`);
    check(r.error.member === member, `expected the offending member '${member}', got '${r.error.member}'`);
    const line = new RegExp(`member '${escapeRe(member)}': bd ${escapeRe(found)}, expected bd ${escapeRe(PIN_MM)}\\.x`);
    check(line.test(r.error.message), `expected member/found/expected in the message, got: ${r.error.message}`);
    check(/To fix: install the pinned bd/.test(r.error.message) && /relaunch/.test(r.error.message), `expected the fix in the message, got: ${r.error.message}`);
    // The failure is published on the terminal sprint record.
    const terminal = terminalText(r);
    check(terminal.includes(`member '${member}': bd ${found}`), `terminal record must carry the failure, got: ${terminal.slice(0, 400)}`);
    // Nothing after the probes: no set-up, no sync, no dispatch.
    const bad = r.commandLog.filter((c) => SETUP_OR_SYNC.test(c));
    check(bad.length === 0, `expected NO beads set-up or sync command on any member, got: ${JSON.stringify(bad)}`);
    check(r.dispatched.length === 0, `expected no role dispatch, got ${r.dispatched.length}`);
    // The version probes are the first commands of the run.
    const first = r.commandLog.filter((c) => !/\.apra-fleet[\/]bin[\/]dolt/.test(c)).slice(0, 2);
    check(first[0] === 'bd --version' && first[1] === 'dolt version', `expected the version probes first, got ${JSON.stringify(r.commandLog.slice(0, 4))}`);
}

test('mock sprint: the doer member runs bd 1.4.0 -> VERSION_MISMATCH before any beads mutation or dispatch', async () => {
    await withScenarioMarkers('toolpin-newer', async () => {
        const r = await runDevelopLoopScenario('toolpin-newer', {
            members: ['orch', 'm2'],
            roleMap: { backlog: ['orch'], doer: ['m2'] },
            taskSpecs: [{ title: 'Task: newer bd on the doer' }],
            reviewerHandler: approvedReviewer,
            beadsIdentity: { orch: { bdVersion: 'bd version 1.3.0 (abc)' }, m2: { bdVersion: 'bd version 1.4.0 (abc)' } },
        });
        assertStoppedAtPreflight(r, { member: 'm2', found: '1.4.0' });
        check(!/member 'orch': /.test(r.error.message), `the backlog member is on the pin and must not be named: ${r.error.message}`);
        check(!r.logs.some((l) => l.startsWith('beads ok: ')), 'no identity was accepted after the version failure');
    });
});

test('mock sprint: the doer member runs bd 1.2.0 -> the same failure (minimum enforced)', async () => {
    await withScenarioMarkers('toolpin-older', async () => {
        const r = await runDevelopLoopScenario('toolpin-older', {
            members: ['orch', 'm2'],
            roleMap: { backlog: ['orch'], doer: ['m2'] },
            taskSpecs: [{ title: 'Task: older bd on the doer' }],
            reviewerHandler: approvedReviewer,
            beadsIdentity: { m2: { bdVersion: 'bd version 1.2.0' } },
        });
        assertStoppedAtPreflight(r, { member: 'm2', found: '1.2.0' });
    });
});

test('mock sprint: a member mapped only to the reviewer role on bd 1.4.0 is caught too', async () => {
    await withScenarioMarkers('toolpin-reviewer', async () => {
        const r = await runDevelopLoopScenario('toolpin-reviewer', {
            members: ['orch', 'm2', 'm3'],
            roleMap: { backlog: ['orch'], doer: ['m2'], reviewer: ['m3'] },
            taskSpecs: [{ title: 'Task: newer bd on the reviewer' }],
            reviewerHandler: approvedReviewer,
            beadsIdentity: { m3: { bdVersion: 'bd version 1.4.0' } },
        });
        assertStoppedAtPreflight(r, { member: 'm3', found: '1.4.0' });
        // Every member was asked before the failure (the reviewer is not the backlog member).
        for (const m of ['orch', 'm2', 'm3']) {
            check(r.commandLogDetailed.some((c) => c.member === m && c.command === 'bd --version'), `expected 'bd --version' on ${m}`);
        }
    });
});

test('mock sprint: every member on bd 1.3.x and dolt 2.2.x -> the sprint proceeds past the preflight as the happy path does', async () => {
    await withScenarioMarkers('toolpin-ok', async () => {
        const r = await runDevelopLoopScenario('toolpin-ok', {
            members: ['orch', 'm2'],
            roleMap: { backlog: ['orch'], doer: ['m2'] },
            taskSpecs: [{ title: 'Task: pinned versions' }],
            reviewerHandler: approvedReviewer,
            beadsIdentity: { m2: { bdVersion: 'bd version 1.3.9 (dev)', doltVersion: `dolt version ${PIN_DOLT.replace(/\.\d+$/, '.7')}` } },
        });
        check(r.error === null, `expected the sprint to proceed, got error: ${r.error && (r.error.constructor.name + ': ' + r.error.message)}`);
        check(r.result && r.result.status === 'success', `expected a successful run, got ${JSON.stringify(r.result)}`);
        check(r.logs.some((l) => l === `[beads-identity] tool versions ok: m2 bd 1.3.9, dolt ${PIN_DOLT.replace(/\.\d+$/, '.7')}`), `expected the versions-ok line for m2, got: ${JSON.stringify(r.logs.filter((l) => l.includes('tool versions')))}`);
        check(r.logs.filter((l) => l.startsWith('beads ok: ')).length === 2, 'expected one "beads ok:" line per member');
        check(r.dispatched.length > 0, 'the sprint dispatched after the preflight');
    });
});
