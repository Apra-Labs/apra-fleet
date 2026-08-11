import { test, describe } from 'node:test';
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
            });
            const [view] = await dashboard.buildSprintViews();
            assert.deepEqual(calledWith, { branch: 'feat/x', base: 'main' });
            assert.equal(view.base, 'main');
            assert.equal(view.baseDrift, 7);
        });

        test('base defaults to null when the ledger entry carries none; baseDrift defaults to null when driftCheck is not injected (falls back to the real computeBaseDrift, which fails closed with no such branch)', async () => {
            const dashboard = createDashboard({
                ledger: fakeLedger([{ sprintId: 's1', members: [], issueRoots: [], childPid: 1 }]),
                watchdog: fakeWatchdog({ s1: WATCHDOG_STATUS.RUNNING_HEALTHY }),
                expandScope: async () => new Set(),
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
                logger: { log() {}, error() {} },
            });
            const views = await dashboard.buildSprintViews();
            assert.equal(views.length, 1);
            assert.equal(views[0].baseDrift, null);
            assert.equal(views[0].branch, 'feat/x', 'a driftCheck failure must not clobber the rest of the view');
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
        });
        const supervisor = createSupervisor({ logger: { log() {}, error() {} } });
        registerDashboardRoutes(supervisor, dashboard);

        const res = await request(supervisor, 'GET', '/');
        assert.equal(res.statusCode, 200);
        assert.ok(res.headers['content-type'].includes('text/html'));
        assert.ok(res.body.includes('sprint-1'));
        assert.ok(res.body.includes('/sprints/sprint-1/live'));
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
