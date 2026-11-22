// =============================================================================
// End-to-end guard: a backlog D-pull issued with a Windows env prefix must
// drop the shared full-DB beads snapshot.
//
// The backlog member is a Windows member with a Git Bash shell, so every bd
// sync command goes out as `GOMAXPROCS=1 bd dolt pull` / `... push`
// (bd-sync-command.mjs). The integ-test-runner runs on its own member: in
// Integ Test C1 it closes one verify-routed feature and files an open P1 gap
// bug under the other. Those writes reach the backlog clone only through the
// backlog D-pull at Cycle Evaluation (modeled below: until that pull, the
// integ writes are queued and NOT in the shared bd DB).
//
// Before the fix the prefixed D-pull was classified as "not a bd command", so
// the snapshot fetched before it survived: Cycle 1 evaluation counted no open
// gap bug, and Route C2 re-routed both the already-closed feature and the
// parent with an open child to verify.
//
// Asserted:
//   - the backlog D-pull really was issued with the gitbash prefix;
//   - Cycle 1 evaluation counts the open gap bug at/above goal priority;
//   - the Route C2 line (if any) names neither the closed feature nor the
//     parent with the open gap bug.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool, MOCK_WINDOWS_MEMBER_WORK_FOLDER,
} from './helpers/mock-sprint-harness.mjs';
import { invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures } from '../fleet-sprint/dolt-sync.mjs';
import { clearMemberOsCache } from '../fleet-sprint/runner.js';

const BACKLOG_MEMBER = 'local';
const INTEG_MEMBER = 'integ';
const SYNC_REMOTE = 'git+https://example.invalid/org/beads.git';
const LS_REMOTE_RE = / ls-remote https:\/\/example\.invalid\/org\/beads\.git refs\/dolt\/data$/;
const PREFIX_RE = /^GOMAXPROCS=1 /;

const exit0 = (stdout = '') => ({
    content: [{ type: 'text', text: `Exit code: 0\n${stdout}` }],
    structuredContent: { exitCode: 0, stdout, stderr: '' },
});
const report = (obj) => ({ content: [{ text: JSON.stringify(obj) }] });
const assignedIds = (prompt) => {
    const match = prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};
const verifyIdsOf = (prompt) => {
    // Ids carry dots (parent.child), so stop at the sentence's '. ' not at any '.'.
    const match = prompt.match(/verification-closure:\s*(.+?)\.\s/);
    return match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
};

