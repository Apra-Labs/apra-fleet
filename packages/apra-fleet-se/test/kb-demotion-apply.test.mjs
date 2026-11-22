import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createKbWorkClient, kbKnowledgeBlock } from '../fleet-sprint/kb.mjs';
import { E_MEMBER_FLEET_TOO_OLD } from '../fleet-sprint/member-call.mjs';
import { buildKbChangesSection } from '../fleet-sprint/pr-body.mjs';
import { selfMaintainer, currentServerKbWork } from './helpers/kb-maintainer-fakes.mjs';

// =============================================================================
// apply()'s demotion lane after the merge-carried withdrawal rework: a
// kb_demotions id offered to the FINAL review by demotionCandidates() is never
// a kb_demote call. It is queued as a kb_bible_commit `withdrawal`
// {id, note, evidence_files} (a hold as a `restore_ids` entry), filtered
// against demotionCandidates' OWN offered set (never the promotion one), and
// sent in the SAME kb_bible_commit call as the round's confirmed ids. A
// withdrawn id is excluded from every later knowledge block.
//
// Also keeps the D6 in-sprint ping-pong guard covered: an entry whose row
// carries a demoted_at inside the sprint window (a demotion recorded by any
// clone) is not re-offered for promotion while its basis is unchanged.
// =============================================================================

const MAINT = { id: 'id-maint', name: 'maint', type: 'local' };
const REASON = 'verified against the merged code in this round';
const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };
const CHANGED_FILE = 'src/thing.js';

// Entries served by the fake kb_query: INFERRED rows for promotionCandidates()
// (a tag, no files), CONFIRMED rows for demotionCandidates()' bible read (files).
let offeredPromotions = [];
let offeredDemotionRows = [];

/**
 * A fake maintainer session. `skipped` is kb_bible_commit's own skipped
 * list; every other id is reported back as merged/withdrawn/restored.
 */
function harness({ skipped = [], currentFileHashes = async () => ({}), sprintStartMs, bibleCommitError, knowledge = [], reshapeAnswer = (a) => a, branchWithdrawals, extra = {} } = {}) {
    const events = [];
    const logs = [];
    const memberCall = async (member, tool, args) => {
        if (tool === 'kb_query') {
            if (Array.isArray(args.files)) return { l1_results: offeredDemotionRows };
            if (args.own_scope) return { l1_results: [] };
            if (typeof args.query === 'string') return { l1_results: knowledge };
            return { l1_results: offeredPromotions };
        }
        events.push({ ev: tool, member: member.name, args });
        if (tool === 'kb_bible_commit') {
            if (bibleCommitError) throw bibleCommitError;
            const isSkipped = (id) => skipped.some((s) => s.id === id);
            const merged = (args.ids || []).filter((id) => !isSkipped(id));
            const withdrawn = (args.withdrawals || []).map((w) => w.id).filter((id) => !isSkipped(id));
            const restored = (args.restore_ids || []).filter((id) => !isSkipped(id));
            return {
                content: [{
                    text: JSON.stringify(reshapeAnswer({
                        path: '.fleet/kb-canonical.json', merged, demoted: [], withdrawn, restored, skipped,
                        entry_count: merged.length, committed: true,
                    })),
                }],
            };
        }
        if (tool === 'kb_promote') return { id: args.id, previous_confidence: 'INFERRED', new_confidence: 'CONFIRMED' };
        return {};
    };
    const client = currentServerKbWork(createKbWorkClient, {
        memberCall,
        maintainers: selfMaintainer(MAINT, ['maint', 'reviewer-1']),
        gPull: async () => {},
        gPush: async () => {},
        bibleBase: async () => BASE,
        bibleUnpushed: async () => ({ unpushed: false }),
        sprintChangedFiles: async () => [CHANGED_FILE],
        currentFileHashes,
        ...(branchWithdrawals ? { branchWithdrawals } : {}),
        ...(sprintStartMs !== undefined ? { sprintStartMs: () => sprintStartMs } : {}),
        log: (m) => logs.push(m),
        ...extra,
    });
    return { client, events, logs };
}

