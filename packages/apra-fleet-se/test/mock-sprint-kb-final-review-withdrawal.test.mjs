import fs from 'node:fs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool, mockCmdResult, withStagedBodies } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';

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
function createFakeFleet({ failOwnScopeQuery = false } = {}) {
    const kbs = new Map();          // member uuid -> entries[]
    const checkouts = new Map();    // member name -> Set<file>
    const published = new Set();    // files on the remote branch
    const events = [];              // ordered: dispatch / gpull / kb events
    const orchestratorKbCalls = []; // kb_* through the orchestrator's FULL session
    const bible = { entries: new Set(), tombstones: new Set() }; // the bible as kb_bible_commit leaves it
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
                // The demotion-candidate read is the own-scoped one; failing
                // only that read leaves the promotion read working, so a
                // scenario can isolate the demotion degradation.
                if (failOwnScopeQuery && args.own_scope === true) fail('kb unreachable: the demotion-candidate read failed');
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
            case 'kb_demote': {
                // kb_demote's own refusals: only an owned CONFIRMED entry, with evidence.
                const e = kb.find((x) => x.id === args.id && own(x));
                if (!e) fail(`Entry not found: ${args.id}`);
                if (e.confidence !== 'CONFIRMED') fail(`E-DEMOTE-NOT-CONFIRMED: ${args.id} is ${e.confidence}`);
                if (!Array.isArray(args.evidence_files) || args.evidence_files.length === 0) fail('evidence_files is required');
                e.confidence = 'INFERRED';
                e.demoted_at = new Date().toISOString();
                return { id: e.id, confidence_before: 'CONFIRMED', confidence_after: 'INFERRED' };
            }
            case 'kb_bible_commit': {
                // Admission mirrors the real tool: an id merges only while
                // CONFIRMED; a demoted id is tombstoned only once the row
                // really is demoted (demoted_at set, no longer CONFIRMED). A
                // withdrawal is admitted for an entry the bible holds or a
                // CONFIRMED row, tombstones it and leaves the LOCAL row
                // unchanged; a restore lifts a withdrawn tombstone.
                const merged = (args.ids || []).filter((i) => kb.some((x) => x.id === i && x.confidence === 'CONFIRMED'));
                const demoted = (args.demoted_ids || []).filter((i) => kb.some((x) => x.id === i && x.demoted_at && x.confidence !== 'CONFIRMED'));
                const withdrawn = (args.withdrawals || []).map((w) => w.id)
                    .filter((i) => bible.entries.has(i) || kb.some((x) => x.id === i && x.confidence === 'CONFIRMED'));
                const restored = (args.restore_ids || []).filter((i) => bible.tombstones.has(i));
                const skipped = [
                    ...(args.ids || []).filter((i) => !merged.includes(i)).map((i) => ({ id: i, reason: 'not_confirmed_or_unknown' })),
                    ...(args.demoted_ids || []).filter((i) => !demoted.includes(i)).map((i) => ({ id: i, reason: 'not_demoted_or_unknown' })),
                    ...(args.withdrawals || []).filter((w) => !withdrawn.includes(w.id)).map((w) => ({ id: w.id, reason: 'not_withdrawable' })),
                ];
                for (const i of merged) bible.entries.add(i);
                for (const i of demoted) { bible.entries.delete(i); bible.tombstones.add(i); }
                for (const i of withdrawn) { bible.entries.delete(i); bible.tombstones.add(i); }
                for (const i of restored) { bible.tombstones.delete(i); bible.entries.add(i); }
                const committed = merged.length + demoted.length + withdrawn.length + restored.length > 0;
                return { path: '.fleet/kb-canonical.json', merged, demoted, withdrawn, restored, skipped, entry_count: bible.entries.size, committed };
            }
            default: return {};
        }
    }

    return {
        kbs, checkouts, published, events, orchestratorKbCalls, kbOf, checkoutOf, memberTool, bible,
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
            // The call-args file of a kb_* call stays here; every other staged
            // file (the PR request body) goes to the harness, which records it.
            const kbArgs = (args.local_paths || []).filter((p) => !/vcs-body-/.test(p));
            for (const p of kbArgs) lastArgs = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (kbArgs.length === (args.local_paths || []).length) return { content: [{ type: 'text', text: 'sent' }] };
        }
        if (name === 'execute_command' && typeof args.command === 'string' && args.command.includes('apra-fleet call') && args.command.includes('--list-tools')) {
            // A current member server: its kb_import advertises `ref` (the
            // engine's version gate before the priming grant import) and its
            // kb_bible_commit the withdrawal route (the gate before the final
            // review's demotion-candidate read).
            fleet.events.push({ type: 'list-tools' });
            return { content: [{ type: 'text', text: JSON.stringify({ tools: [
                { name: 'kb_import', inputSchema: { type: 'object', properties: { path: { type: 'string' }, ref: { type: 'string' }, skip_sweep: { type: 'boolean' } } } },
                { name: 'kb_bible_commit', inputSchema: { type: 'object', properties: { ids: { type: 'array' }, withdrawals: { type: 'array' }, restore_ids: { type: 'array' } } } },
            ] }) }] };
        }
        if (name === 'execute_command' && typeof args.command === 'string' && args.command.includes('apra-fleet call')) {
            const m =/apra-fleet call --member (\S+) (?:--kb-maintainer )?(\w+) --args-file/.exec(args.command);
            const id = m && m[1];
            const tool = m && m[2];
            const member = byId.get(id);
            // The kb_maintainer grant (`apra-fleet call --kb-maintainer`): only
            // that session is served kb_promote, exactly like the real server.
            const grant = / --kb-maintainer /.test(args.command);
            fleet.events.push({ type: 'kb', member, tool, args: lastArgs, grant });
            if (tool === 'kb_promote' && !grant) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'E-TOOL', message: 'MCP error -32602: Tool kb_promote not found' } }) }] };
            }
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


