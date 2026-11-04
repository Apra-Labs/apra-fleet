import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';
import { memberUuid, isWriteTool, createFakeFleet, buildCallTool, buildOnCommand, candidateIds } from './helpers/kb-fake-fleet.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import { createKbMaintainerSelector } from '../fleet-sprint/kb-maintainer.mjs';

// =============================================================================
// kb_maintainer write routing, end to end with fakes.
//
// The first two scenarios drive the REAL runner.js through the mock-sprint
// harness. Every member is REMOTE, so each member-scoped kb_* call is an
// `apra-fleet call --member <uuid> <tool>` execute_command on the mocked
// callTool, answered by a fake per-member KB (FakeKb below) that tags a
// MEMBER-session capture member:<caller uuid>, runs a basis check against the
// caller's checkout, and implements kb_promote / kb_invalidate {ids} /
// kb_query {tag}. The G-pull is the harness's own `git fetch` + `git merge
// --ff-only` on the maintainer, observed through the harness onCommand hook;
// a member's checkout only gains the files a doer published when it G-pulls.
//
// The busy and unreachable maintainer scenarios run the same FakeKb behind
// createKbWorkClient with an injected memberCall and a fake git sync: the
// engine's doer streaks are globally sequential, so a maintainer that is
// mid-dispatch while another member's KB work is applied cannot be staged
// through the develop loop, and its dispatch lifecycle is driven directly.
// =============================================================================

const REPO_URL = 'https://github.com/mock-org/mock-repo.git';
const REPO = 'github.com/mock-org/mock-repo';
const CITED = 'src/widget-cache.ts';
const OLD_ENTRY_ID = 'kb-from-an-earlier-sprint';

const captureFor = (title) => ({
    type: 'knowledge',
    title,
    summary: `${title} -- a durable claim about the widget cache.`,
    content: `${CITED} keys every entry by tenant id; ${title}.`,
    trigger: 'hidden-invariant',
    source_files: [CITED],
});

/** Every batch of maintainer writes is preceded by a G-pull on the maintainer (no dispatch in between). */
function assertGpullBeforeEveryBatch(events, maintainer) {
    const seq = events.filter((e) => e.type === 'dispatch'
        || (e.member === maintainer && (e.type === 'gpull' || (e.type === 'kb' && isWriteTool(e.tool)))));
    let batches = 0;
    for (let i = 0; i < seq.length; i++) {
        const e = seq[i];
        if (e.type !== 'kb') continue;
        const prev = seq[i - 1];
        assert.ok(prev && (prev.type === 'gpull' || prev.type === 'kb'),
            `${e.tool} on '${maintainer}' was not preceded by a G-pull on it (previous: ${JSON.stringify(prev && { type: prev.type, member: prev.member, tool: prev.tool })})`);
        if (prev.type === 'gpull') batches++;
    }
    return batches;
}