/** A CONFIRMED row demotionCandidates() would offer: eligible and touching CHANGED_FILE. */
const demotable = (id, extra = {}) => ({
    id, type: 'knowledge', confidence: 'CONFIRMED', title: id, summary: id,
    source_files: [CHANGED_FILE], ...extra,
});

/** Open the final review's demotion offer with `entries`, then clear the bookkeeping read. */
async function offerDemotions(client, entries) {
    offeredDemotionRows = entries;
    await client.demotionCandidates('reviewer-1');
    offeredDemotionRows = [];
}

/** Populate promotionCandidates()'s offered set with `entries`; returns what it ACTUALLY offered (post-guard). */
async function offerPromotions(client, entries) {
    offeredPromotions = entries;
    const offered = await client.promotionCandidates('reviewer-1');
    offeredPromotions = [];
    return offered;
}

describe('apply(): a final-review demotion is a queued withdrawal, never a kb_demote', () => {
    test('an offered id is queued as a withdrawal; an id that was not offered is refused with the promotion path\'s message style', async () => {
        const { client, events, logs } = harness();
        await offerDemotions(client, [demotable('kb-ok')]);

        const out = await client.apply('reviewer', 'reviewer-1', {
            kb_demotions: [
                { id: 'kb-ok', reason: REASON, evidence_files: [CHANGED_FILE] },
                { id: 'kb-not-offered', reason: REASON, evidence_files: [CHANGED_FILE] },
            ],
        });

        assert.equal(out.demoted, 1, 'demoted counts the withdrawals queued');
        assert.equal(out.refused, 1);
        assert.deepEqual(events, [], 'no kb_* write at apply time: the withdrawal waits for the bible commit');
        assert.deepEqual(client.pendingWithdrawals(), [{
            repo: 'example.com/org/repo',
            withdrawals: [{ id: 'kb-ok', note: REASON, evidence_files: [CHANGED_FILE] }],
            restores: [],
        }]);
        assert.ok(
            logs.includes("[kb-work] refused -- reviewer: demotion kb-not-offered not in this dispatch's candidate block"),
            JSON.stringify(logs),
        );
    });

    test('evidence_files is carried into the withdrawal, and a demotion without it never becomes one', async () => {
        const { client } = harness();
        await offerDemotions(client, [demotable('kb-with-evidence'), demotable('kb-no-evidence'), demotable('kb-empty-evidence')]);

        const out = await client.apply('reviewer', 'reviewer-1', {
            kb_demotions: [
                { id: 'kb-with-evidence', reason: REASON, evidence_files: [CHANGED_FILE] },
                { id: 'kb-no-evidence', reason: REASON },
                { id: 'kb-empty-evidence', reason: REASON, evidence_files: [] },
            ],
        });

        assert.equal(out.refused, 2, 'both evidence-less demotions are vetKbWork refusals');
        const [{ withdrawals }] = client.pendingWithdrawals();
        assert.deepEqual(withdrawals, [{ id: 'kb-with-evidence', note: REASON, evidence_files: [CHANGED_FILE] }]);
    });

    test('an id offered only for promotion cannot be demoted, and the refused attempt leaves its promotion eligibility alone', async () => {
        const { client, events } = harness();
        const entry = { id: 'kb-x', type: 'knowledge', created_at: new Date().toISOString() };
        await offerPromotions(client, [entry]);

        const demoteAttempt = await client.apply('reviewer', 'reviewer-1', {
            kb_demotions: [{ id: 'kb-x', reason: REASON, evidence_files: [CHANGED_FILE] }],
        });
        assert.equal(demoteAttempt.demoted, 0);
        assert.equal(demoteAttempt.refused, 1);
        assert.deepEqual(events, []);
        assert.deepEqual(client.pendingWithdrawals(), []);

        const promoteAttempt = await client.apply('reviewer', 'reviewer-1', { kb_promotions: [{ id: 'kb-x', reason: REASON }] });
        assert.equal(promoteAttempt.promoted, 1);
    });

    test('a hold is queued as a restore and cancels nothing else', async () => {
        const { client } = harness();
        await offerDemotions(client, [demotable('kb-d'), demotable('kb-h')]);

        await client.apply('reviewer', 'reviewer-1', {
            kb_demotions: [{ id: 'kb-d', reason: REASON, evidence_files: [CHANGED_FILE] }],
            kb_holds: ['kb-h'],
        });

        const [p] = client.pendingWithdrawals();
        assert.deepEqual(p.withdrawals.map((w) => w.id), ['kb-d']);
        assert.deepEqual(p.restores, ['kb-h']);
    });
});

