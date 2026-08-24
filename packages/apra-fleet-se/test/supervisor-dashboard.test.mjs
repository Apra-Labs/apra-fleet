import { test, describe, mock } from 'node:test';
import assert from 'node:assert';

import {
    createDashboard,
    registerDashboardRoutes,
    renderIndexPageHtml,
    renderSprintStackHtml,
    renderSprintSection,
    statusBadge,
    formatStopError,
    computeBaseDrift,
    buildStatePayload,
} from '../src/supervisor/dashboard.mjs';
import { WATCHDOG_STATUS } from '../src/supervisor/watchdog.mjs';
import { createSupervisor } from '../src/supervisor/server.mjs';
// apra-fleet-x8r.7: every `createDashboard({ listAllBeads })` fixture below is
// built via this helper (raw rows routed through the real normalizeBead()),
// so a fixture can never assert on a field the production listAllBeads path
// (bdListAllBeads() -> normalizeBead()) actually strips.
import { normalizedBeadFixtures } from './helpers/normalized-bead-fixture.mjs';

// apra-fleet-eft.6.1 -- sprint-stack index dashboard. GET / renders one
// section per RUNNING sprint (branch, goal, status badge, claimed bead
// count, claimed members+roles, supervisor-relative live-view link);
// finished sprints are excluded; the page never throws with zero sprints.

/** Minimal in-memory ledger exposing only list(). */
function fakeLedger(entries) {
    return { list: () => entries.map((e) => ({ ...e })) };
}

/** Watchdog stub returning a fixed status per sprintId. */
function fakeWatchdog(statusBySprintId) {
    return {
        classifySprint: async (entry) => ({ status: statusBySprintId[entry.sprintId] ?? WATCHDOG_STATUS.CRASHED }),
    };
}

describe('dashboard -- statusBadge', () => {
    test('badge text matches the classifier status string exactly', () => {
        for (const status of Object.values(WATCHDOG_STATUS)) {
            const html = statusBadge(status);
            assert.ok(html.includes('>' + status + '<'), `expected badge text '${status}' verbatim in: ${html}`);
        }
    });

    test('unrecognized status still renders (never throws), with a visible fallback', () => {
        assert.doesNotThrow(() => statusBadge('some-unknown-status'));
        assert.doesNotThrow(() => statusBadge(undefined));
        assert.ok(statusBadge(undefined).includes('unknown'));
    });
});