describe('mock sprint: KB writes route through the kb_maintainer', () => {
    test('captures, CONFIRM and DISCARD land on the maintainer after a G-pull; candidates are the sprint window; nothing reaches the orchestrator session', { timeout: scaledTimeout(240000) }, async () => {
        await withScenarioMarkers('kb write routing', async () => {
            const fleet = createFakeFleet();
            fleet.seedEntry('maint', {
                id: OLD_ENTRY_ID, type: 'knowledge', title: 'An entry captured before this sprint',
                summary: 'older', source_files: [CITED], created_at: '2000-01-01T00:00:00.000Z',
            });
            const reviewerPrompts = [];
            let finalPrompt = null;
            let reviewRounds = 0;
            const doerHandler = async ({ opts, tempDir, runCmd }) => {
                fleet.events.push({ type: 'dispatch', member: opts.member_name, role: 'doer' });
                const ids = (opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
                for (const id of ids) await runCmd(`bd close ${id}`, tempDir);
                // The doer's commit carries the cited file: it reaches a
                // member's checkout only through a G-pull.
                fleet.published.add(CITED);
                return { content: [{ text: JSON.stringify({
                    status: 'VERIFY', closedIds: ids, notes: 'done',
                    kb_captures: [captureFor('claim to confirm'), captureFor('claim to discard')],
                }) }] };
            };
            const reviewerHandler = async ({ opts }) => {
                fleet.events.push({ type: 'dispatch', member: opts.member_name, role: 'reviewer' });
                reviewerPrompts.push(opts.prompt);
                reviewRounds++;
                const ids = candidateIds(opts.prompt) || [];
                const byTitle = (t) => [...fleet.kbOf(memberUuid('maint'))].find((e) => e.title === t && ids.includes(e.id));
                const confirm = byTitle('claim to confirm');
                const discard = byTitle('claim to discard');
                return { content: [{ text: JSON.stringify({
                    verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [],
                    ...(confirm ? { kb_promotions: [{ id: confirm.id, reason: `verified against ${CITED}:42 and the tenant test` }] } : {}),
                    ...(discard ? { kb_discards: [{ id: discard.id, reason: `${CITED}:42 keys by tenant AND id -- the claim is wrong` }] } : {}),
                }) }] };
            };
            const finalReviewHandler = async ({ opts }) => {
                fleet.events.push({ type: 'dispatch', member: opts.member_name, role: 'final-review' });
                finalPrompt = opts.prompt;
                return { content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'All goal beads closed.' }) }] };
            };

            const r = await runDevelopLoopScenario('kbroute', {
                members: ['maint', 'dev'],
                roleMap: { doer: ['dev'], reviewer: ['dev'] },
                beadsIdentity: { maint: { repoRemote: REPO_URL }, dev: { repoRemote: REPO_URL } },
                taskSpecs: [{ title: 'Task: kb maintainer write routing' }],
                doerHandler, reviewerHandler, finalReviewHandler,
                maxCycles: 1,
                callToolFactory: (executeCommand) => buildCallTool(fleet, executeCommand),
                onCommand: buildOnCommand(fleet),
            });
            assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
            assert.ok(r.logs.includes(`[kb-maintainer] repository ${REPO}: maintainer 'maint' (rule: role-less)`), 'maint must be the selected maintainer');
            // Sprint-start priming imports the bible once per repository, on
            // the maintainer, with the grant, from the base branch's
            // remote-tracking ref -- never the work tree or HEAD (nothing has
            // cleaned the maintainer's checkout at priming time).
            const imports = fleet.events.filter((e) => e.type === 'kb' && e.tool === 'kb_import');
            assert.equal(imports.length, 1, JSON.stringify(imports));
            assert.equal(imports[0].member, 'maint');
            assert.equal(imports[0].grant, true, 'the priming import carries the kb_maintainer grant');
            assert.match(String(imports[0].args && imports[0].args.ref), /^refs\/remotes\/origin\/[A-Za-z0-9_]/);
            assert.equal(imports[0].args.path, undefined);

            const MAINT = memberUuid('maint');
            const DEV = memberUuid('dev');
            const writes = fleet.events.filter((e) => e.type === 'kb' && isWriteTool(e.tool));

            // (2) A remote doer's capture is stored on the maintainer, tagged
            // member:<maintainer uuid>, and passes the basis check there.
            const captures = writes.filter((e) => e.tool === 'kb_capture');
            assert.deepEqual(captures.map((e) => e.member), ['maint', 'maint'], 'every kb_capture must run in the maintainer session, never the producing doer');
            assert.ok(captures.every((e) => e.grant === true), 'maintainer writes carry the kb_maintainer grant');
            const maintEntries = fleet.kbOf(MAINT).filter((e) => e.id !== OLD_ENTRY_ID);
            assert.deepEqual(maintEntries.map((e) => e.title).sort(), ['claim to confirm', 'claim to discard']);
            for (const e of maintEntries) assert.deepEqual(e.tags, [`member:${MAINT}`]);
            // The basis (cited file) is recorded on the stored entry; it exists only in the maintainer's checkout.
            for (const e of maintEntries) assert.deepEqual(e.source_files, [CITED]);
            assert.ok(!r.logs.some((l) => /basis check failed/.test(l)), 'the basis check must pass on the maintainer');
            assert.deepEqual(fleet.kbOf(DEV), [], "the producing doer's own KB stays empty");

            // (1) A G-pull on the maintainer precedes every batch of writes.
            const batches = assertGpullBeforeEveryBatch(fleet.events, 'maint');
            assert.ok(batches >= 2, `expected a capture batch and a judgement batch, saw ${batches}`);

            // (3) Nothing went through the orchestrator's FULL session.
            assert.deepEqual(fleet.orchestratorKbCalls, [], 'no kb_* call may go through the orchestrator session');

            // (5) Candidates: exactly kb_query {tag, confidence, limit} on the
            // maintainer, filtered to the sprint window, and exactly those
            // entries in the reviewer prompt.
            const candidateReads = fleet.events.filter((e) => e.type === 'kb' && e.tool === 'kb_query' && e.args && e.args.tag);
            assert.ok(candidateReads.length >= 1);
            for (const q of candidateReads) {
                assert.equal(q.member, 'maint');
                assert.deepEqual(q.args, { tag: `member:${MAINT}`, confidence: ['INFERRED'], limit: 40 });
            }
            assert.equal(reviewRounds, 1);
            const offered = candidateIds(reviewerPrompts[0]);
            assert.deepEqual([...offered].sort(), maintEntries.map((e) => e.id).sort(), 'the reviewer prompt carries exactly the in-window entries');
            assert.ok(!offered.includes(OLD_ENTRY_ID), 'an entry from before the sprint is excluded');

            // (6) CONFIRM and DISCARD change the entry on the maintainer.
            const confirmed = maintEntries.find((e) => e.title === 'claim to confirm');
            const discarded = maintEntries.find((e) => e.title === 'claim to discard');
            const promote = writes.find((e) => e.tool === 'kb_promote');
            const invalidate = writes.find((e) => e.tool === 'kb_invalidate');
            assert.equal(promote.member, 'maint');
            assert.equal(promote.grant, true, 'kb_promote runs in the kb_maintainer-grant session');
            assert.deepEqual(promote.args, { id: confirmed.id, reason: `verified against ${CITED}:42 and the tenant test` });
            assert.equal(invalidate.member, 'maint');
            assert.deepEqual(invalidate.args, { ids: [discarded.id] });
            assert.equal(confirmed.confidence, 'CONFIRMED');
            assert.ok(discarded.superseded_at, 'the discarded entry is superseded on the maintainer');
            // ... and both drop out of the next candidate read (the final review's).
            assert.ok(finalPrompt, 'the final review must have run');
            assert.equal(candidateIds(finalPrompt), null, 'the final review gets no candidates: one CONFIRMED, one discarded, one out of window');
        });
    });

    test('a capture from a member whose work folder is not a repository is dropped with a WARN', { timeout: scaledTimeout(240000) }, async () => {
        await withScenarioMarkers('kb write routing non-repository member', async () => {
            const fleet = createFakeFleet();
            const doerHandler = async ({ opts, tempDir, runCmd }) => {
                const ids = (opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
                for (const id of ids) await runCmd(`bd close ${id}`, tempDir);
                fleet.published.add(CITED);
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'done', kb_captures: [captureFor('claim from scratch')] }) }] };
            };
            const r = await runDevelopLoopScenario('kbroute-nonrepo', {
                members: ['maint', 'scratch'],
                roleMap: { doer: ['scratch'] },
                beadsIdentity: { maint: { repoRemote: REPO_URL }, scratch: { repoRemote: { fail: 'fatal: not a git repository (or any of the parent directories): .git' } } },
                taskSpecs: [{ title: 'Task: kb capture from a non-repository member' }],
                doerHandler,
                reviewerHandler: async () => ({ content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }] }),
                maxCycles: 1,
                callToolFactory: (executeCommand) => buildCallTool(fleet, executeCommand),
                onCommand: buildOnCommand(fleet),
            });
            assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
            assert.ok(r.logs.some((l) => l.endsWith("[kb-work] WARN: member 'scratch' (doer): work folder is not a repository -- 1 capture(s) dropped")),
                JSON.stringify(r.logs.filter((l) => l.includes('[kb-work]'))));
            assert.deepEqual(fleet.events.filter((e) => e.type === 'kb' && e.tool === 'kb_capture'), [], 'the capture is dropped, not written anywhere');
            assert.deepEqual(fleet.orchestratorKbCalls, []);
        });
    });

    test('a capture citing a file absent from the maintainer checkout is rejected with the basis-check reason, not stored', { timeout: scaledTimeout(240000) }, async () => {
        await withScenarioMarkers('kb write routing basis rejected', async () => {
            const fleet = createFakeFleet();
            const doerHandler = async ({ opts, tempDir, runCmd }) => {
                const ids = (opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
                for (const id of ids) await runCmd(`bd close ${id}`, tempDir);
                // Deliberately NOT published: the cited file is in no checkout.
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'done', kb_captures: [captureFor('claim with no basis')] }) }] };
            };
            const r = await runDevelopLoopScenario('kbroute-nobasis', {
                members: ['maint', 'dev'],
                roleMap: { doer: ['dev'] },
                beadsIdentity: { maint: { repoRemote: REPO_URL }, dev: { repoRemote: REPO_URL } },
                taskSpecs: [{ title: 'Task: kb capture citing a missing file' }],
                doerHandler,
                reviewerHandler: async () => ({ content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }] }),
                maxCycles: 1,
                callToolFactory: (executeCommand) => buildCallTool(fleet, executeCommand),
                onCommand: buildOnCommand(fleet),
            });
            assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
            const attempts = fleet.events.filter((e) => e.type === 'kb' && e.tool === 'kb_capture');
            assert.ok(attempts.length >= 1 && attempts.every((e) => e.member === 'maint'), 'the capture was attempted on the maintainer only');
            assert.ok(r.logs.some((l) => /\[kb-work\] kb_capture (rejected|failed) .*basis check failed: src\/widget-cache\.ts not in the checkout/.test(l)),
                JSON.stringify(r.logs.filter((l) => l.includes('[kb-work]'))));
            assert.deepEqual(fleet.kbOf(memberUuid('maint')), [], 'a rejected capture is not stored on the maintainer');
            assert.deepEqual(fleet.kbOf(memberUuid('dev')), [], 'nor on the producing member');
            assert.deepEqual(fleet.orchestratorKbCalls, []);
        });
    });
});