describe('kb_bible_commit receives withdrawals in the SAME call as confirmed ids', () => {
    test('a round carrying both a promotion and a demotion produces exactly one kb_bible_commit call', async () => {
        const { client, events } = harness();
        await offerPromotions(client, [{ id: 'kb-promo', type: 'knowledge', created_at: new Date().toISOString() }]);
        await offerDemotions(client, [demotable('kb-demo')]);

        await client.apply('reviewer', 'reviewer-1', {
            kb_promotions: [{ id: 'kb-promo', reason: REASON }],
            kb_demotions: [{ id: 'kb-demo', reason: REASON, evidence_files: [CHANGED_FILE] }],
        });
        const out = await client.commitRound();

        const commits = events.filter((e) => e.ev === 'kb_bible_commit');
        assert.equal(commits.length, 1, 'one round, one bible commit call -- not one per list');
        assert.deepEqual(commits[0].args.ids, ['kb-promo']);
        assert.deepEqual(commits[0].args.withdrawals, [{ id: 'kb-demo', note: REASON, evidence_files: [CHANGED_FILE] }]);
        assert.deepEqual(out, { committed: 2, pending: 0 });
        assert.equal(events.filter((e) => e.ev === 'kb_demote').length, 0);
    });

    test('a withdrawal-only round still runs the bible commit, with ids []', async () => {
        const { client, events } = harness();
        await offerDemotions(client, [demotable('kb-demo-only')]);

        await client.apply('reviewer', 'reviewer-1', { kb_demotions: [{ id: 'kb-demo-only', reason: REASON, evidence_files: [CHANGED_FILE] }] });
        const out = await client.commitRound();

        const commits = events.filter((e) => e.ev === 'kb_bible_commit');
        assert.equal(commits.length, 1);
        assert.deepEqual(commits[0].args.ids, []);
        assert.deepEqual(commits[0].args.withdrawals.map((w) => w.id), ['kb-demo-only']);
        assert.deepEqual(out, { committed: 1, pending: 0 });
    });
});

