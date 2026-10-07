import fs from 'node:fs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { createKbWorkClient, KB_DEMOTION_READ_LIMIT, KB_MAX_DEMOTION_CANDIDATES } from '../fleet-sprint/kb.mjs';
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

function memberUuid(name) {
    const hex = Buffer.from(name).toString('hex').padEnd(12, '0').slice(0, 12);
    return `0b9d3a1e-5f2c-4c6e-9a7b-${hex}`;
}

const isWriteTool = (tool) => tool === 'kb_capture' || tool === 'kb_promote' || tool === 'kb_invalidate';

/**
 * A fake fleet: per-member KBs (keyed by member uuid), per-member checkouts,
 * the files published to the remote branch, and one ordered event list.
 */
function createFakeFleet() {
    const kbs = new Map();          // member uuid -> entries[]
    const checkouts = new Map();    // member name -> Set<file>
    const published = new Set();    // files on the remote branch
    const events = [];              // ordered: dispatch / gpull / kb events
    const orchestratorKbCalls = []; // kb_* through the orchestrator's FULL session
    let seq = 0;

    const kbOf = (id) => { if (!kbs.has(id)) kbs.set(id, []); return kbs.get(id); };
    const checkoutOf = (name) => { if (!checkouts.has(name)) checkouts.set(name, new Set()); return checkouts.get(name); };
    const ownTag = (id) => `member:${id}`;

    /** The tool body for a MEMBER-session call; throws {code, message} for a tool failure. */
    function memberTool(name, id, tool, args) {
        const kb = kbOf(id);
        const own = (e) => e.tags.includes(ownTag(id));
        const fail = (message) => { const e = new Error(message); e.toolCode = 'E-TOOL'; throw e; };
        switch (tool) {
            case 'kb_stats': return { entries: kb.length };
            case 'kb_import': return { imported: 0 };
            case 'kb_session_prime': return { top_entries: [] };
            case 'kb_export': return { exported: kb.filter((e) => e.confidence === 'CONFIRMED').length };
            case 'kb_query': {
                if (typeof args.tag !== 'string') return { l1_results: [], related_claims: [] };
                const tiers = Array.isArray(args.confidence) ? args.confidence : ['CONFIRMED'];
                const hits = kb.filter((e) => e.tags.includes(args.tag) && tiers.includes(e.confidence) && !e.superseded_at);
                return { l1_results: hits.slice(0, args.limit ?? 20).map((e) => ({ ...e })) };
            }
            case 'kb_capture': {
                const missing = (args.source_files || []).filter((f) => !checkoutOf(name).has(f));
                if (missing.length > 0) fail(`basis check failed: ${missing.join(', ')} not in the checkout`);
                const entry = {
                    id: `kb-${name}-${++seq}`,
                    type: args.type, title: args.title, summary: args.summary, content: args.content,
                    source_files: args.source_files, tags: [ownTag(id)], confidence: 'INFERRED',
                    created_at: new Date().toISOString(), superseded_at: null,
                };
                kb.push(entry);
                return { id: entry.id, audn_decision: 'ADD' };
            }
            case 'kb_promote': {
                const e = kb.find((x) => x.id === args.id && own(x));
                if (!e) fail(`Entry not found: ${args.id}`);
                e.confidence = 'CONFIRMED';
                return { id: e.id, confidence_before: 'INFERRED', confidence_after: 'CONFIRMED' };
            }
            case 'kb_invalidate': {
                const out = { discarded: [], not_found: [], already_discarded: [] };
                for (const i of args.ids || []) {
                    const e = kb.find((x) => x.id === i && own(x));
                    if (!e) out.not_found.push(i);
                    else if (e.superseded_at) out.already_discarded.push(i);
                    else { e.superseded_at = new Date().toISOString(); out.discarded.push(i); }
                }
                return out;
            }
            default: return {};
        }
    }

    return {
        kbs, checkouts, published, events, orchestratorKbCalls, kbOf, checkoutOf, memberTool,
        seedEntry(memberName, entry) {
            kbOf(memberUuid(memberName)).push({ tags: [ownTag(memberUuid(memberName))], confidence: 'INFERRED', superseded_at: null, ...entry });
        },
        /** A G-pull on `name`: its checkout now holds every published file. */
        gPull(name) {
            for (const f of published) checkoutOf(name).add(f);
        },
    };
}

/**
 * The mocked callTool for the runner-level scenarios: member_detail answers a
 * REMOTE member record, kb_* through this (orchestrator) session is recorded
 * as a violation, and `apra-fleet call` is answered by the fake KB.
 */