describe('dashboard -- renderSprintStackHtml / renderSprintSection', () => {
    test('zero running sprints renders an explicit empty state, not a blank/throw', () => {
        assert.doesNotThrow(() => renderSprintStackHtml([]));
        assert.doesNotThrow(() => renderSprintStackHtml(undefined));
        const html = renderSprintStackHtml([]);
        assert.ok(html.toLowerCase().includes('no sprints'));
    });

    test('renders branch, goal, status badge, bead count, and members+roles', () => {
        const html = renderSprintSection({
            sprintId: 'sprint-1',
            branch: 'auto-sprint/eft-service',
            goal: 'P1/P2',
            status: WATCHDOG_STATUS.RUNNING_HEALTHY,
            issueRoots: ['apra-fleet-eft.6'],
            beadCount: 7,
            members: [
                { name: 'alice', role: 'orchestrator' },
                { name: 'bob', role: null },
            ],
        });
        assert.ok(html.includes('sprint-1'));
        assert.ok(html.includes('auto-sprint/eft-service'));
        assert.ok(html.includes('P1/P2'));
        assert.ok(html.includes('>' + WATCHDOG_STATUS.RUNNING_HEALTHY + '<'));
        assert.ok(html.includes('7 bead'));
        assert.ok(html.includes('alice'));
        assert.ok(html.includes('orchestrator'));
        assert.ok(html.includes('bob'));
        // Supervisor-relative live-view link, never a bare child port.
        assert.ok(html.includes('/sprints/sprint-1/live'));
        assert.ok(!/:\d{2,5}\//.test(html), `must not leak a bare child port: ${html}`);
    });

    test('missing branch/goal/bead-count/members degrade to explicit "unknown" fallbacks, never throw', () => {
        const html = renderSprintSection({
            sprintId: 'sprint-2',
            branch: null,
            goal: null,
            status: WATCHDOG_STATUS.CRASHED,
            issueRoots: [],
            beadCount: null,
            members: [],
        });
        assert.ok(html.includes('unknown'));
        assert.ok(html.toLowerCase().includes('no members recorded'));
    });

    test('untrusted sprintId/branch/goal/member fields are HTML-escaped', () => {
        const html = renderSprintSection({
            sprintId: '<script>x</script>',
            branch: '<img src=x>',
            goal: '"><b>',
            status: WATCHDOG_STATUS.RUNNING_HEALTHY,
            issueRoots: [],
            beadCount: 0,
            members: [{ name: '<xss>', role: '<role>' }],
        });
        assert.ok(!html.includes('<script>x</script>'));
        assert.ok(!html.includes('<img src=x>'));
        assert.ok(!html.includes('<xss>'));
        assert.ok(!html.includes('<role>'));
    });

    test('apra-fleet-x8r.2: renders a progress bar plus M/N text when progress is available', () => {
        const html = renderSprintSection({
            sprintId: 'sprint-1',
            branch: 'feat/x',
            goal: 'P1',
            status: WATCHDOG_STATUS.RUNNING_HEALTHY,
            issueRoots: [],
            beadCount: 3,
            progress: { closed: 2, required: 3, fraction: 2 / 3 },
            members: [],
        });
        assert.ok(html.includes('sprint-progress'));
        assert.ok(html.includes('2/3'));
    });

    test('apra-fleet-x8r.2: missing/unknown progress renders a neutral placeholder, never NaN or a throw', () => {
        const html = renderSprintSection({
            sprintId: 'sprint-1',
            branch: 'feat/x',
            goal: 'P1',
            status: WATCHDOG_STATUS.RUNNING_HEALTHY,
            issueRoots: [],
            beadCount: null,
            progress: null,
            members: [],
        });
        assert.ok(!html.includes('NaN'));
        assert.ok(html.toLowerCase().includes('progress unavailable'));
    });

    test('apra-fleet-3i3.1: renders a Stop button and a per-row inline result element, both keyed by sprintId', () => {
        const html = renderSprintSection({
            sprintId: 'sprint-1',
            branch: 'feat/x',
            goal: 'P1',
            status: WATCHDOG_STATUS.RUNNING_HEALTHY,
            issueRoots: [],
            beadCount: 0,
            members: [],
        });
        assert.ok(html.includes('btn-stop-sprint'));
        assert.ok(html.includes('data-sprint-id="sprint-1"'));
        assert.ok(html.includes('stop-result'));
        assert.ok(/Stop</.test(html));
    });

    test('apra-fleet-3i3.3: renders a Restart button and a per-row inline result element, both keyed by sprintId', () => {
        const html = renderSprintSection({
            sprintId: 'sprint-1',
            branch: 'feat/x',
            goal: 'P1',
            status: WATCHDOG_STATUS.RUNNING_HEALTHY,
            issueRoots: [],
            beadCount: 0,
            members: [],
        });
        assert.ok(html.includes('btn-restart-sprint'));
        assert.ok(html.includes('restart-result'));
        assert.ok(/Restart</.test(html));
    });

    // apra-fleet-p2to.3.1: Pause/Resume row controls. Unlike Stop/Restart
    // (meaningful regardless of live-pid state), Pause/Resume only render
    // for statuses the watchdog currently sees as a live child: Pause for a
    // live pid (running-healthy/running-unresponsive), Resume once PAUSED;
    // neither renders for a dead/finished row (nothing live left to pause).
    describe('apra-fleet-p2to.3.1: Pause/Resume row controls', () => {
        function sectionFor(status) {
            return renderSprintSection({
                sprintId: 'sprint-1', branch: 'feat/x', goal: 'P1', status,
                issueRoots: [], beadCount: 0, members: [],
            });
        }

        test('running-healthy renders a Pause button (not Resume)', () => {
            const html = sectionFor(WATCHDOG_STATUS.RUNNING_HEALTHY);
            assert.ok(html.includes('btn-pause-sprint'));
            assert.ok(!html.includes('btn-resume-sprint'));
            assert.ok(/Pause</.test(html));
            assert.ok(html.includes('data-sprint-id="sprint-1"'));
        });

        test('running-unresponsive also renders a Pause button -- a hung child can still be asked to pause', () => {
            const html = sectionFor(WATCHDOG_STATUS.RUNNING_UNRESPONSIVE);
            assert.ok(html.includes('btn-pause-sprint'));
            assert.ok(!html.includes('btn-resume-sprint'));
        });

        test('paused renders a Resume button (not Pause)', () => {
            const html = sectionFor(WATCHDOG_STATUS.PAUSED);
            assert.ok(html.includes('btn-resume-sprint'));
            assert.ok(!html.includes('btn-pause-sprint'));
            assert.ok(/Resume</.test(html));
        });

        test('crashed/finished render neither button -- no live child to pause/resume', () => {
            for (const status of [WATCHDOG_STATUS.CRASHED, WATCHDOG_STATUS.FINISHED]) {
                const html = sectionFor(status);
                assert.ok(!html.includes('btn-pause-sprint'), `${status} must not render Pause`);
                assert.ok(!html.includes('btn-resume-sprint'), `${status} must not render Resume`);
            }
        });

        test('renders a per-row inline pause-result element, keyed by sprintId, regardless of status', () => {
            const html = sectionFor(WATCHDOG_STATUS.RUNNING_HEALTHY);
            assert.ok(html.includes('pause-result'));
            assert.ok(html.includes('class="pause-result" data-sprint-id="sprint-1"') || /pause-result[^>]*data-sprint-id="sprint-1"/.test(html));
        });
    });

    // apra-fleet-p2to.3.1: base-drift indicator. `driftCount === null` (unknown)
    // must render distinctly from a confirmed-zero drift, never conflated.
    describe('apra-fleet-p2to.3.1: base-drift indicator', () => {
        function sectionWithDrift(baseDrift, base) {
            return renderSprintSection({
                sprintId: 'sprint-1', branch: 'feat/x', goal: 'P1', status: WATCHDOG_STATUS.RUNNING_HEALTHY,
                issueRoots: [], beadCount: 0, members: [], baseDrift, base,
            });
        }

        test('unknown drift (null/undefined) renders "Base drift: unknown", not zero', () => {
            const html = sectionWithDrift(null, 'main');
            assert.ok(html.includes('Base drift: unknown'));
            assert.ok(!html.includes('Up to date'));
        });

        test('missing baseDrift field entirely (view built before this feature) also renders "unknown", never throws', () => {
            const html = renderSprintSection({
                sprintId: 'sprint-1', branch: 'feat/x', goal: 'P1', status: WATCHDOG_STATUS.RUNNING_HEALTHY,
                issueRoots: [], beadCount: 0, members: [],
            });
            assert.ok(html.includes('Base drift: unknown'));
        });

        test('zero drift renders "Up to date with <base>", distinct from unknown', () => {
            const html = sectionWithDrift(0, 'main');
            assert.ok(html.includes('Up to date with main'));
            assert.ok(!html.includes('Base drift: unknown'));
            assert.ok(!html.includes('Base drift:'));
        });

        test('positive drift renders the commit count and base name', () => {
            const html = sectionWithDrift(5, 'main');
            assert.ok(html.includes('Base drift: 5 commit(s) behind main'));
        });

        test('a missing base name falls back to the literal "base"', () => {
            const html = sectionWithDrift(3, null);
            assert.ok(html.includes('behind base'));
        });

        test('an untrusted base branch name is HTML-escaped', () => {
            const html = sectionWithDrift(2, '<script>x</script>');
            assert.ok(!html.includes('<script>x</script>'));
        });
    });
});

describe('dashboard -- apra-fleet-p2to.3.1: computeBaseDrift', () => {
    test('returns the commit count parsed from the injected exec (git rev-list --count branch..base)', async () => {
        let calledWith = null;
        const n = await computeBaseDrift('feat/x', 'main', {
            cwd: '/repo',
            exec: async (cmd, args, opts) => {
                calledWith = { cmd, args, opts };
                return { stdout: '5\n' };
            },
        });
        assert.equal(n, 5);
        assert.equal(calledWith.cmd, 'git');
        assert.deepEqual(calledWith.args, ['rev-list', '--count', 'feat/x..main']);
        assert.equal(calledWith.opts.cwd, '/repo');
    });

    test('zero drift is reported as 0, not null/falsy-coerced', async () => {
        const n = await computeBaseDrift('feat/x', 'main', { exec: async () => ({ stdout: '0\n' }) });
        assert.strictEqual(n, 0);
    });

    test('returns null when branch or base is missing/empty, without invoking exec', async () => {
        let called = false;
        const exec = async () => { called = true; return { stdout: '0' }; };
        assert.strictEqual(await computeBaseDrift(null, 'main', { exec }), null);
        assert.strictEqual(await computeBaseDrift('feat/x', null, { exec }), null);
        assert.strictEqual(await computeBaseDrift('', 'main', { exec }), null);
        assert.strictEqual(await computeBaseDrift('feat/x', '', { exec }), null);
        assert.strictEqual(await computeBaseDrift(undefined, undefined, { exec }), null);
        assert.equal(called, false, 'exec must never run when either ref is missing');
    });

    test('returns null (never throws) when the injected exec rejects -- e.g. an unresolvable ref or no local git repo', async () => {
        const n = await computeBaseDrift('feat/x', 'main', {
            exec: async () => { throw new Error("fatal: bad revision 'feat/x..main'"); },
        });
        assert.strictEqual(n, null);
    });

    test('returns null when stdout is not a parseable non-negative integer', async () => {
        assert.strictEqual(await computeBaseDrift('feat/x', 'main', { exec: async () => ({ stdout: 'not-a-number' }) }), null);
        assert.strictEqual(await computeBaseDrift('feat/x', 'main', { exec: async () => ({ stdout: '' }) }), null);
        assert.strictEqual(await computeBaseDrift('feat/x', 'main', { exec: async () => ({ stdout: '-3' }) }), null);
    });

    test('defaults cwd to process.cwd() when not supplied', async () => {
        let calledWith = null;
        await computeBaseDrift('feat/x', 'main', {
            exec: async (cmd, args, opts) => { calledWith = opts; return { stdout: '0' }; },
        });
        assert.equal(calledWith.cwd, process.cwd());
    });
});

describe('dashboard -- apra-fleet-3i3.1 formatStopError', () => {
    test('surfaces the server error message verbatim (e.g. a 404 for an already-gone sprint)', () => {
        const msg = formatStopError(404, { error: "no live reservation for sprint 'x'" });
        assert.ok(msg.includes("no live reservation for sprint 'x'"));
    });

    test('never throws on a missing/malformed error body', () => {
        assert.doesNotThrow(() => formatStopError(500, null));
        assert.doesNotThrow(() => formatStopError(500, undefined));
        assert.ok(formatStopError(500, {}).length > 0);
    });
});

describe('dashboard -- createDashboard', () => {
    test('buildSprintViews excludes finished sprints from the live stack', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([
                { sprintId: 'live-1', members: ['alice'], issueRoots: ['r1'], childPid: 1 },
                { sprintId: 'done-1', members: ['bob'], issueRoots: ['r2'], childPid: 2 },
            ]),
            watchdog: fakeWatchdog({ 'live-1': WATCHDOG_STATUS.RUNNING_HEALTHY, 'done-1': WATCHDOG_STATUS.FINISHED }),
            expandScope: async () => new Set(),
            listAllBeads: async () => [],
            driftCheck: async () => null,
        });
        const views = await dashboard.buildSprintViews();
        assert.deepEqual(views.map((v) => v.sprintId), ['live-1']);
    });

    test('crashed and unresponsive sprints (not finished) still appear -- only finished is excluded', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([
                { sprintId: 'crashed-1', members: [], issueRoots: [], childPid: 1 },
                { sprintId: 'hung-1', members: [], issueRoots: [], childPid: 2 },
            ]),
            watchdog: fakeWatchdog({
                'crashed-1': WATCHDOG_STATUS.CRASHED,
                'hung-1': WATCHDOG_STATUS.RUNNING_UNRESPONSIVE,
            }),
            expandScope: async () => new Set(),
            listAllBeads: async () => [],
            driftCheck: async () => null,
        });
        const views = await dashboard.buildSprintViews();
        assert.deepEqual(views.map((v) => v.sprintId).sort(), ['crashed-1', 'hung-1']);
    });

    test('beadCount comes from the live-expanded scope size (reuses expandScope)', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([{ sprintId: 's1', members: [], issueRoots: ['root'], childPid: 1 }]),
            watchdog: fakeWatchdog({ s1: WATCHDOG_STATUS.RUNNING_HEALTHY }),
            expandScope: async (roots) => {
                assert.deepEqual(roots, ['root']);
                return new Set(['root', 'child1', 'child2']);
            },
            listAllBeads: async () => [],
            driftCheck: async () => null,
        });
        const [view] = await dashboard.buildSprintViews();
        assert.equal(view.beadCount, 3);
    });

    test('apra-fleet-x8r.2: progress reuses computeSprintProgress over the sprint scope, sourced from listAllBeads', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([{ sprintId: 's1', members: [], issueRoots: ['root'], childPid: 1 }]),
            watchdog: fakeWatchdog({ s1: WATCHDOG_STATUS.RUNNING_HEALTHY }),
            expandScope: async () => new Set(['root', 'child1', 'child2']),
            listAllBeads: async () => normalizedBeadFixtures([
                { id: 'root', status: 'closed' },
                { id: 'child1', status: 'closed' },
                { id: 'child2', status: 'open' },
                { id: 'out-of-scope', status: 'open' },
            ]),
            driftCheck: async () => null,
        });
        const [view] = await dashboard.buildSprintViews();
        assert.deepEqual(view.progress, { closed: 2, required: 3, fraction: 2 / 3 });
    });

    test('apra-fleet-x8r.4: below-goal beads and decomposed parents are excluded from progress required/closed, matching the completion gate', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([{ sprintId: 's1', members: [], issueRoots: ['root'], childPid: 1 }]),
            watchdog: fakeWatchdog({ s1: WATCHDOG_STATUS.RUNNING_HEALTHY }),
            expandScope: async () => new Set(['root', 'below-goal', 'decomposed-parent', 'decomposed-child']),
            getSprintMeta: async () => ({ goal: 'P1' }),
            listAllBeads: async () => normalizedBeadFixtures([
                { id: 'root', status: 'closed', priority: 1, parentId: null },
                // Below goal (P1 -> goalMax 1): excluded even though open.
                { id: 'below-goal', status: 'open', priority: 3, parentId: null },
                // Decomposed parent: excluded structurally, even though open.
                { id: 'decomposed-parent', status: 'open', priority: 1, parentId: null },
                { id: 'decomposed-child', status: 'closed', priority: 1, parentId: 'decomposed-parent' },
            ]),
            driftCheck: async () => null,
        });
        const [view] = await dashboard.buildSprintViews();
        // Eligible set: root, decomposed-child -- both closed -> N/N, even
        // though the raw scope contains two other, still-open beads.
        assert.deepEqual(view.progress, { closed: 2, required: 2, fraction: 1 });
    });

    test('apra-fleet-x8r.2: a failed bulk beads fetch leaves progress null (placeholder) for every sprint, without throwing', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([{ sprintId: 's1', members: [], issueRoots: ['root'], childPid: 1 }]),
            watchdog: fakeWatchdog({ s1: WATCHDOG_STATUS.RUNNING_HEALTHY }),
            expandScope: async () => new Set(['root']),
            listAllBeads: async () => { throw new Error('bd unavailable'); },
            driftCheck: async () => null,
            logger: { log() {}, error() {} },
        });
        const views = await dashboard.buildSprintViews();
        assert.equal(views[0].progress, null);
        assert.equal(views[0].beadCount, 1);
    });

    test('getSprintMeta supplies branch/goal/roles when injected; defaults to null/unknown otherwise', async () => {
        const withMeta = createDashboard({
            ledger: fakeLedger([{ sprintId: 's1', members: ['alice', 'bob'], issueRoots: [], childPid: 1 }]),
            watchdog: fakeWatchdog({ s1: WATCHDOG_STATUS.RUNNING_HEALTHY }),
            expandScope: async () => new Set(),
            getSprintMeta: async (id) => (id === 's1'
                ? { branch: 'feat/x', goal: 'P1', roles: { alice: 'orchestrator' } }
                : {}),
            listAllBeads: async () => [],
            driftCheck: async () => null,
        });
        const [view] = await withMeta.buildSprintViews();
        assert.equal(view.branch, 'feat/x');
        assert.equal(view.goal, 'P1');
        assert.deepEqual(view.members.find((m) => m.name === 'alice').role, 'orchestrator');
        assert.deepEqual(view.members.find((m) => m.name === 'bob').role, null);

        const withoutMeta = createDashboard({
            ledger: fakeLedger([{ sprintId: 's2', members: ['carol'], issueRoots: [], childPid: 1 }]),
            watchdog: fakeWatchdog({ s2: WATCHDOG_STATUS.RUNNING_HEALTHY }),
            expandScope: async () => new Set(),
            listAllBeads: async () => [],
            driftCheck: async () => null,
        });
        const [view2] = await withoutMeta.buildSprintViews();
        assert.equal(view2.branch, null);
        assert.equal(view2.goal, null);
        assert.equal(view2.members[0].role, null);
    });

    test('apra-fleet-3i3.2: default getSprintMeta derives branch/goal from ledger.get() when the caller injects nothing', async () => {
        const ledgerWithMeta = {
            list: () => [{ sprintId: 's1', members: ['alice'], issueRoots: [], childPid: 1 }],
            get: (id) => (id === 's1' ? { branch: 'feat/persisted', base: 'main', goal: 'P1/P2' } : undefined),
        };
        const dashboard = createDashboard({
            ledger: ledgerWithMeta,
            watchdog: fakeWatchdog({ s1: WATCHDOG_STATUS.RUNNING_HEALTHY }),
            expandScope: async () => new Set(),
            listAllBeads: async () => [],
            driftCheck: async () => null,
        });
        const [view] = await dashboard.buildSprintViews();
        assert.equal(view.branch, 'feat/persisted');
        assert.equal(view.goal, 'P1/P2');
    });

    test('apra-fleet-3i3.2: default getSprintMeta is a safe no-op against a ledger stub that only implements list()', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([{ sprintId: 's1', members: [], issueRoots: [], childPid: 1 }]),
            watchdog: fakeWatchdog({ s1: WATCHDOG_STATUS.RUNNING_HEALTHY }),
            expandScope: async () => new Set(),
            listAllBeads: async () => [],
            driftCheck: async () => null,
        });
        const [view] = await dashboard.buildSprintViews();
        assert.equal(view.branch, null);
        assert.equal(view.goal, null);
    });

    test('a throwing getSprintMeta/expandScope for one sprint does not take down the whole page (isolated fallback)', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([{ sprintId: 's1', members: [], issueRoots: ['r'], childPid: 1 }]),
            watchdog: fakeWatchdog({ s1: WATCHDOG_STATUS.RUNNING_HEALTHY }),
            expandScope: async () => { throw new Error('boom'); },
            getSprintMeta: async () => { throw new Error('boom'); },
            listAllBeads: async () => [],
            driftCheck: async () => null,
            logger: { log() {}, error() {} },
        });
        const views = await dashboard.buildSprintViews();
        assert.equal(views.length, 1);
        assert.equal(views[0].beadCount, null);
        assert.equal(views[0].branch, null);
    });

    test('createDashboard requires a ledger and a watchdog', () => {
        assert.throws(() => createDashboard({}), TypeError);
        assert.throws(() => createDashboard({ ledger: fakeLedger([]) }), TypeError);
    });

    test('renderIndexPage renders a full HTML document with zero running sprints', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([]),
            watchdog: fakeWatchdog({}),
            listAllBeads: async () => [],
            driftCheck: async () => null,
        });
        const html = await dashboard.renderIndexPage();
        assert.ok(html.startsWith('<!DOCTYPE html>'));
        assert.ok(html.includes('No sprints are currently running'));
    });

    // apra-fleet-p2to.3.1: base-drift wiring on the view-builder. `base`
    // lives directly on the ledger entry (no getSprintMeta indirection, per
    // the impl's doc comment); `baseDrift` comes from the injectable
    // driftCheck, called with (branch, base) so a test can drive a
    // deterministic count without a real git checkout.
    describe('apra-fleet-p2to.3.1: base-drift view wiring', () => {
        test('buildSprintViews resolves base from the ledger entry and baseDrift via the injected driftCheck(branch, base)', async () => {
            let calledWith = null;
            const dashboard = createDashboard({
                ledger: fakeLedger([{ sprintId: 's1', members: [], issueRoots: [], childPid: 1, base: 'main' }]),
                watchdog: fakeWatchdog({ s1: WATCHDOG_STATUS.RUNNING_HEALTHY }),
                expandScope: async () => new Set(),
                getSprintMeta: async () => ({ branch: 'feat/x' }),
                driftCheck: async (branch, base) => { calledWith = { branch, base }; return 7; },
                listAllBeads: async () => [],
            });
            const [view] = await dashboard.buildSprintViews();
            assert.deepEqual(calledWith, { branch: 'feat/x', base: 'main' });
            assert.equal(view.base, 'main');
            assert.equal(view.baseDrift, 7);
        });

        test('base defaults to null when the ledger entry carries none; baseDrift defaults to null when driftCheck is not injected (falls back to the real computeBaseDrift, which fails closed with no such branch)', async () => {
            // driftCheck intentionally NOT injected here -- this test exercises
            // the real default computeBaseDrift()'s fail-closed guard. It never
            // actually shells out to git: with no branch/base on the ledger
            // entry, computeBaseDrift's own typeof guard short-circuits before
            // the `git rev-list` spawn.
            const dashboard = createDashboard({
                ledger: fakeLedger([{ sprintId: 's1', members: [], issueRoots: [], childPid: 1 }]),
                watchdog: fakeWatchdog({ s1: WATCHDOG_STATUS.RUNNING_HEALTHY }),
                expandScope: async () => new Set(),
                listAllBeads: async () => [],
            });
            const [view] = await dashboard.buildSprintViews();
            assert.equal(view.base, null);
            // No branch/base recorded at all -> the real computeBaseDrift's
            // own missing-ref guard returns null without ever shelling out.
            assert.equal(view.baseDrift, null);
        });

        test('a throwing driftCheck is isolated per-sprint: baseDrift stays null, the rest of the view (and the whole page) still renders', async () => {
            const dashboard = createDashboard({
                ledger: fakeLedger([{ sprintId: 's1', members: [], issueRoots: [], childPid: 1, base: 'main' }]),
                watchdog: fakeWatchdog({ s1: WATCHDOG_STATUS.RUNNING_HEALTHY }),
                expandScope: async () => new Set(),
                getSprintMeta: async () => ({ branch: 'feat/x' }),
                driftCheck: async () => { throw new Error('git boom'); },
                listAllBeads: async () => [],
                logger: { log() {}, error() {} },
            });
            const views = await dashboard.buildSprintViews();
            assert.equal(views.length, 1);
            assert.equal(views[0].baseDrift, null);
            assert.equal(views[0].branch, 'feat/x', 'a driftCheck failure must not clobber the rest of the view');
        });
    });

    // apra-fleet-c4s.2: verification for apra-fleet-c4s.1's fix -- every
    // OTHER createDashboard() test above injects `expandScope` explicitly
    // (the test seam), so none of them actually exercise the PRODUCTION
    // default path (deps.expandScope left unset, as bin/serve.mjs does).
    // This block fills that gap: it renders with `expandScope` deliberately
    // NOT injected, so buildSprintViews() must take the in-memory
    // expandScopeInMemory()/buildChildIndex() path (backlog.mjs) off the
    // single injected `listAllBeads` bulk-fetch stub, never a per-node `bd`
    // subprocess walker.
    describe('apra-fleet-c4s.2: default (no expandScope injected) scope expansion spawns no per-node subprocess walker', () => {
        // A known multi-level fixture tree: root -> {child1, child2}, and
        // child2 -> grandchild1 -- deep enough that a correct beadCount/
        // progress can only come from an actual multi-level in-memory walk,
        // not a single-level shortcut. `decomposed-sibling`/`out-of-scope`
        // beads are NOT reachable from 'root' and must be excluded from both
        // beadCount and progress.
        //
        // Progress note: `root` and `child2` are themselves someone else's
        // `.parent` (decomposedParentIdsAll, computed project-wide off the
        // same bulk fetch) so, matching apra-fleet-x8r.4's completion-gate
        // parity, both are excluded from the closed/required count even
        // though they are IN the claimed scope -- only the two leaves
        // (child1, grandchild1) are eligible: required=2, closed=1 (child1).
        function buildFixture() {
            return normalizedBeadFixtures([
                { id: 'root', status: 'closed', priority: 1, parentId: null },
                { id: 'child1', status: 'closed', priority: 1, parentId: 'root' },
                { id: 'child2', status: 'open', priority: 1, parentId: 'root' },
                { id: 'grandchild1', status: 'open', priority: 1, parentId: 'child2' },
                { id: 'out-of-scope', status: 'open', priority: 1, parentId: null },
            ]);
        }

        /**
         * A `listChildren`-shaped spy standing in for the pre-apra-fleet-c4s.1
         * per-node subprocess walker (scope-overlap.mjs's `bdListChildren` /
         * `expandScope`). `createDashboard()`'s current deps signature no
         * longer reads `deps.listChildren` at all (apra-fleet-c4s.1 dropped
         * it) -- injecting it here is a regression tripwire: if a future
         * change reintroduces the pre-fix `deps.listChildren ?? bdListChildren`
         * wiring, this spy starts getting invoked and the assertion below
         * catches it immediately. It throws if ever actually called, so a
         * regression fails loudly rather than silently falling back to a
         * real `bd` subprocess spawn.
         */
        function makeSubprocessWalkerSpy() {
            return mock.fn(async () => {
                throw new Error('apra-fleet-c4s.2: per-node subprocess scope walker must never be invoked');
            });
        }

        test('buildSprintViews(): beadCount/progress match the in-memory expansion of the fixture tree, with zero subprocess-walker calls', async () => {
            const listChildrenSpy = makeSubprocessWalkerSpy();
            const listAllBeadsSpy = mock.fn(async () => buildFixture());
            const dashboard = createDashboard({
                ledger: fakeLedger([{ sprintId: 's1', members: [], issueRoots: ['root'], childPid: 1 }]),
                watchdog: fakeWatchdog({ s1: WATCHDOG_STATUS.RUNNING_HEALTHY }),
                // expandScope: deliberately OMITTED -- production (bin/serve.mjs)
                // injects nothing either, so buildSprintViews() must take the
                // in-memory path under test.
                listChildren: listChildrenSpy,
                listAllBeads: listAllBeadsSpy,
                driftCheck: async () => null,
            });

            const [view] = await dashboard.buildSprintViews();

            assert.equal(listChildrenSpy.mock.calls.length, 0, 'the per-node subprocess scope walker must never be invoked');
            // One bulk fetch for the whole render, not one call per discovered node.
            assert.equal(listAllBeadsSpy.mock.calls.length, 1);

            assert.equal(view.beadCount, 4, 'root + child1 + child2 + grandchild1 -- out-of-scope excluded');
            assert.deepEqual(view.progress, { closed: 1, required: 2, fraction: 0.5 });
        });

        test('renderIndexPage(): the same in-memory scope expansion renders correctly into the HTML page, with zero subprocess-walker calls', async () => {
            const listChildrenSpy = makeSubprocessWalkerSpy();
            const dashboard = createDashboard({
                ledger: fakeLedger([{ sprintId: 's1', members: [], issueRoots: ['root'], childPid: 1 }]),
                watchdog: fakeWatchdog({ s1: WATCHDOG_STATUS.RUNNING_HEALTHY }),
                listChildren: listChildrenSpy,
                listAllBeads: async () => buildFixture(),
                driftCheck: async () => null,
            });

            const html = await dashboard.renderIndexPage();

            assert.equal(listChildrenSpy.mock.calls.length, 0, 'the per-node subprocess scope walker must never be invoked');
            assert.ok(html.includes('4 bead'), `expected the rendered claimed-scope count to be 4: ${html}`);
            assert.ok(html.includes('1/2'), `expected the rendered progress bar text to be 1/2: ${html}`);
        });
    });
});