describe("only kb_bible_commit's own answer counts as withdrawn or restored", () => {
    test('an answer with no `withdrawn` list (an older server dropped the key) is not reported as a withdrawal anywhere', async () => {
        const legacy = ({ withdrawn: _w, restored: _r, ...rest }) => rest;
        const { client, logs } = harness({ reshapeAnswer: legacy });
        await offerDemotions(client, [demotable('kb-demo')]);
        await client.apply('reviewer', 'reviewer-1', { kb_demotions: [{ id: 'kb-demo', reason: REASON, evidence_files: [CHANGED_FILE] }] });

        await client.commitRound('final review');

        const warn = logs.find((l) => /WARN/.test(l) && /'maint'/.test(l) && /no 'withdrawn' list/.test(l));
        assert.ok(warn, logs.join('\n'));
        assert.match(warn, /kb-demo/);
        assert.ok(!logs.some((l) => /[1-9]\d* withdrawal\(s\).*(committed and pushed|already in the bible)/.test(l)), `no log line may claim a recorded withdrawal:\n${logs.join('\n')}`);
        const report = client.kbChangesReport();
        assert.deepEqual(report.withdrawn, [], 'not reported as withdrawn');
        assert.deepEqual(report.notRecorded.map((w) => w.id), ['kb-demo']);
        assert.ok(!client.withdrawnIds().includes('kb-demo'), 'nothing was withdrawn, so the sprint still vouches for it');
        const section = buildKbChangesSection(report);
        assert.doesNotMatch(section.text, /Merging withdraws|withdrawn/i, section.text);
        assert.match(section.text, /Demotion not recorded \(1\):\*\* kb-demo/);
    });

    test('"restored" counts the ids the tool reported restored, not the holds that asked for it', async () => {
        const run = async (restoredAnswer) => {
            const { client } = harness({
                reshapeAnswer: (a) => ({ ...a, restored: restoredAnswer }),
                branchWithdrawals: async () => [demotable('kb-back')],
            });
            await offerDemotions(client, []);
            await client.apply('reviewer', 'reviewer-1', { kb_holds: ['kb-back'] });
            await client.commitRound('final review');
            return client.kbChangesReport();
        };
        const refusedRestore = await run([]);
        assert.equal(refusedRestore.kept, 1);
        assert.equal(refusedRestore.restored, 0, 'the tool restored nothing');
        const done = await run(['kb-back']);
        assert.equal(done.restored, 1);
    });

    test('the bible commit log line names the ids the tool restored (first 8 characters), not only their count', async () => {
        const { client, logs } = harness({ branchWithdrawals: async () => [demotable('0123456789abcdef')] });
        await offerDemotions(client, []);
        await client.apply('reviewer', 'reviewer-1', { kb_holds: ['0123456789abcdef'] });
        await client.commitRound('final review');
        const line = logs.find((l) => /^\[kb-work\] bible commit for .* on maintainer 'maint':/.test(l));
        assert.ok(line, logs.join('\n'));
        assert.match(line, /: 1 restore\(s\) \(restored: 01234567\) (committed and pushed|already in the bible)/, line);
    });
});

describe('a fleet-too-old maintainer leaves queued withdrawals pending', () => {
    test('commitRound reports pending including the queued withdrawal, not just the confirmed ids', async () => {
        const tooOld = Object.assign(new Error('maintainer fleet is too old for kb_bible_commit'), { code: E_MEMBER_FLEET_TOO_OLD });
        const { client } = harness({ bibleCommitError: tooOld });
        await offerPromotions(client, [{ id: 'kb-promo', type: 'knowledge', created_at: new Date().toISOString() }]);
        await offerDemotions(client, [demotable('kb-demo')]);
        await client.apply('reviewer', 'reviewer-1', {
            kb_promotions: [{ id: 'kb-promo', reason: REASON }],
            kb_demotions: [{ id: 'kb-demo', reason: REASON, evidence_files: [CHANGED_FILE] }],
        });

        const out = await client.commitRound();

        assert.deepEqual(out, { committed: 0, pending: 2 });
        assert.deepEqual(client.pendingWithdrawals()[0].withdrawals.map((w) => w.id), ['kb-demo']);
    });
});

