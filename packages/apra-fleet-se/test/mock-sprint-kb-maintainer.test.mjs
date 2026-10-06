import fs from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCmd, runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

// =============================================================================
// kb_maintainer selection through the REAL runner.js wiring: one member per
// repository is chosen at sprint setup, before KB priming, and logged one line
// per repository. kb-maintainer.test.mjs covers the selector in isolation with
// fakes; this file proves the production call site feeds it real inputs:
//   - repository membership comes from each member's `git remote get-url
//     origin` (answered per member through the harness's beadsIdentity option);
//   - member records come from member_detail on the orchestrator's callTool;
//   - the availability probe is a kb_stats call AS the member through the
//     production remote memberCall adapter (send_files + execute_command
//     `apra-fleet call --member <id> kb_stats`), failed here for chosen ids.
// Every member is REMOTE so that adapter is observable on the mocked callTool.
// =============================================================================

const REPO_A = 'https://github.com/mock-org/mock-repo.git';
const REPO_B = 'git@github.com:mock-org/second-repo.git';
const A = 'github.com/mock-org/mock-repo';
const B = 'github.com/mock-org/second-repo';

// Two distinct origins in one sprint would otherwise trip the beads identity
// precondition's repoRemote comparison (it derives the expectation from the
// orchestrator). An expectation with no repoRemote leaves that field
// uncompared, so the multi-repository scenarios run to completion.
// The prefix is the DB's own: 'mock' under replay, template-derived under the
// real-bd lane (#634's function form of expectBeads, resolved by the harness).
const EXPECT_BEADS_ANY_REPO = ({ prefix }) => JSON.stringify({ beadsDir: '', prefix: prefix ?? 'mock', syncRemote: '', repoRemote: '' });

const approvedReviewer = async () => ({
    content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }],
});

function memberUuid(name) {
    const hex = Buffer.from(name).toString('hex').padEnd(12, '0').slice(0, 12);
    return `0b9d3a1e-5f2c-4c6e-9a7b-${hex}`;
}

/**
 * A callTool that answers member_detail with a remote member record for every
 * name, and every `apra-fleet call` with a plausible empty body -- except a
 * kb_stats probe for a member in `down`, which fails with a typed error.
 */
function buildCallTool({ down = [], executeCommand } = {}) {
    const base = defaultMockCallTool({ executeCommand });
    const kbStatsProbes = [];
    const byId = new Map();
    // kb_maintainer selection runs before the sprint-init member probe, which
    // reads kb_stats on EVERY member for its CONFIRMED count. The probe's
    // first member_detail refresh:true marks the end of selection, so only
    // the selection's availability probes are recorded.
    let selectionDone = false;
    const callTool = async (name, args) => {
        if (name === 'member_detail' && args && args.refresh === true) selectionDone = true;
        if (name === 'member_detail') {
            const id = memberUuid(args.member_name);
            byId.set(id, args.member_name);
            return { content: [{ text: JSON.stringify({ vcsProvider: 'github', id, type: 'remote', os: 'linux', folder: `/srv/${args.member_name}/work` }) }] };
        }
        if (name === 'send_files') {
            for (const p of args.local_paths || []) fs.readFileSync(p, 'utf8');
            return { content: [{ type: 'text', text: 'sent' }] };
        }
        if (name === 'execute_command' && typeof args.command === 'string' && args.command.includes('apra-fleet call')) {
            const m = /apra-fleet call --member (\S+) (?:--kb-maintainer )?(\w+) --args-file/.exec(args.command);
            const member = m && byId.get(m[1]);
            const tool = m && m[2];
            if (tool === 'kb_stats') {
                if (!selectionDone) kbStatsProbes.push(member);
                if (down.includes(member)) {
                    return { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'E-CONNECT', message: `member ${member} unreachable` } }) }] };
                }
            }
            const body = tool === 'kb_session_prime' ? { top_entries: [] }
                : tool === 'kb_list' ? { results: [] }
                    : tool === 'kb_query' ? { l1_results: [], related_claims: [] }
                        : {};
            return { content: [{ type: 'text', text: JSON.stringify(body) }] };
        }
        return base(name, args);
    };
    return { callTool, kbStatsProbes };
}

