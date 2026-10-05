import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, mockCmdResult } from './helpers/mock-sprint-harness.mjs';
import { BeadsIdentityError } from '../fleet-sprint/errors.mjs';
import { noteMemberCommand } from '../fleet-sprint/dolt-sync.mjs';

// DoltSync memoizes each member's sync.remote answer for the process
// lifetime. The set-up scenarios answer it as CONFIGURED, so drop both
// members' memos afterwards (through the same seam a real `bd config set`
// hits) or the next scenario in this file inherits them.
function forgetScenarioSyncState() {
    for (const m of ['orch', 'm2']) noteMemberCommand(m, 'bd config set sync.remote');
}

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// The beads identity precondition, end to end through the real runner.js:
// every member is asked `bd where --json` / `bd config get sync.remote
// --json` / `git remote get-url origin` BEFORE the first mutating bd
// command, and the sprint aborts (with no bd mutation at all) when a member
// resolves to a DIFFERENT beads database than expected. A member whose
// probe fails is a logged warning instead: the sprint proceeds and the
// first real bd on that member surfaces the problem.
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
        check(okLines[0].startsWith('beads ok: orch beads: ') && okLines[0].includes(`prefix=${r.dbPrefix}`), `orchestrator line (expected prefix=${r.dbPrefix}): ${okLines[0]}`);
        check(r.dbPrefix, 'harness must report the created DB prefix');
        check(okLines[1].startsWith('beads ok: m2 beads: '), `second member line: ${okLines[1]}`);
        // No --expect-beads: the expectation is taken from the orchestrator.
        check(r.logs.some((l) => l.includes("taking the expectation from the backlog member 'orch'")), 'expected the orchestrator-derived expectation log line');
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
        check(data && data.expectedFrom === 'backlog' && data.members && data.members.orch && data.members.m2, `unexpected beadsIdentity state shape: ${JSON.stringify(data)}`);
        check(data.members.m2.prefix === r.dbPrefix && /\.beads$/.test(data.members.m2.beadsDir), `unexpected member identity: ${JSON.stringify(data.members.m2)}`);
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