function buildCallTool(fleet, executeCommand) {
    const base = defaultMockCallTool({ executeCommand });
    const byId = new Map();
    let lastArgs = null;
    return async (name, args) => {
        if (name === 'member_detail') {
            const id = memberUuid(args.member_name);
            byId.set(id, args.member_name);
            return { content: [{ text: JSON.stringify({ vcsProvider: 'github', id, type: 'remote', os: 'linux', folder: `/srv/${args.member_name}/work` }) }] };
        }
        if (typeof name === 'string' && name.startsWith('kb_')) {
            fleet.orchestratorKbCalls.push({ name, args });
            return { content: [{ type: 'text', text: '{}' }] };
        }
        if (name === 'send_files') {
            for (const p of args.local_paths || []) lastArgs = JSON.parse(fs.readFileSync(p, 'utf8'));
            return { content: [{ type: 'text', text: 'sent' }] };
        }
        if (name === 'execute_command' && typeof args.command === 'string' && args.command.includes('apra-fleet call')) {
            const m = /apra-fleet call --member (\S+) (\w+) --args-file/.exec(args.command);
            const id = m && m[1];
            const tool = m && m[2];
            const member = byId.get(id);
            fleet.events.push({ type: 'kb', member, tool, args: lastArgs });
            try {
                const body = fleet.memberTool(member, id, tool, lastArgs || {});
                return { content: [{ type: 'text', text: JSON.stringify(body) }] };
            } catch (err) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: { code: err.toolCode || 'E-TOOL', message: err.message } }) }] };
            }
        }
        return base(name, args);
    };
}

/** Observe every member command; a maintainer G-pull ends with `git merge --ff-only`. */
function buildOnCommand(fleet) {
    return ({ command, member_name: member }) => {
        if (/^git fetch origin /.test(command)) fleet.events.push({ type: 'gfetch', member });
        if (/^git merge --ff-only origin\//.test(command)) {
            fleet.gPull(member);
            fleet.events.push({ type: 'gpull', member });
        }
        return undefined;
    };
}

const captureFor = (title) => ({
    type: 'knowledge',
    title,
    summary: `${title} -- a durable claim about the widget cache.`,
    content: `${CITED} keys every entry by tenant id; ${title}.`,
    source_files: [CITED],
});

/** Parse the promotion-candidate block out of a reviewer prompt: its entry ids, or null when absent. */
function candidateIds(prompt) {
    const m = /Source: kb_query --tag[^\n]*\n(`{3,})[^\n]*\n([\s\S]*?)\n\1/.exec(prompt || '');
    return m ? JSON.parse(m[2]).map((e) => e.id) : null;
}

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

            const MAINT = memberUuid('maint');
            const DEV = memberUuid('dev');
            const writes = fleet.events.filter((e) => e.type === 'kb' && isWriteTool(e.tool));

            // (2) A remote doer's capture is stored on the maintainer, tagged
            // member:<maintainer uuid>, and passes the basis check there.
            const captures = writes.filter((e) => e.tool === 'kb_capture');
            assert.deepEqual(captures.map((e) => e.member), ['maint', 'maint'], 'every kb_capture must run in the maintainer session, never the producing doer');
            const maintEntries = fleet.kbOf(MAINT).filter((e) => e.id !== OLD_ENTRY_ID);
            assert.deepEqual(maintEntries.map((e) => e.title).sort(), ['claim to confirm', 'claim to discard']);
            for (const e of maintEntries) assert.deepEqual(e.tags, [`member:${MAINT}`]);
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
            // dispatchReview also reads DEMOTION
            // candidates (CONFIRMED entries touching this round's changed
            // files) alongside the promotion read above -- a second,
            // differently-shaped kb_query carrying the same tag. Split the
            // two apart by confidence tier rather than asserting one shape
            // over every tagged read.
            const promotionReads = candidateReads.filter((q) => Array.isArray(q.args.confidence) && q.args.confidence.includes('INFERRED'));
            const demotionReads = candidateReads.filter((q) => Array.isArray(q.args.confidence) && q.args.confidence.includes('CONFIRMED'));
            assert.equal(promotionReads.length + demotionReads.length, candidateReads.length, 'every tagged kb_query must be either a promotion or a demotion candidate read');
            assert.ok(promotionReads.length >= 1);
            for (const q of promotionReads) {
                assert.equal(q.member, 'maint');
                assert.deepEqual(q.args, { tag: `member:${MAINT}`, confidence: ['INFERRED'], limit: 40 });
            }
            for (const q of demotionReads) {
                assert.equal(q.member, 'maint');
                // Spelled out field by field rather than compared to
                // buildDemotionCandidateQuery's own output, which would be
                // tautological. This is the demotion READ: own-scope so a
                // MEMBER-session CONFIRMED read is answered from the per-repo
                // KB rather than the untagged checkout bible view, deliberately
                // WIDE (stale and contradiction-flagged rows are demotable and
                // are the ones most worth re-checking), and limited by the read
                // limit, never by the 20-entry offer cap.
                assert.equal(q.args.tag, `member:${MAINT}`);
                assert.equal(q.args.own_scope, true, 'without own_scope this read matches nothing in a real sprint');
                assert.deepEqual(q.args.confidence, ['CONFIRMED'], 'kb_demote accepts nothing else (E-DEMOTE-NOT-CONFIRMED)');
                assert.equal(q.args.include_stale, true, 'a stale CONFIRMED row is demotable');
                assert.equal(q.args.exclude_disputed, false, 'a contradiction-flagged CONFIRMED row is demotable too');
                assert.equal(q.args.limit, KB_DEMOTION_READ_LIMIT, 'the read limit must be the wide one');
                assert.notEqual(q.args.limit, KB_MAX_DEMOTION_CANDIDATES, 'the offer cap must never be used as the read limit');
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