describe('dashboard -- registerDashboardRoutes / GET /', () => {
    function request(supervisor, method, path) {
        return new Promise((resolve, reject) => {
            const req = {
                method,
                url: path,
                on() {},
            };
            const chunks = [];
            const res = {
                headers: null,
                statusCode: null,
                headersSent: false,
                writeHead(status, headers) {
                    this.statusCode = status;
                    this.headers = headers;
                    this.headersSent = true;
                },
                write(chunk) { chunks.push(chunk); },
                end(chunk) {
                    if (chunk) chunks.push(chunk);
                    resolve({ statusCode: this.statusCode, headers: this.headers, body: Buffer.concat(chunks.map((c) => (Buffer.isBuffer(c) ? c : Buffer.from(c)))).toString('utf-8') });
                },
            };
            Promise.resolve(supervisor.handleRequest(req, res)).catch(reject);
        });
    }

    test('GET / serves the rendered index page as text/html', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([{ sprintId: 'sprint-1', members: ['alice'], issueRoots: ['r1'], childPid: 1 }]),
            watchdog: fakeWatchdog({ 'sprint-1': WATCHDOG_STATUS.RUNNING_HEALTHY }),
            expandScope: async () => new Set(['r1']),
            listAllBeads: async () => [],
            driftCheck: async () => null,
        });
        const supervisor = createSupervisor({ logger: { log() {}, error() {} } });
        registerDashboardRoutes(supervisor, dashboard);

        const res = await request(supervisor, 'GET', '/');
        assert.equal(res.statusCode, 200);
        assert.ok(res.headers['content-type'].includes('text/html'));
        assert.ok(res.body.includes('sprint-1'));
        assert.ok(res.body.includes('/sprints/sprint-1/live'));
    });

    // apra-fleet-siqi.1.1
    test('GET /state serves the lean sprint-stack JSON payload, NOT the GET / HTML shell', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([{ sprintId: 'sprint-1', members: ['alice'], issueRoots: ['r1'], childPid: 1 }]),
            watchdog: fakeWatchdog({ 'sprint-1': WATCHDOG_STATUS.RUNNING_HEALTHY }),
            expandScope: async () => new Set(['r1', 'r2']),
            listAllBeads: async () => [],
            driftCheck: async () => null,
        });
        const supervisor = createSupervisor({ logger: { log() {}, error() {} } });
        registerDashboardRoutes(supervisor, dashboard);

        const res = await request(supervisor, 'GET', '/state');
        assert.equal(res.statusCode, 200);
        assert.ok(res.headers['content-type'].includes('application/json'));
        assert.ok(!res.body.includes('<!DOCTYPE'), 'GET /state must never serve the GET / HTML shell');
        assert.ok(!res.body.includes('<html'), 'GET /state must never serve the GET / HTML shell');

        const payload = JSON.parse(res.body);
        assert.equal(payload.runningCount, 1);
        assert.equal(payload.sprints.length, 1);
        const [sprint] = payload.sprints;
        assert.equal(sprint.sprintId, 'sprint-1');
        assert.equal(sprint.status, WATCHDOG_STATUS.RUNNING_HEALTHY);
        assert.equal(sprint.beadCount, 2);
        assert.ok(typeof payload.generatedAt === 'string' && payload.generatedAt.length > 0);
    });

    // apra-fleet-siqi.1.1
    test('GET /events opens a text/event-stream and sends an immediate on-connect signal', async () => {
        const dashboard = createDashboard({
            ledger: fakeLedger([]),
            watchdog: fakeWatchdog({}),
        });
        const supervisor = createSupervisor({ logger: { log() {}, error() {} } });
        registerDashboardRoutes(supervisor, dashboard);

        const closeListeners = [];
        const req = {
            method: 'GET',
            url: '/events',
            on(event, cb) { if (event === 'close') closeListeners.push(cb); },
        };
        const writes = [];
        const res = {
            headers: null,
            statusCode: null,
            headersSent: false,
            writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; },
            write(chunk) { writes.push(chunk); },
            end() { throw new Error('GET /events must never call res.end() itself'); },
        };

        await supervisor.handleRequest(req, res);

        assert.equal(res.statusCode, 200);
        assert.ok(res.headers['content-type'].includes('text/event-stream'));
        // The immediate on-connect signal (see dashboard.mjs's registerDashboardRoutes).
        assert.equal(writes.length, 1, 'connecting must emit exactly one immediate signal');
        assert.match(writes[0], /^data: /);
        assert.doesNotThrow(() => JSON.parse(writes[0].slice('data: '.length).trim()));

        assert.equal(closeListeners.length, 1, 'GET /events must register a close listener to unsubscribe');
        assert.doesNotThrow(() => closeListeners[0]());
    });

    // apra-fleet-siqi.1.1
    test('GET /events relays the dashboard seam\'s periodic change signal (started sprint-state changed proxy) to every connected client, and stops once the seam is stopped', async (t) => {
        t.mock.timers.enable({ apis: ['setInterval'] });

        const dashboard = createDashboard({
            ledger: fakeLedger([]),
            watchdog: fakeWatchdog({}),
            eventsIntervalMs: 1000,
        });
        const supervisor = createSupervisor({ logger: { log() {}, error() {} } });
        registerDashboardRoutes(supervisor, dashboard);

        function connect() {
            const req = { method: 'GET', url: '/events', on() {} };
            const writes = [];
            const res = {
                writeHead() {},
                write(chunk) { writes.push(chunk); },
                end() { throw new Error('must not end'); },
            };
            return supervisor.handleRequest(req, res).then(() => writes);
        }

        const writesA = await connect();
        const writesB = await connect();
        assert.equal(writesA.length, 1, 'each client gets its own immediate on-connect signal');
        assert.equal(writesB.length, 1);

        // dashboard.start() is exactly what server.mjs's supervisor lifecycle
        // calls for every seam, including this one -- see server.mjs's start().
        await dashboard.start();
        t.mock.timers.tick(1000);
        assert.equal(writesA.length, 2, 'a periodic change signal is relayed to every already-connected client');
        assert.equal(writesB.length, 2);

        t.mock.timers.tick(2000);
        assert.equal(writesA.length, 4, 'the signal keeps firing on the configured cadence while the seam is running');
        assert.equal(writesB.length, 4);

        await dashboard.stop();
        t.mock.timers.tick(5000);
        assert.equal(writesA.length, 4, 'no further signal is relayed once the seam has been stopped');
        assert.equal(writesB.length, 4);
    });
});