describe('a withdrawn id is absent from every later knowledge block', () => {
    const entry = (id) => ({ id, type: 'knowledge', confidence: 'CONFIRMED', title: `title ${id}`, summary: `summary ${id}`, source_files: [CHANGED_FILE] });

    test('knowledgeFor (the harvest and every later dispatch) drops an id the final review withdrew', async () => {
        const { client } = harness({ knowledge: [entry('kb-keep'), entry('kb-gone')] });
        const before = await client.knowledgeFor('reviewer-1', ['thing']);
        assert.deepEqual(before.entries.map((e) => e.id), ['kb-keep', 'kb-gone'], 'sanity: both are served before the withdrawal');

        await offerDemotions(client, [demotable('kb-gone')]);
        await client.apply('reviewer', 'reviewer-1', { kb_demotions: [{ id: 'kb-gone', reason: REASON, evidence_files: [CHANGED_FILE] }] });

        const after = await client.knowledgeFor('reviewer-1', ['thing']);
        const block = kbKnowledgeBlock(after.entries, { source: 'query' }).join('\n');
        assert.ok(!after.entries.some((e) => e.id === 'kb-gone'));
        assert.ok(block.includes('title kb-keep'));
        assert.ok(!block.includes('title kb-gone'), 'a withdrawn entry must not reach a later knowledge block');
        assert.deepEqual(client.withdrawnIds(), ['kb-gone']);
    });

    test('the exclusion survives the bible commit (the withdrawal is merge-gated, the sprint stops vouching for it at once)', async () => {
        const { client } = harness({ knowledge: [entry('kb-gone')] });
        await offerDemotions(client, [demotable('kb-gone')]);
        await client.apply('reviewer', 'reviewer-1', { kb_demotions: [{ id: 'kb-gone', reason: REASON, evidence_files: [CHANGED_FILE] }] });
        await client.commitRound('final review');

        const after = await client.knowledgeFor('reviewer-1', ['thing']);
        assert.deepEqual(after.entries, []);
    });

    test('a held id is not excluded', async () => {
        const { client } = harness({ knowledge: [entry('kb-held')] });
        await offerDemotions(client, [demotable('kb-held')]);
        await client.apply('reviewer', 'reviewer-1', { kb_holds: ['kb-held'] });

        const after = await client.knowledgeFor('reviewer-1', ['thing']);
        assert.deepEqual(after.entries.map((e) => e.id), ['kb-held']);
    });
});

describe('IN-SPRINT PING-PONG: an entry demoted this sprint is not re-offered for promotion while its basis is unchanged', () => {
    test('promotionCandidates omits a row with an in-window demoted_at until a cited file is edited on disk', async () => {
        const sprintStart = Date.parse('2026-01-01T00:00:00.000Z');
        let diskHash = 'HASH-ORIGINAL';
        const { client } = harness({
            sprintStartMs: sprintStart,
            currentFileHashes: async (member, files) => Object.fromEntries(files.map((f) => [f, diskHash])),
        });
        const pingEntry = {
            id: 'kb-ping',
            type: 'knowledge',
            created_at: new Date(sprintStart + 1000).toISOString(),
            demoted_at: new Date(sprintStart + 60000).toISOString(),
            demoted_basis_hashes: { [CHANGED_FILE]: 'HASH-ORIGINAL' },
        };

        let offered = await offerPromotions(client, [pingEntry]);
        assert.deepEqual(offered.map((e) => e.id), [], 'the just-demoted entry is not re-offered while its basis is unchanged on disk');

        diskHash = 'HASH-EDITED';
        offered = await offerPromotions(client, [pingEntry]);
        assert.deepEqual(offered.map((e) => e.id), ['kb-ping'], 'a changed basis is new evidence -- the entry is offered again');
    });
});