const selectionLine = (repo, member, rule) => `[kb-maintainer] repository ${repo}: maintainer '${member}' (rule: ${rule})`;
const selectionLines = (logs) => logs.filter((l) => /^\[kb-maintainer\] repository .*: maintainer '/.test(l));

async function runScenario(tag, { members, roleMap, origins, down, expectBeads }) {
    let kbStatsProbes = [];
    // callToolFactory threads the scenario's own executeCommand into the
    // harness default (vcs_credential_exec is answered through it).
    const callToolFactory = (executeCommand) => {
        const built = buildCallTool({ down, executeCommand });
        kbStatsProbes = built.kbStatsProbes;
        return built.callTool;
    };
    const beadsIdentity = {};
    for (const [m, origin] of Object.entries(origins)) beadsIdentity[m] = { repoRemote: origin };
    const r = await runDevelopLoopScenario(tag, {
        members,
        taskSpecs: [{ title: `Task: kb maintainer selection (${tag})` }],
        reviewerHandler: approvedReviewer,
        maxCycles: 1,
        callToolFactory,
        beadsIdentity,
        ...(roleMap ? { roleMap } : {}),
        ...(expectBeads ? { expectBeads } : {}),
    });
    return { ...r, kbStatsProbes };
}

test('mock sprint: two repositories -> two maintainers, one logged selection line each', { timeout: scaledTimeout(180000) }, async () => {
    await withScenarioMarkers('kb maintainer two repositories', async () => {
        const r = await runScenario('kbmaint-tworepo', {
            members: ['orch', 'alpha2', 'beta1'],
            origins: { orch: REPO_A, alpha2: REPO_A, beta1: REPO_B },
            expectBeads: EXPECT_BEADS_ANY_REPO,
        });
        assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
        assert.deepEqual(selectionLines(r.logs), [
            selectionLine(A, 'orch', 'role-less'),
            selectionLine(B, 'beta1', 'role-less'),
        ]);
    });
});

test('mock sprint: an explicit kb_maintainer role wins over a role-less member of the same repository', { timeout: scaledTimeout(180000) }, async () => {
    await withScenarioMarkers('kb maintainer explicit role', async () => {
        const r = await runScenario('kbmaint-explicit', {
            members: ['orch', 'pinned'],
            roleMap: { kb_maintainer: ['pinned'] },
            origins: { orch: REPO_A, pinned: REPO_A },
        });
        assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
        assert.deepEqual(selectionLines(r.logs), [selectionLine(A, 'pinned', 'explicit')]);
        assert.deepEqual(r.kbStatsProbes, ['pinned'], 'only the chosen maintainer is probed');
    });
});

test('mock sprint: no role-less member of a repository -> a member with access to it is chosen', { timeout: scaledTimeout(180000) }, async () => {
    await withScenarioMarkers('kb maintainer access fallback', async () => {
        const r = await runScenario('kbmaint-access', {
            members: ['orch', 'betadev'],
            roleMap: { doer: ['betadev'] },
            origins: { orch: REPO_A, betadev: REPO_B },
            expectBeads: EXPECT_BEADS_ANY_REPO,
        });
        assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
        assert.deepEqual(selectionLines(r.logs), [
            selectionLine(A, 'orch', 'role-less'),
            selectionLine(B, 'betadev', 'access'),
        ]);
    });
});

test('mock sprint: the first-choice maintainer fails its probe -> the next eligible member is chosen and the replacement logged', { timeout: scaledTimeout(180000) }, async () => {
    await withScenarioMarkers('kb maintainer unavailable replacement', async () => {
        const r = await runScenario('kbmaint-replace', {
            members: ['orch', 'backup'],
            origins: { orch: REPO_A, backup: REPO_A },
            down: ['orch'],
        });
        assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
        assert.deepEqual(r.kbStatsProbes, ['orch', 'backup']);
        const replacement = r.logs.filter((l) => l.includes('is unavailable'));
        assert.equal(replacement.length, 1, JSON.stringify(replacement));
        assert.match(replacement[0], new RegExp(`^\\[kb-maintainer\\] repository ${A}: maintainer candidate 'orch' \\(rule: role-less\\) is unavailable \\(.*member orch unreachable.*\\); replaced by 'backup' \\(rule: role-less\\)$`));
        assert.deepEqual(selectionLines(r.logs), [selectionLine(A, 'backup', 'role-less')]);
    });
});

test('mock sprint: a member whose work folder is not a repository is never selected, even when named kb_maintainer', { timeout: scaledTimeout(180000) }, async () => {
    await withScenarioMarkers('kb maintainer non-repository member', async () => {
        const r = await runScenario('kbmaint-nonrepo', {
            members: ['orch', 'scratch'],
            roleMap: { kb_maintainer: ['scratch'] },
            origins: { orch: REPO_A, scratch: { fail: 'fatal: not a git repository (or any of the parent directories): .git' } },
        });
        assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
        assert.ok(r.logs.includes("[kb-maintainer] member 'scratch': work folder is not a repository -- never a maintainer; its KB captures will be dropped with a warning"),
            JSON.stringify(r.logs.filter((l) => l.startsWith('[kb-maintainer]'))));
        assert.deepEqual(selectionLines(r.logs), [selectionLine(A, 'orch', 'role-less')]);
        assert.ok(!r.kbStatsProbes.includes('scratch'), 'a non-repository member is never probed as a candidate');
    });
});

// =============================================================================
// A kb_maintainer that holds NO dispatched role is still put on the sprint
// branch: the initial sprint-branch ensure and the per-cycle re-ensure both run
// on it (runner.js computeBranchEnsureMembers). Every dispatched role is
// role-mapped to other members, so the maintainer is reachable ONLY through the
// maintainer half of that list -- reverting it leaves no command for it.
// Cycle 1 closes A and leaves B blocked, so a second cycle runs and issues the
// re-ensure.
// =============================================================================

const ALL_ROLES_ELSEWHERE = {
    orchestrator: ['orch'],
    doer: ['dev'],
    reviewer: ['rev'],
    planner: ['dev'],
    'plan-reviewer': ['rev'],
    deployer: ['dev'],
    'integ-test-runner': ['rev'],
    'regression-test-runner': ['rev'],
    harvester: ['dev'],
};

const blockBDoer = (titleB) => async ({ opts, tempDir: td }) => {
    const match = opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/);
    const ids = match ? match[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
    const listRes = JSON.parse((await runCmd('bd list --json', td)).stdout || '[]');
    const b = listRes.find((x) => x.title === titleB);
    const closedIds = [];
    for (const id of ids) {
        if (b && id === b.id) {
            await runCmd(`bd update ${id} --status=blocked`, td);
        } else {
            await runCmd(`bd close ${id}`, td);
            closedIds.push(id);
        }
    }
    return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds, notes: 'Closed A; left B blocked.' }) }] };
};

