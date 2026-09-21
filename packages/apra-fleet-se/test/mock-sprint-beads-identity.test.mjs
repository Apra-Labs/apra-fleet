import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { BeadsIdentityError } from '../fleet-sprint/errors.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// The beads identity precondition, end to end through the real runner.js:
// every member is asked `bd where --json` / `bd config get sync.remote
// --json` / `git remote get-url origin` BEFORE the first mutating bd
// command, and the sprint aborts (with no bd mutation at all) when a member
// resolves to a different beads database than expected.
//
// Default harness answers: `bd where` is synthesized from the shared tempDir
// (bd-replay.mjs), sync.remote is unset, origin is the harness's originUrl --
// one consistent identity for every member. The `beadsIdentity` option
// overrides single probes for single members.
// =============================================================================

const MUTATING_BD = /^bd (update|close|create|dolt push|note|dep)\b/;

const approvedReviewer = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});

test('mock sprint: all members share one beads identity -> sprint proceeds and logs a "beads ok:" line per member', async () => {
    await withScenarioMarkers('beadsid-ok', async () => {
        const r = await runDevelopLoopScenario('beadsid-ok', {
            members: ['orch', 'm2'],
            taskSpecs: [{ title: 'Task: identity ok' }],
            reviewerHandler: approvedReviewer,
        });
        check(r.error === null, `expected the sprint to proceed, got error: ${r.error && r.error.message}`);
        check(r.result && r.result.status === 'success', `expected a successful run, got ${JSON.stringify(r.result)}`);
        const okLines = r.logs.filter((l) => l.startsWith('beads ok: '));
        check(okLines.length === 2, `expected one "beads ok:" line per member, got: ${JSON.stringify(okLines)}`);
        check(okLines[0].startsWith('beads ok: orch beads: ') && /prefix=mock/.test(okLines[0]), `orchestrator line: ${okLines[0]}`);
        check(okLines[1].startsWith('beads ok: m2 beads: '), `second member line: ${okLines[1]}`);
        // No --expect-beads: the expectation is taken from the orchestrator.
        check(r.logs.some((l) => l.includes("taking the expectation from the orchestrator member 'orch'")), 'expected the orchestrator-derived expectation log line');
        // The probes run first, orchestrator first, and precede every mutating bd command.
        const first = r.commandLogDetailed.slice(0, 6);
        check(first[0].command === 'bd where --json' && first[0].member === 'orch', `expected the orchestrator's bd where first, got ${JSON.stringify(first[0])}`);
        check(first[3].command === 'bd where --json' && first[3].member === 'm2', `expected m2's bd where fourth, got ${JSON.stringify(first[3])}`);
        const firstMutating = r.commandLog.findIndex((c) => MUTATING_BD.test(c));
        check(firstMutating === -1 || firstMutating >= 6, `a mutating bd command preceded the identity probes: ${JSON.stringify(r.commandLog.slice(0, 8))}`);
        // Published on sprint state under its own namespace, for the viewer.
        const published = r.states.find((s) => s.namespace === 'beadsIdentity' || (s.payload && s.payload.namespace === 'beadsIdentity'));
        check(published, `expected a beadsIdentity state publish, got namespaces: ${JSON.stringify(r.states.map((s) => s.namespace || (s.payload && s.payload.namespace)))}`);
        const data = published.data || (published.payload && published.payload.data);
        check(data && data.expectedFrom === 'orchestrator' && data.members && data.members.orch && data.members.m2, `unexpected beadsIdentity state shape: ${JSON.stringify(data)}`);
        check(data.members.m2.prefix === 'mock' && /\.beads$/.test(data.members.m2.beadsDir), `unexpected member identity: ${JSON.stringify(data.members.m2)}`);
    });
});