describe('dashboard -- buildStatePayload', () => {
    test('never throws regardless of input shape', () => {
        assert.doesNotThrow(() => buildStatePayload());
        assert.doesNotThrow(() => buildStatePayload(null));
        assert.doesNotThrow(() => buildStatePayload([]));
    });

    test('zero running sprints still returns a well-formed, empty payload', () => {
        const payload = buildStatePayload([]);
        assert.equal(payload.runningCount, 0);
        assert.deepEqual(payload.sprints, []);
        assert.ok(typeof payload.generatedAt === 'string' && payload.generatedAt.length > 0);
    });

    test('carries ids, statuses, claimed-scope/progress counts, and members through verbatim', () => {
        const views = [{
            sprintId: 'sprint-1',
            branch: 'feat/x',
            goal: 'P1',
            status: WATCHDOG_STATUS.RUNNING_HEALTHY,
            issueRoots: ['apra-fleet-eft.6'],
            beadCount: 7,
            progress: { closed: 2, required: 3, fraction: 2 / 3 },
            members: [{ name: 'alice', role: 'orchestrator' }],
            base: 'main',
            baseDrift: 0,
        }];
        const payload = buildStatePayload(views);
        assert.equal(payload.runningCount, 1);
        assert.deepEqual(payload.sprints, [{
            sprintId: 'sprint-1',
            branch: 'feat/x',
            goal: 'P1',
            status: WATCHDOG_STATUS.RUNNING_HEALTHY,
            issueRoots: ['apra-fleet-eft.6'],
            beadCount: 7,
            progress: { closed: 2, required: 3, fraction: 2 / 3 },
            members: [{ name: 'alice', role: 'orchestrator' }],
            base: 'main',
            baseDrift: 0,
        }]);
    });
});