for (const [label, roleMap, rule] of [
    ['a rule-(b) role-less maintainer', ALL_ROLES_ELSEWHERE, 'role-less'],
    ['an explicit roleMap.kb_maintainer-only maintainer', { ...ALL_ROLES_ELSEWHERE, kb_maintainer: ['kbm'] }, 'explicit'],
]) {
    test(`mock sprint: ${label} with no dispatched role gets the sprint-branch ensure and the re-ensure`, { timeout: scaledTimeout(240000) }, async () => {
        const tag = `kbmaint-branch-${rule}`;
        await withScenarioMarkers(`kb maintainer branch ensure (${rule})`, async () => {
            const titleB = `Task: B stays blocked (${tag})`;
            const callToolFactory = (executeCommand) => buildCallTool({ executeCommand }).callTool;
            const origins = { orch: REPO_A, dev: REPO_A, rev: REPO_A, kbm: REPO_A };
            const beadsIdentity = {};
            for (const [m, origin] of Object.entries(origins)) beadsIdentity[m] = { repoRemote: origin };
            const r = await runDevelopLoopScenario(tag, {
                members: ['orch', 'dev', 'rev', 'kbm'],
                taskSpecs: [{ title: `Task: A closes (${tag})` }, { title: titleB }],
                doerHandler: blockBDoer(titleB),
                reviewerHandler: approvedReviewer,
                maxCycles: 2,
                callToolFactory,
                beadsIdentity,
                roleMap,
            });
            assert.deepEqual(selectionLines(r.logs), [selectionLine(A, 'kbm', rule)], 'kbm is the selected maintainer');
            const kbmCmds = r.commandLogDetailed.filter((c) => c.member === 'kbm').map((c) => c.command);
            // The initial ensure (ensure-sprint-branch.mjs): the sprint-branch
            // fetch and the local-branch probe are issued only by that phase.
            assert.ok(kbmCmds.includes(`git fetch origin ${r.branch} --quiet`), `sprint-branch fetch on kbm: ${JSON.stringify(kbmCmds)}`);
            assert.ok(kbmCmds.includes(`git rev-parse --verify --quiet refs/heads/${r.branch}`), `ensure probe on kbm: ${JSON.stringify(kbmCmds)}`);
            assert.ok(kbmCmds.some((c) => c.startsWith('git checkout') && c.includes(r.branch)), `sprint-branch checkout on kbm: ${JSON.stringify(kbmCmds)}`);
            // The re-ensure at the start of cycle 2.
            assert.ok(kbmCmds.includes(`git checkout ${r.branch}`), `re-ensure on kbm: ${JSON.stringify(kbmCmds)}`);
            // kbm was never dispatched: it holds no role.
            assert.ok(!r.dispatched.some((d) => d && (d.member === 'kbm' || d.member_name === 'kbm')), 'kbm is never dispatched');
        });
    });
}