test('a gitbash backlog member: after Integ Test closes a verify bead and files a gap bug, Route C2 re-routes neither', { timeout: 300000 }, async () => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
    clearMemberOsCache();
    await withScenarioMarkers('prefixed dpull snapshot', async () => {
        const state = { tip: 'a'.repeat(40), minted: 0, phase: null, pulls: [], pending: [], applied: false, phases: [] };
        let features = null; // { closeMe, gapParent } -- created in beforeSprint
        let gapId = null;
        let runCmdRef = null;
        let tempDirRef = null;

        // One shared Dolt remote. The integ member's writes are queued and
        // land in the shared bd DB only when the BACKLOG member D-pulls.
        const onCommand = async ({ command, member_name: member }) => {
            const logical = command.replace(PREFIX_RE, '');
            if (/^bd config get sync\.remote/.test(logical)) return exit0(JSON.stringify({ key: 'sync.remote', value: SYNC_REMOTE }));
            if (LS_REMOTE_RE.test(command)) return exit0(`${state.tip}\trefs/dolt/data\n`);
            if (logical === 'bd dolt pull') {
                state.pulls.push({ member, phase: state.phase, command });
                if (member === BACKLOG_MEMBER && state.pending.length > 0) {
                    const queued = state.pending.splice(0);
                    for (const apply of queued) await apply();
                    state.applied = true;
                }
                return exit0('Pull complete.\n');
            }
            if (logical === 'bd vc status --json') return exit0(JSON.stringify({ branch: 'main', commit: 'x', schema_version: 1 }));
            if (logical === 'bd diff remotes/origin/main main --json') return exit0(JSON.stringify([{ IssueID: 'mock-1', DiffType: 'modified' }]));
            if (logical === 'bd dolt push') {
                state.minted += 1;
                state.tip = String(state.minted).padStart(40, '0');
                return exit0('Push complete.\n');
            }
            return undefined;
        };

        // The backlog member is Windows + Git Bash; the integ member is Linux.
        const callToolFactory = (executeCommand) => {
            const base = defaultMockCallTool({ executeCommand });
            return async (name, toolArgs) => {
                if (name === 'member_detail' && toolArgs && toolArgs.member_name === BACKLOG_MEMBER) {
                    return { content: [{ text: JSON.stringify({ vcsProvider: 'github', folder: MOCK_WINDOWS_MEMBER_WORK_FOLDER, os: 'windows', shell: 'gitbash' }) }] };
                }
                return base(name, toolArgs);
            };
        };

        const closingDoer = async ({ opts, runCmd: rc, tempDir: td }) => {
            const ids = assignedIds(opts.prompt);
            for (const id of ids) await rc(`bd close ${id} --reason "Done"`, td);
            return report({ status: 'VERIFY', closedIds: ids, notes: 'Closed.' });
        };

        let integPasses = 0;
        const integHandler = async ({ opts }) => {
            const ids = verifyIdsOf(opts.prompt);
            if (!features || !ids.includes(features.closeMe) || !ids.includes(features.gapParent) || integPasses > 0) {
                return report({ featuresClosed: 0, issuesCreated: 0, passed: true, bugsFiled: [], summary: 'Nothing new to verify.' });
            }
            integPasses++;
            // Filed on the integ member's own clone: the id is known now, the
            // backlog sees the bead only after its next D-pull.
            const out = await runCmdRef(`bd create -t bug "Gap: verification of the second feature still fails" -d "Gap found by integration test." -p 1 --parent ${features.gapParent} --silent`, tempDirRef);
            gapId = String(out.stdout || '').trim();
            // The integ member's writes are not on the backlog clone until it
            // D-pulls. A real id is needed now (bugsFiled), so the gap is
            // created here but parked as closed -- invisible as open work --
            // and the pull "delivers" it by reopening it, together with the
            // close of the verified feature.
            await runCmdRef(`bd update ${gapId} --status=closed`, tempDirRef);
            state.pending.push(async () => {
                await runCmdRef(`bd close ${features.closeMe} --reason "Verified against the deployed build."`, tempDirRef);
                await runCmdRef(`bd update ${gapId} --status=open`, tempDirRef);
            });
            return report({
                featuresClosed: 1, issuesCreated: 1, passed: false, bugsFiled: [gapId],
                verifySetClosed: [features.closeMe],
                verifySetLeftOpen: [{ id: features.gapParent, reason: `gap bug ${gapId} filed` }],
                summary: `Verified ${features.closeMe}; ${features.gapParent} failed, filed ${gapId}.`,
            });
        };

        const run = await runDevelopLoopScenario('pfxdpull', {
            members: [BACKLOG_MEMBER, INTEG_MEMBER],
            roleMap: { backlog: [BACKLOG_MEMBER], 'integ-test-runner': [INTEG_MEMBER] },
            taskSpecs: [{ title: 'Task: open leaf work for cycle one', priority: 'P1' }],
            withRunbooks: true,
            maxCycles: 2,
            goal: 'P1/P2',
            onCommand,
            onWorkflow: (workflow) => { workflow.on('phase', (title) => { state.phase = String(title); state.phases.push(String(title)); }); },
            callToolFactory,
            doerHandler: closingDoer,
            reviewerHandler: async () => report({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }),
            finalReviewHandler: async () => report({ verdict: 'PASS', notes: 'Rubber-stamp PASS.' }),
            integHandler,
            beforeSprint: async ({ tempDir, runCmd, epicBead }) => {
                runCmdRef = runCmd;
                tempDirRef = tempDir;
                const mk = async (title, parent, type) => String((await runCmd(`bd create -t ${type} "${title}" -d "Scenario bead." -p 1 --parent ${parent} --silent`, tempDir)).stdout || '').trim();
                const closeMe = await mk('Feature: verified by integ in cycle one', epicBead.id, 'feature');
                const gapParent = await mk('Feature: gets a gap bug in cycle one', epicBead.id, 'feature');
                for (const parent of [closeMe, gapParent]) {
                    const child = await mk(`Task: done child of ${parent}`, parent, 'task');
                    await runCmd(`bd close ${child} --reason "Done before the sprint"`, tempDir);
                }
                features = { closeMe, gapParent };
            },
        });

        const logs = run.logs;
        const dump = () => logs.filter((l) => /Route C|evaluation|D-pull|\[Dolt\]/.test(l)).join('\n');

        assert.ok(features, 'beforeSprint created the verify features');
        assert.equal(integPasses, 1, `the integ runner verified both features once:\n${dump()}`);
        assert.ok(state.applied, 'the integ writes reached the backlog through its D-pull');
        const backlogPulls = state.pulls.filter((p) => p.member === BACKLOG_MEMBER);
        assert.ok(backlogPulls.length > 0 && backlogPulls.every((p) => PREFIX_RE.test(p.command)),
            `every backlog D-pull carries the gitbash GOMAXPROCS prefix: ${JSON.stringify(backlogPulls)}`);

        const route1 = logs.find((l) => l.startsWith('Route C1: '));
        assert.ok(route1 && route1.includes(features.closeMe) && route1.includes(features.gapParent),
            `Route C1 routes both implementation-complete features to verify:\n${dump()}`);

        const eval1 = logs.find((l) => l.startsWith('Cycle 1 evaluation: '));
        assert.ok(eval1, `a Cycle 1 evaluation line:\n${dump()}`);
        const openCount = Number((/^Cycle 1 evaluation: (\d+) bead\(s\) still open/.exec(eval1) || [])[1]);
        assert.ok(openCount >= 1, `Cycle 1 evaluation must count the open gap bug ${gapId} at/above goal priority: ${eval1}`);

        const route2 = logs.find((l) => l.startsWith('Route C2: ')) || '';
        assert.ok(!route2.includes(features.closeMe),
            `Route C2 must not re-route the already-closed ${features.closeMe}: ${route2}`);
        assert.ok(!route2.includes(features.gapParent),
            `Route C2 must not route ${features.gapParent}, which has the open gap bug ${gapId}: ${route2}`);
        assert.ok(state.phases.some((t) => /C2\b/.test(t)), `cycle 2 ran (phases: ${JSON.stringify(state.phases)})`);
    });
});