// Mock sprint m1: the whole final-review withdrawal feature end to end through
// the REAL runner. The maintainer's KB holds three CONFIRMED entries citing a
// file the sprint changes; the sprint makes one false. Round reviews are
// offered no demotion block; the final review is, lists every id, demotes the
// false one and holds the rest (verdict PASS). Nothing is applied before
// merge: the demotion is a kb_bible_commit withdrawal, never a kb_demote.
describe('mock sprint m1: final-review demotion lands as a merge-carried withdrawal', () => {
    test('one withdrawal in one bible commit, no held id withdrawn or tombstoned, no kb_demote, logged offer and verdicts, PR section', { timeout: scaledTimeout(240000) }, async () => {
        await withScenarioMarkers('kb final review withdrawal m1', async () => {
            const BIBLE_FILE = '.fleet/kb-canonical.json';
            const FALSE_ID = 'aaaa1111-kb-the-claim-this-sprint-made-false';
            const HELD_IDS = ['bbbb2222-kb-still-true-one', 'cccc3333-kb-still-true-two'];
            const fleet = createFakeFleet();
            for (const [id, title] of [[FALSE_ID, 'Cache keys by tenant id only'], [HELD_IDS[0], 'Cache evicts oldest first'], [HELD_IDS[1], 'Cache is process local']]) {
                fleet.seedEntry('maint', {
                    id, type: 'knowledge', title, summary: title, source_files: [CITED], confidence: 'CONFIRMED',
                    created_at: '2000-01-01T00:00:00.000Z',
                });
            }
            const reviewerPrompts = [];
            let finalPrompt = null;
            const doerHandler = async ({ opts, tempDir, runCmd }) => {
                fleet.events.push({ type: 'dispatch', member: opts.member_name, role: 'doer' });
                const ids = (opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
                for (const id of ids) await runCmd(`bd close ${id}`, tempDir);
                fleet.published.add(CITED);
                return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'done' }) }] };
            };
            const reviewerHandler = async ({ opts }) => {
                fleet.events.push({ type: 'dispatch', member: opts.member_name, role: 'reviewer' });
                reviewerPrompts.push(opts.prompt);
                return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }] };
            };
            const REASON = `${CITED}:42 keys by tenant AND id; the claim does not hold`;
            const finalReviewHandler = async ({ opts }) => {
                fleet.events.push({ type: 'dispatch', member: opts.member_name, role: 'final-review' });
                finalPrompt = opts.prompt;
                const offered = opts.prompt.includes(`"id": "${FALSE_ID}"`);
                return { content: [{ text: JSON.stringify({
                    verdict: 'PASS', notes: 'All goal beads closed.',
                    ...(offered ? { kb_demotions: [{ id: FALSE_ID, reason: REASON, evidence_files: [CITED] }], kb_holds: HELD_IDS } : {}),
                }) }] };
            };
            const observe = buildOnCommand(fleet);
            const onCommand = (ev) => {
                observe(ev);
                if (ev.member_name !== 'maint') return undefined;
                if (/^git rev-parse HEAD\s*$/.test(ev.command)) return mockCmdResult(0, 'b'.repeat(40), '');
                if (/^git diff --name-only \S+\.\.\.\S+\s*$/.test(ev.command)) return mockCmdResult(0, `${CITED}\n`, '');
                if (/^git merge-base HEAD origin\//.test(ev.command)) return mockCmdResult(0, 'a'.repeat(40), '');
                if (/^git log -m --name-only --pretty=format: /.test(ev.command)) return mockCmdResult(0, `${BIBLE_FILE}\n`, '');
                if (/^git rev-list --count /.test(ev.command)) return mockCmdResult(0, '1\n', '');
                return undefined;
            };

            const r = await runDevelopLoopScenario('kbm1', {
                members: ['maint', 'dev'],
                roleMap: { doer: ['dev'], reviewer: ['dev'] },
                beadsIdentity: { maint: { repoRemote: REPO_URL }, dev: { repoRemote: REPO_URL } },
                taskSpecs: [{ title: 'Task: kb final review withdrawal m1' }],
                doerHandler, reviewerHandler, finalReviewHandler,
                maxCycles: 1,
                callToolFactory: (executeCommand) => buildCallTool(fleet, executeCommand),
                onCommand,
            });
            assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);

            // Offer: round reviews get no demotion block; the final review lists every id.
            assert.ok(reviewerPrompts.length >= 1, 'sanity: a round review ran');
            for (const id of [FALSE_ID, ...HELD_IDS]) {
                assert.ok(!reviewerPrompts.some((p) => p.includes(`"id": "${id}"`)), `a ROUND reviewer was offered ${id}`);
                assert.ok(finalPrompt && finalPrompt.includes(`"id": "${id}"`), `the final reviewer was not offered ${id}`);
            }

            // No kb_demote; exactly one bible commit carries the withdrawal, held ids nowhere in it.
            const kbEvents = fleet.events.filter((e) => e.type === 'kb');
            assert.equal(kbEvents.filter((e) => e.tool === 'kb_demote').length, 0, 'no kb_demote anywhere in the sprint');
            const withdrawing = kbEvents.filter((e) => e.tool === 'kb_bible_commit' && Array.isArray(e.args.withdrawals) && e.args.withdrawals.length > 0);
            assert.equal(withdrawing.length, 1, `exactly one bible commit carries the withdrawal; calls: ${JSON.stringify(kbEvents.map((e) => e.tool))}`);
            const args = withdrawing[0].args;
            assert.deepEqual(args.withdrawals.map((w) => w.id), [FALSE_ID]);
            for (const id of HELD_IDS) {
                assert.ok(!args.withdrawals.some((w) => w.id === id), `${id} must not be withdrawn`);
            }
            // A hold travels as a restore_ids entry, which lifts a tombstone this
            // branch added earlier and is a no-op for any other id: the held ids
            // never gain a tombstone and are never withdrawn.
            assert.ok(fleet.bible.tombstones.has(FALSE_ID), 'the branch bible carries the withdrawn tombstone');
            for (const id of HELD_IDS) assert.ok(!fleet.bible.tombstones.has(id), `${id} has no tombstone`);
            const row = fleet.kbOf(memberUuid('maint')).find((e) => e.id === FALSE_ID);
            assert.equal(row.confidence, 'CONFIRMED', 'nothing is applied before merge');

            // Run log: one offer line naming every id, one verdict line per id.
            const offerLines = r.logs.filter((l) => /demotion candidates offered to the final review/.test(l));
            assert.equal(offerLines.length, 1, offerLines.join('\n'));
            for (const id of [FALSE_ID, ...HELD_IDS]) assert.ok(offerLines[0].includes(id), `offer line misses ${id}`);
            const verdicts = r.logs.filter((l) => /demotion verdict for /.test(l)).map((l) => l.replace(/^.*demotion verdict for /, '')).sort();
            assert.deepEqual(verdicts, [`${FALSE_ID}: demote`, ...HELD_IDS.map((id) => `${id}: holds`)].sort());

            // PR body: the KB section naming the id (id8) and a counts line, ending with the marker.
            const create = withStagedBodies(r.commandLog).find((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls'));
            assert.ok(create, 'no create-pull-request command was dispatched');
            const rec = { body: JSON.parse(create.split('\n').find((l) => l.startsWith('{') && l.includes('"body"'))).body };
            assert.ok(rec.body, 'the staged create-PR payload carries a body');
            assert.match(rec.body, /### KB changes on merge/);
            assert.ok(rec.body.includes(FALSE_ID.slice(0, 8)), 'the withdrawn id (id8) is named');
            assert.match(rec.body, /Re-checked and kept: 2; restored: 0; refused: 0 \(run log\)/);
            assert.ok(rec.body.trimEnd().endsWith('-->'), 'the body still ends with the run-history marker');
            assert.deepEqual(fleet.orchestratorKbCalls, [], 'no kb_* call may go through the orchestrator session');
        });
    });
});