// -----------------------------------------------------------------------------
// Busy and unreachable maintainer: the same FakeKb behind createKbWorkClient,
// with the real kb_maintainer selector, an injected memberCall and a fake git
// sync whose G-pull can be made to fail.
// -----------------------------------------------------------------------------

async function clientHarness() {
    const fleet = createFakeFleet();
    const logs = [];
    const down = new Set();
    const records = new Map(['maint', 'dev'].map((n) => [n, { id: memberUuid(n), name: n, type: 'remote' }]));
    const memberCall = async (member, tool, args) => {
        fleet.events.push({ type: 'kb', member: member.name, tool, args });
        if (down.has(member.name)) {
            const err = new Error(`member ${member.name} unreachable`);
            err.code = 'E-CONNECT';
            throw err;
        }
        return fleet.memberTool(member.name, member.id, tool, args);
    };
    const selector = createKbMaintainerSelector({
        members: ['maint', 'dev'],
        roleMap: { doer: ['dev'] },
        resolveMember: async (n) => records.get(n),
        probeOrigin: async () => REPO_URL,
        probeMember: async (record) => memberCall(record, 'kb_stats', {}),
        log: (m) => logs.push(m),
    });
    await selector.selectAll();
    fleet.events.length = 0;
    const client = createKbWorkClient({
        memberCall,
        maintainers: selector,
        gPull: async (name) => {
            fleet.events.push({ type: 'gfetch', member: name });
            if (down.has(name)) throw new Error(`git fetch origin: ssh: connect to host ${name}: Connection refused`);
            fleet.gPull(name);
            fleet.events.push({ type: 'gpull', member: name });
        },
        sprintStartMs: Date.now() - 1000,
        log: (m) => logs.push(m),
    });
    return { fleet, logs, down, client, MAINT: memberUuid('maint') };
}