describe('dashboard -- renderIndexPageHtml', () => {
    test('never throws regardless of input shape', () => {
        assert.doesNotThrow(() => renderIndexPageHtml());
        assert.doesNotThrow(() => renderIndexPageHtml(null));
        assert.doesNotThrow(() => renderIndexPageHtml([]));
    });

    test('apra-fleet-3i3.1: embeds the Stop button client script (formatStopError + force-release wiring)', () => {
        const html = renderIndexPageHtml([{
            sprintId: 'sprint-1', branch: 'feat/x', goal: 'P1', status: WATCHDOG_STATUS.RUNNING_HEALTHY,
            issueRoots: [], beadCount: 0, members: [],
        }]);
        // The exact code under test (formatStopError) is embedded verbatim
        // via .toString() -- same convention launch-form.mjs's
        // formatLaunchError/buildLaunchRequestBody use.
        assert.ok(html.includes('formatStopError'));
        assert.ok(html.includes('/force-release'));
        assert.ok(html.includes('btn-stop-sprint'));
        assert.ok(html.includes('confirm('));
    });

    test('apra-fleet-3i3.3: embeds the Restart button client script (force-release THEN /api/sprints relaunch wiring, via formatLaunchError for the relaunch step)', () => {
        const html = renderIndexPageHtml([{
            sprintId: 'sprint-1', branch: 'feat/x', goal: 'P1', status: WATCHDOG_STATUS.RUNNING_HEALTHY,
            issueRoots: [], beadCount: 0, members: [],
        }]);
        // Both the release step's error formatter (shared with Stop) and the
        // relaunch step's error formatter (shared with the Launch Sprint
        // form, per this bead's acceptance criterion) are embedded verbatim.
        assert.ok(html.includes('formatStopError'));
        assert.ok(html.includes('formatLaunchError'));
        assert.ok(html.includes('btn-restart-sprint'));
        // Restart is a two-step flow: release first (no separate manual Stop
        // required), THEN relaunch via the same validated launch endpoint.
        assert.ok(html.includes('/force-release'));
        assert.ok(html.includes("fetch('/api/sprints'"));
        assert.ok(html.includes('audit.branch'));
        assert.ok(html.includes('audit.issueRoots'));
    });

    test('apra-fleet-p2to.3.1: embeds the Pause/Resume button client script, event-delegated and proxying through /live/pause and /live/resume (never the kill route)', () => {
        const html = renderIndexPageHtml([{
            sprintId: 'sprint-1', branch: 'feat/x', goal: 'P1', status: WATCHDOG_STATUS.RUNNING_HEALTHY,
            issueRoots: [], beadCount: 0, members: [],
        }]);
        assert.ok(html.includes('btn-pause-sprint'));
        assert.ok(html.includes('btn-resume-sprint'));
        assert.ok(html.includes("'/live/' + action"), 'must proxy through the live-view routes, not construct a kill-route URL');
        // Distinguish it from the Stop/Restart scripts' own force-release
        // wiring: the pause script itself must never mention force-release.
        const pauseScriptStart = html.indexOf('function requestPauseResume');
        assert.ok(pauseScriptStart !== -1, 'pause/resume client script must be embedded');
        const pauseScriptEnd = html.indexOf('</script>', pauseScriptStart);
        const pauseScript = html.slice(pauseScriptStart, pauseScriptEnd);
        assert.ok(!pauseScript.includes('force-release'), 'the cooperative pause/resume script must never reference the kill+force-release route');
    });
});