test('mock sprint: one member with a different repoRemote -> sprint aborts before any mutating bd command', async () => {
    await withScenarioMarkers('beadsid-mismatch', async () => {
        const r = await runDevelopLoopScenario('beadsid-mismatch', {
            members: ['orch', 'm2'],
            taskSpecs: [{ title: 'Task: identity mismatch' }],
            reviewerHandler: approvedReviewer,
            beadsIdentity: { m2: { repoRemote: 'https://github.com/other-org/other-repo.git' } },
        });
        check(r.error instanceof BeadsIdentityError, `expected a BeadsIdentityError abort, got: ${r.error && (r.error.constructor.name + ': ' + r.error.message)}`);
        check(r.error.reason === 'MISMATCH' && r.error.member === 'm2', `expected a MISMATCH on m2, got reason=${r.error.reason} member=${r.error.member}`);
        check(/repoRemote: expected 'https:\/\/github\.com\/mock-org\/mock-repo\.git', actual 'https:\/\/github\.com\/other-org\/other-repo\.git'/.test(r.error.message), `expected field/expected/actual in the message, got: ${r.error.message}`);
        const mutating = r.commandLog.filter((c) => MUTATING_BD.test(c));
        check(mutating.length === 0, `expected NO mutating bd command after the abort, got: ${JSON.stringify(mutating)}`);
        check(r.dispatched.length === 0, `expected no agent dispatch after the abort, got ${r.dispatched.length}`);
        // The orchestrator still passed; m2 never got a "beads ok:" line.
        check(r.logs.some((l) => l.startsWith('beads ok: orch ')), 'expected the orchestrator "beads ok:" line');
        check(!r.logs.some((l) => l.startsWith('beads ok: m2 ')), 'm2 must not be reported ok');
        // The abort reason reaches the terminal sprint state record.
        const terminal = r.states.find((s) => (s.namespace || (s.payload && s.payload.namespace)) === 'terminal');
        check(terminal, `expected a terminal state record, got namespaces: ${JSON.stringify(r.states.map((s) => s.namespace || (s.payload && s.payload.namespace)))}`);
        check(JSON.stringify(terminal).includes('Beads identity check failed'), `terminal record must carry the abort reason: ${JSON.stringify(terminal).slice(0, 400)}`);
    });
});

test('mock sprint: bd where failing on a member -> abort naming that member, no mutating bd command', async () => {
    await withScenarioMarkers('beadsid-nowhere', async () => {
        const r = await runDevelopLoopScenario('beadsid-nowhere', {
            members: ['orch', 'm2'],
            taskSpecs: [{ title: 'Task: identity probe failure' }],
            reviewerHandler: approvedReviewer,
            beadsIdentity: { m2: { where: { fail: 'Error: no beads database found. Hint: run bd init' } } },
        });
        check(r.error instanceof BeadsIdentityError, `expected a BeadsIdentityError abort, got: ${r.error && (r.error.constructor.name + ': ' + r.error.message)}`);
        check(r.error.reason === 'PROBE_FAILED' && r.error.member === 'm2', `expected PROBE_FAILED on m2, got reason=${r.error.reason} member=${r.error.member}`);
        check(/member 'm2'/.test(r.error.message) && /no beads database found/.test(r.error.message), `expected the member and raw output in the message, got: ${r.error.message}`);
        check(r.commandLog.filter((c) => MUTATING_BD.test(c)).length === 0, 'expected NO mutating bd command');
        check(r.dispatched.length === 0, 'expected no agent dispatch');
    });
});

test('mock sprint: --expect-beads supplied and matching every member -> proceeds with the supplied expectation', async () => {
    await withScenarioMarkers('beadsid-expected', async () => {
        const expectBeads = JSON.stringify({ beadsDir: '', prefix: 'mock', syncRemote: '', repoRemote: 'https://github.com/mock-org/mock-repo.git' });
        const r = await runDevelopLoopScenario('beadsid-expected', {
            members: ['orch'],
            taskSpecs: [{ title: 'Task: identity expected' }],
            reviewerHandler: approvedReviewer,
            expectBeads,
        });
        check(r.error === null, `expected the sprint to proceed, got error: ${r.error && r.error.message}`);
        check(!r.logs.some((l) => l.includes('taking the expectation from the orchestrator')), 'the supplied expectation must be used, not the orchestrator-derived one');
        check(r.logs.some((l) => l.startsWith('beads ok: orch ')), 'expected the orchestrator "beads ok:" line');
    });
});

test('mock sprint: --expect-beads supplied and the ORCHESTRATOR itself differs -> abort naming the orchestrator', async () => {
    await withScenarioMarkers('beadsid-expected-mismatch', async () => {
        const expectBeads = JSON.stringify({ beadsDir: '', prefix: 'another-project', syncRemote: '', repoRemote: 'https://github.com/mock-org/mock-repo.git' });
        const r = await runDevelopLoopScenario('beadsid-expected-mismatch', {
            members: ['orch'],
            taskSpecs: [{ title: 'Task: identity expected mismatch' }],
            reviewerHandler: approvedReviewer,
            expectBeads,
        });
        check(r.error instanceof BeadsIdentityError && r.error.member === 'orch', `expected a BeadsIdentityError on the orchestrator, got: ${r.error && r.error.message}`);
        check(/prefix: expected 'another-project', actual 'mock'/.test(r.error.message), `expected the prefix mismatch in the message, got: ${r.error.message}`);
        check(r.commandLog.filter((c) => MUTATING_BD.test(c)).length === 0, 'expected NO mutating bd command');
    });
});