// A withdrawn tombstone an EARLIER run pushed to this sprint branch is carried
// by the merge unless this run restores it. The PR body's report
// (kbChangesOnMerge) reads the branch's tombstones on the maintainer at
// publish and at abort, independently of this run's offer, so it lists every
// carried one -- even when this run offered nothing -- and never calls a
// carried id "still CONFIRMED". A read that fails is said, never silent.
describe('kbChangesOnMerge: withdrawals carried on the branch from an earlier run', () => {
    const CARRIED = 'kb-carried-from-run-1';
    const carriedRow = (id = CARRIED) => ({
        ...demotable(id, { title: `withdrawn entry ${id}` }), base_title: 'Cache keys by tenant id only', tombstone_note: 'the earlier final review judged it false',
    });
    /** A branchWithdrawals with the .read variant the engine wires (createBranchWithdrawnEntries). */
    const reader = (answer) => {
        const fn = async () => (answer.ok ? answer.rows : []);
        fn.read = async () => answer;
        return fn;
    };

    test('a relaunch that offers nothing (loop off) still lists the carried id under "Merging withdraws"', async () => {
        const { client } = harness({ branchWithdrawals: reader({ ok: true, rows: [carriedRow()] }), extra: { demotionLoop: 'off' } });
        assert.deepEqual(await client.demotionCandidates('reviewer-1'), [], 'sanity: the loop is off, nothing is offered');
        assert.equal(client.kbChangesReport(), null, 'sanity: this run offered nothing');

        const report = await client.kbChangesOnMerge();

        assert.deepEqual(report.carried, [{ id: CARRIED, title: 'Cache keys by tenant id only', note: 'the earlier final review judged it false', kept: false }]);
        const s = buildKbChangesSection(report);
        assert.match(s.text, /^Merging withdraws 1 CONFIRMED KB claim\(s\); 1 carried from an earlier run, not re-checked/);
        assert.ok(s.text.includes(`- ${CARRIED.slice(0, 8)} "Cache keys by tenant id only" -- the earlier final review judged it false (carried from an earlier run, not re-checked)`), s.text);
        assert.doesNotMatch(s.text, /still CONFIRMED/);
    });

    test('a maintainer with a support gap (nothing offered, WARN) still lists the carried id', async () => {
        const { client, logs } = harness({
            branchWithdrawals: reader({ ok: true, rows: [carriedRow()] }),
            extra: { listTools: async () => ({ tools: [{ name: 'kb_bible_commit', inputSchema: { properties: {} } }] }) },
        });
        assert.deepEqual(await client.demotionCandidates('reviewer-1'), []);
        assert.ok(logs.some((l) => /WARN: maintainer 'maint'.*offering no demotion candidates/.test(l)), logs.join('\n'));
        const report = await client.kbChangesOnMerge();
        assert.deepEqual(report.carried.map((c) => c.id), [CARRIED]);
    });

    test('a carried id offered this run with no verdict is listed as carried, never as "still CONFIRMED"', async () => {
        const { client } = harness({ branchWithdrawals: reader({ ok: true, rows: [carriedRow()] }) });
        await offerDemotions(client, [demotable('kb-plain')]);
        await client.apply('reviewer', 'reviewer-1', {});
        assert.deepEqual(client.kbChangesReport().noVerdict.sort(), [CARRIED, 'kb-plain'].sort(), 'sanity: both offered ids got no verdict');

        const report = await client.kbChangesOnMerge();

        assert.deepEqual(report.carried.map((c) => c.id), [CARRIED]);
        assert.deepEqual(report.noVerdict, ['kb-plain'], 'only an id with no branch tombstone stays "no verdict"');
        const s = buildKbChangesSection(report);
        assert.ok(s.text.includes(`${CARRIED.slice(0, 8)} "Cache keys by tenant id only"`), s.text);
        assert.ok(s.text.includes('(carried from an earlier run, not re-checked)'), s.text);
        assert.ok(s.text.includes('**No verdict (1):** kb-plain -- still CONFIRMED'), s.text);
        assert.doesNotMatch(s.text.split('\n').find((l) => l.includes('No verdict')), new RegExp(CARRIED.slice(0, 8)));
    });

    test('a carried id this run restored is not listed; one this run withdrew again is listed once', async () => {
        const other = 'kb-carried-and-withdrawn-again';
        const { client } = harness({ branchWithdrawals: reader({ ok: true, rows: [carriedRow(), carriedRow(other)] }) });
        await offerDemotions(client, []);
        await client.apply('reviewer', 'reviewer-1', {
            kb_holds: [CARRIED],
            kb_demotions: [{ id: other, reason: REASON, evidence_files: [CHANGED_FILE] }],
        });
        await client.commitRound('final review');
        const report = await client.kbChangesOnMerge();
        assert.deepEqual(report.carried, [], 'the restored id is gone, the re-withdrawn one is already listed');
        assert.deepEqual(report.withdrawn.map((w) => w.id), [other]);
        assert.equal(report.restored, 1);
    });

    test('a carried id held this run whose restore did not land is still listed as withdrawn on merge', async () => {
        const { client } = harness({
            branchWithdrawals: reader({ ok: true, rows: [carriedRow()] }),
            reshapeAnswer: (a) => ({ ...a, restored: [] }),
        });
        await offerDemotions(client, []);
        await client.apply('reviewer', 'reviewer-1', { kb_holds: [CARRIED] });
        await client.commitRound('final review');
        const report = await client.kbChangesOnMerge();
        assert.deepEqual(report.carried.map((c) => [c.id, c.kept]), [[CARRIED, true]]);
        assert.match(buildKbChangesSection(report).text, /held this run, but the restore is not on the branch/);
    });

    test('a held carried id whose restore is committed on the maintainer but never pushed (push rejected, reset unsafe) is still listed', async () => {
        // The offer reads the tombstone on the branch; the publish-time read is
        // the maintainer's HEAD, where the unpushed restore already lifted it.
        let reads = 0;
        const branchRead = Object.assign(async () => [], { read: async () => ({ ok: true, rows: reads++ === 0 ? [carriedRow()] : [] }) });
        const { client, logs } = harness({
            branchWithdrawals: branchRead,
            extra: {
                gPush: async () => { throw new Error('rejected: non-fast-forward'); },
                canResetCheckout: async () => ({ safe: false, reason: 'unrelated local work' }),
            },
        });
        await offerDemotions(client, []);
        await client.apply('reviewer', 'reviewer-1', { kb_holds: [CARRIED] });
        await client.commitRound('final review');
        assert.ok(logs.some((l) => /not resetting maintainer 'maint'/.test(l)), logs.join('\n'));

        const report = await client.kbChangesOnMerge();

        assert.deepEqual(report.carried, [{
            id: CARRIED, title: 'Cache keys by tenant id only', note: 'the earlier final review judged it false', kept: true, restoreNotPushed: true,
        }]);
        assert.equal(report.restored, 0);
        const s = buildKbChangesSection(report);
        assert.match(s.text, /^Merging withdraws 1 CONFIRMED KB claim\(s\); 1 carried from an earlier run, held but not restored/);
        assert.ok(s.text.includes(`- ${CARRIED.slice(0, 8)} "Cache keys by tenant id only" -- the earlier final review judged it false (carried from an earlier run; held this run; restore not in a pushed bible commit)`), s.text);
    });

    test('a held id that was never a branch tombstone is not listed when its restore is unpushed', async () => {
        const { client } = harness({
            branchWithdrawals: reader({ ok: true, rows: [] }),
            extra: {
                gPush: async () => { throw new Error('rejected: non-fast-forward'); },
                canResetCheckout: async () => ({ safe: false, reason: 'unrelated local work' }),
            },
        });
        await offerDemotions(client, [demotable('kb-plain')]);
        await client.apply('reviewer', 'reviewer-1', { kb_holds: ['kb-plain'] });
        await client.commitRound('final review');
        const report = await client.kbChangesOnMerge();
        assert.deepEqual(report.carried, []);
    });

    test('when the offer could not read the branch tombstones, an unpushed held id is listed (over-list, never hide)', async () => {
        let offerRead = true;
        const branchRead = Object.assign(async () => [], { read: async () => { if (offerRead) throw new Error('member unreachable'); return { ok: true, rows: [] }; } });
        const { client } = harness({
            branchWithdrawals: branchRead,
            extra: {
                gPush: async () => { throw new Error('rejected: non-fast-forward'); },
                canResetCheckout: async () => ({ safe: false, reason: 'unrelated local work' }),
            },
        });
        await offerDemotions(client, [demotable(CARRIED)]);
        offerRead = false;
        await client.apply('reviewer', 'reviewer-1', { kb_holds: [CARRIED] });
        await client.commitRound('final review');
        const report = await client.kbChangesOnMerge();
        assert.deepEqual(report.carried.map((c) => [c.id, c.restoreNotPushed]), [[CARRIED, true]]);
    });

    test('when the offer\'s branch read answers ok:false (the plain read is failSoft and answers []), an unpushed held carried id is listed', async () => {
        // The carried id is still CONFIRMED on the maintainer and cites a
        // changed file, so it is offered unmarked; HEAD already lost its
        // tombstone to the unpushed restore.
        let offerRead = true;
        const branchRead = Object.assign(async () => [], {
            read: async () => (offerRead
                ? { ok: false, rows: [], error: "'git show HEAD:.fleet/kb-canonical.json' on 'maint': failed" }
                : { ok: true, rows: [] }),
        });
        const { client, logs } = harness({
            branchWithdrawals: branchRead,
            extra: {
                gPush: async () => { throw new Error('rejected: non-fast-forward'); },
                canResetCheckout: async () => ({ safe: false, reason: 'unrelated local work' }),
            },
        });
        await offerDemotions(client, [demotable(CARRIED)]);
        offerRead = false;
        await client.apply('reviewer', 'reviewer-1', { kb_holds: [CARRIED] });
        await client.commitRound('final review');
        const report = await client.kbChangesOnMerge();
        assert.deepEqual(report.carried.map((c) => [c.id, c.kept, c.restoreNotPushed]), [[CARRIED, true, true]]);
        assert.ok(logs.some((l) => /could not read this branch's earlier withdrawals on maintainer 'maint'/.test(l)), logs.join('\n'));
    });

    test('a branch read that fails, throws, or runs on a maintainer off the sprint branch is an explicit line, never silence', async () => {
        const cases = [
            { branchWithdrawals: reader({ ok: false, rows: [], error: "'git show HEAD:.fleet/kb-canonical.json' on 'maint': failed" }) },
            { branchWithdrawals: Object.assign(async () => [], { read: async () => { throw new Error('member unreachable'); } }) },
            {
                branchWithdrawals: reader({ ok: true, rows: [carriedRow()] }),
                extra: { checkedOutBranch: async () => ({ branch: 'main', sprintBranch: 'feat/x' }) },
            },
        ];
        for (const c of cases) {
            const { client, logs } = harness({ ...c, extra: { demotionLoop: 'off', ...(c.extra || {}) } });
            const report = await client.kbChangesOnMerge();
            assert.ok(report, 'a failed read is a report, not null');
            assert.equal(report.unreadable.length, 1, JSON.stringify(report));
            assert.equal(report.unreadable[0].member, 'maint');
            assert.deepEqual(report.carried, []);
            const s = buildKbChangesSection(report);
            assert.match(s.text, /\*\*Branch tombstones could not be read\*\* \(maint: example\.com\/org\/repo\)/);
            assert.ok(logs.some((l) => /WARN: this branch's withdrawn tombstones could not be read/.test(l)), logs.join('\n'));
        }
    });

    test('no tombstone on the branch and nothing offered: no report (no section)', async () => {
        const { client } = harness({ branchWithdrawals: reader({ ok: true, rows: [] }), extra: { demotionLoop: 'off' } });
        assert.equal(await client.kbChangesOnMerge(), null);
    });

    test('a branchWithdrawals without .read is still read (rows only)', async () => {
        const { client } = harness({ branchWithdrawals: async () => [demotable(CARRIED)], extra: { demotionLoop: 'off' } });
        const report = await client.kbChangesOnMerge();
        assert.deepEqual(report.carried.map((c) => [c.id, c.title]), [[CARRIED, CARRIED]]);
    });
});