// A beads-reading member with no beads database used to be a WARNING
// followed by dispatches whose `bd show <root>` found nothing. It is now set
// up from the expected beads remote before any dispatch, or the sprint
// stops at preflight with BEADS_SETUP_FAILED.
test('mock sprint: beads-reading member with no beads DB and no expected beads remote -> BEADS_SETUP_FAILED at preflight, zero dispatches', async () => {
    await withScenarioMarkers('beadsid-nowhere', async () => {
        const r = await runDevelopLoopScenario('beadsid-nowhere', {
            members: ['orch', 'm2'],
            taskSpecs: [{ title: 'Task: identity probe failure' }],
            reviewerHandler: approvedReviewer,
            beadsIdentity: { m2: { where: { fail: 'Error: no beads database found. Hint: run bd init' } } },
        });
        check(r.error instanceof BeadsIdentityError, `expected a BeadsIdentityError abort, got: ${r.error && (r.error.constructor.name + ': ' + r.error.message)}`);
        check(r.error.reason === 'BEADS_SETUP_FAILED' && r.error.member === 'm2', `expected BEADS_SETUP_FAILED on m2, got reason=${r.error.reason} member=${r.error.member}`);
        check(/member 'm2' reports no beads database in its workFolder \('bd where --json' -> .*no beads database found/.test(r.error.message), `expected member + cause, got: ${r.error.message}`);
        check(/no expected beads remote to set one up from/.test(r.error.message) && /To fix: /.test(r.error.message), `expected cause + fix, got: ${r.error.message}`);
        check(r.dispatched.length === 0, `expected no agent dispatch, got ${r.dispatched.length}`);
        check(r.commandLog.filter((c) => MUTATING_BD.test(c)).length === 0, 'expected NO mutating bd command');
    });
});

// Answers the identity probes for a member whose beads DB appears only once
// `bd bootstrap --yes` ran on it; `bd config get sync.remote` reports the
// expected remote for the backlog member and, after `bd config set`, for m2.
// Mirrors bd 1.3: `bd config set` fails until .beads/config.yaml exists (the
// engine creates it with a per-shell command first).
function isEnsureWorkspaceCommand(cmd) {
    const m = /^powershell -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(cmd);
    const text = m ? Buffer.from(m[1], 'base64').toString('utf16le') : cmd;
    return text.includes('.beads/config.yaml') && !/^bd\b/.test(text);
}

// The engine's per-shell write of the sync remote into the untracked
// .beads/config.local.yaml layer.
function isEnsureLocalConfigCommand(cmd) {
    const m = /^powershell -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(cmd);
    const text = m ? Buffer.from(m[1], 'base64').toString('utf16le') : cmd;
    return text.includes('.beads/config.local.yaml') && !/^bd\b/.test(text);
}

function noDbMemberOnCommand({ remote, setupLog, bootstrapResult }) {
    const st = { sync: '', hasDb: false, ws: false };
    return async ({ command, member_name: member }) => {
        const cmd = String(command || '').trim();
        if (member === 'orch' && /^bd config get sync\.remote( --json)?$/.test(cmd)) {
            return mockCmdResult(0, JSON.stringify({ key: 'sync.remote', value: remote }), '');
        }
        if (member !== 'm2') return undefined;
        if (isEnsureWorkspaceCommand(cmd)) { setupLog.push('ensure-workspace'); st.ws = true; return mockCmdResult(0, '', ''); }
        if (isEnsureLocalConfigCommand(cmd)) { setupLog.push('ensure-local-sync-remote'); return mockCmdResult(0, '', ''); }
        if (/^bd (config set|bootstrap|dolt pull)\b/.test(cmd)) setupLog.push(cmd);
        if (cmd === `bd config set sync.remote ${remote}`) {
            if (!st.ws) return mockCmdResult(1, '', "Error: setting config: no .beads/config.yaml found (run 'bd init' first)");
            st.sync = remote;
            return mockCmdResult(0, '', '');
        }
        if (cmd === 'bd bootstrap --dry-run --json') {
            return mockCmdResult(0, JSON.stringify({ action: 'sync', has_existing: false, sync_remote: st.sync }), '');
        }
        if (cmd === 'bd bootstrap --yes') {
            if (bootstrapResult) return bootstrapResult();
            st.hasDb = true;
            return mockCmdResult(0, 'Bootstrapped.', '');
        }
        if (/^bd where( --json)?$/.test(cmd) && !st.hasDb) {
            return mockCmdResult(1, '', JSON.stringify({ error: 'no_beads_directory', message: 'No active beads workspace found.' }));
        }
        if (/^bd config get sync\.remote( --json)?$/.test(cmd)) {
            return mockCmdResult(0, JSON.stringify({ key: 'sync.remote', value: st.sync }), '');
        }
        return undefined;
    };
}

test('mock sprint: beads-reading member with no beads DB -> set up from the expected beads remote before any dispatch, re-verified, sprint proceeds', async (t) => {
    t.after(forgetScenarioSyncState);
    await withScenarioMarkers('beadsid-setup', async () => {
        const remote = 'https://github.com/mock-org/mock-repo.git';
        const setupLog = [];
        const r = await runDevelopLoopScenario('beadsid-setup', {
            members: ['orch', 'm2'],
            taskSpecs: [{ title: 'Task: member beads set-up' }],
            reviewerHandler: approvedReviewer,
            // The DB's own prefix: 'mock' under replay, template-derived on the real-bd lane (#634 function form).
            expectBeads: ({ prefix }) => JSON.stringify({ beadsDir: '', prefix: prefix ?? 'mock', syncRemote: remote, repoRemote: remote }),
            onCommand: noDbMemberOnCommand({ remote, setupLog }),
        });
        check(r.error === null, `expected the sprint to proceed, got error: ${r.error && (r.error.constructor.name + ': ' + r.error.message)}`);
        check(r.result && r.result.status === 'success', `expected a successful run, got ${JSON.stringify(r.result)}`);
        check(JSON.stringify(setupLog.slice(0, 5)) === JSON.stringify(['ensure-workspace', 'ensure-local-sync-remote', `bd config set sync.remote ${remote}`, 'bd bootstrap --dry-run --json', 'bd bootstrap --yes']),
            `expected the set-up commands on m2, got: ${JSON.stringify(setupLog)}`);
        // Issued through the runner's command() wrapper, before any dispatch or mutating bd.
        const bootIdx = r.commandLog.indexOf('bd bootstrap --yes');
        check(bootIdx >= 0, 'bootstrap must go through the command() path');
        const firstMutating = r.commandLog.findIndex((c) => MUTATING_BD.test(c));
        check(firstMutating === -1 || firstMutating > bootIdx, 'set-up must precede every mutating bd command');
        check(r.logs.some((l) => l.includes("member 'm2' has no beads database in its workFolder; setting it up from the expected beads remote")), 'expected the set-up log line');
        check(r.logs.some((l) => l.startsWith('beads ok: m2 ')), 'expected m2 re-verified ok');
        const published = r.states.find((s) => s.namespace === 'beadsIdentity' || (s.payload && s.payload.namespace === 'beadsIdentity'));
        const data = published && (published.data || (published.payload && published.payload.data));
        check(data && Array.isArray(data.setUp) && data.setUp.includes('m2'), `expected m2 in the published setUp list, got: ${JSON.stringify(data && data.setUp)}`);
        check(r.dispatched.length > 0, 'the sprint dispatched after the set-up');
    });
});

test('mock sprint: beads set-up failure on a member -> typed BEADS_SETUP_FAILED at preflight, zero dispatches', async (t) => {
    t.after(forgetScenarioSyncState);
    await withScenarioMarkers('beadsid-setup-fail', async () => {
        const remote = 'https://github.com/mock-org/mock-repo.git';
        const setupLog = [];
        const r = await runDevelopLoopScenario('beadsid-setup-fail', {
            members: ['orch', 'm2'],
            taskSpecs: [{ title: 'Task: member beads set-up failure' }],
            reviewerHandler: approvedReviewer,
            // The DB's own prefix: 'mock' under replay, template-derived on the real-bd lane (#634 function form).
            expectBeads: ({ prefix }) => JSON.stringify({ beadsDir: '', prefix: prefix ?? 'mock', syncRemote: remote, repoRemote: remote }),
            onCommand: noDbMemberOnCommand({ remote, setupLog, bootstrapResult: () => mockCmdResult(1, '', 'fatal: Authentication failed') }),
        });
        check(r.error instanceof BeadsIdentityError, `expected a BeadsIdentityError abort, got: ${r.error && (r.error.constructor.name + ': ' + r.error.message)}`);
        check(r.error.reason === 'BEADS_SETUP_FAILED' && r.error.member === 'm2', `expected BEADS_SETUP_FAILED on m2, got reason=${r.error.reason} member=${r.error.member}`);
        check(/could not bootstrap its beads from 'https:\/\/github\.com\/mock-org\/mock-repo\.git'.*Authentication failed/.test(r.error.message), `expected cause in message: ${r.error.message}`);
        check(r.dispatched.length === 0, `expected no agent dispatch, got ${r.dispatched.length}`);
        check(r.commandLog.filter((c) => MUTATING_BD.test(c)).length === 0, 'expected NO mutating bd command');
    });
});

test('mock sprint: --expect-beads supplied and matching every member -> proceeds with the supplied expectation', async () => {
    await withScenarioMarkers('beadsid-expected', async () => {
        // Prefix is the created DB's own (fixed 'mock' under replay, bd-derived under real bd).
        const expectBeads = ({ prefix }) => JSON.stringify({ beadsDir: '', prefix, syncRemote: '', repoRemote: 'https://github.com/mock-org/mock-repo.git' });
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
        check(new RegExp(`prefix: expected 'another-project', actual '${r.dbPrefix}'`).test(r.error.message), `expected the prefix mismatch in the message, got: ${r.error.message}`);
        check(r.commandLog.filter((c) => MUTATING_BD.test(c)).length === 0, 'expected NO mutating bd command');
    });
});