describe('KB write routing with fakes: busy and unreachable maintainer', () => {
    test('with the maintainer mid-dispatch, writes are applied after its dispatch ends, never during it', async () => {
        const h = await clientHarness();
        h.fleet.published.add(CITED);
        await h.client.dispatchStarted('maint');
        h.fleet.events.push({ type: 'dispatch-start', member: 'maint' });
        const during = await h.client.apply('doer', 'dev', { kb_captures: [captureFor('claim while busy')] });
        assert.equal(during.captured, 0);
        assert.ok(h.logs.some((l) => l.startsWith("[kb-work] maintainer 'maint' is mid-dispatch -- 1 KB write(s)")), JSON.stringify(h.logs));
        h.fleet.events.push({ type: 'dispatch-end', member: 'maint' });
        await h.client.dispatchEnded('maint');
        const order = h.fleet.events.map((e) => (e.type === 'kb' ? `${e.tool}@${e.member}` : `${e.type}:${e.member}`));
        assert.deepEqual(order, ['dispatch-start:maint', 'dispatch-end:maint', 'gfetch:maint', 'gpull:maint', 'kb_capture@maint']);
        assert.deepEqual(h.fleet.kbOf(h.MAINT).map((e) => e.title), ['claim while busy']);
    });

    test('with the maintainer unreachable mid-sprint, writes stay queued and a WARN is logged; nothing is lost', async () => {
        const h = await clientHarness();
        h.fleet.published.add(CITED);
        await h.client.apply('doer', 'dev', { kb_captures: [captureFor('first claim')] });
        assert.equal(h.fleet.kbOf(h.MAINT).length, 1);

        // The maintainer drops off the network mid-sprint.
        h.down.add('maint');
        const out = await h.client.apply('doer', 'dev', { kb_captures: [captureFor('second claim'), captureFor('third claim')] });
        assert.equal(out.captured, 0);
        assert.equal(h.client.pendingCount(REPO), 2);
        assert.ok(h.logs.some((l) => l.startsWith("[kb-work] WARN: G-pull on maintainer 'maint' failed") && l.endsWith(`2 KB write(s) for ${REPO} stay queued`)), JSON.stringify(h.logs));
        h.client.warnPending();
        assert.ok(h.logs.includes(`[kb-work] WARN: 2 KB write(s) for ${REPO} are still queued (maintainer busy or unreachable) -- not applied`));

        // Back again: the queued writes land, in order, after a G-pull.
        h.down.delete('maint');
        const later = await h.client.flushAll();
        assert.equal(later.captured, 2);
        assert.deepEqual(h.fleet.kbOf(h.MAINT).map((e) => e.title), ['first claim', 'second claim', 'third claim']);
        assert.equal(h.client.pendingCount(), 0);
    });
});
