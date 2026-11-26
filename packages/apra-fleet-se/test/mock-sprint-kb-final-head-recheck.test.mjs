import fs from 'node:fs';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runDevelopLoopScenario, withScenarioMarkers, defaultMockCallTool, mockCmdResult, runCmd } from './helpers/mock-sprint-harness.mjs';
import { scaledTimeout } from './helpers/scaled-timeout.mjs';
import { ALL_KB_ROUTES, CURRENT_FLEET_BUILD } from './helpers/kb-maintainer-fakes.mjs';

// =============================================================================
// A sprint's own bible entries are re-checked at the branch's final head.
//
// The sprint commits a bible entry before its last code commits, so a later
// commit can change a file the entry cites and leave the PR's bible with a
// drifted basis. Before the final review the engine re-sends every id this
// sprint's bible commits merged; one whose cited files changed comes back as
// a basis_mismatch skip and is offered to the final reviewer for
// re-verification. CONFIRM: kb_promote re-stamps it at HEAD and the final
// review's bible commit re-merges it with the fresh basis. Refusal: it is
// withdrawn from the branch bible with a WARN. Nothing drifted: no extra
// bible commit.
//
// Driven through the REAL runner with the mock-sprint harness. Every member
// is REMOTE; each member-scoped kb_* call is answered by a fake per-member KB
// that versions files: a G-pull copies the published file versions into the
// member's checkout, kb_promote stamps an entry's basis from the maintainer's
// checkout (re-stamping a CONFIRMED one, rebased: true when it moved), and
// kb_bible_commit merges an id only while its basis matches the checkout.
// =============================================================================

const REPO_URL = 'https://github.com/mock-org/mock-repo.git';
const CITED = 'src/widget-cache.ts';
const BIBLE_FILE = '.fleet/kb-canonical.json';
const ENTRY_ID = 'ffff6666-kb-cache-keys-by-tenant';

function memberUuid(name) {
    const hex = Buffer.from(name).toString('hex').padEnd(12, '0').slice(0, 12);
    return `0b9d3a1e-5f2c-4c6e-9a7b-${hex}`;
}

function createFakeFleet() {
    const kbs = new Map();          // member uuid -> entries[]
    const checkouts = new Map();    // member name -> Map<file, version>
    const published = new Map();    // file -> version on the remote branch
    const events = [];
    const bible = { entries: new Map(), tombstones: new Set() }; // id -> basis {file: version}
    const bibleCommits = [];        // every kb_bible_commit that changed the bible
    const fleetState = { unpushedBible: false }; // a local bible commit not pushed yet

    const kbOf = (id) => { if (!kbs.has(id)) kbs.set(id, []); return kbs.get(id); };
    const checkoutOf = (name) => { if (!checkouts.has(name)) checkouts.set(name, new Map()); return checkouts.get(name); };
    const ownTag = (id) => `member:${id}`;
    const stamp = (name, files) => Object.fromEntries(files.map((f) => [f, checkoutOf(name).get(f) ?? null]));
    const drift = (name, e) => e.source_files
        .filter((f) => (e.basis || {})[f] !== (checkoutOf(name).get(f) ?? null))
        .map((f) => ({ path: f, reason: checkoutOf(name).has(f) ? 'changed' : 'absent' }));
    const bibleState = () => JSON.stringify([[...bible.entries].sort(), [...bible.tombstones].sort()]);

    function memberTool(name, id, tool, args) {
        const kb = kbOf(id);
        const own = (e) => e.tags.includes(ownTag(id));
        const fail = (message) => { const e = new Error(message); e.toolCode = 'E-TOOL'; throw e; };
        switch (tool) {
            case 'kb_stats': return { entries: kb.length };
            case 'kb_capabilities': return { contract: 'v1', routes: [...ALL_KB_ROUTES], branch_aware: false, fleet_build: { ...CURRENT_FLEET_BUILD } };
            case 'kb_import': return { imported: 0 };
            case 'kb_session_prime': return { top_entries: [] };
            case 'kb_query': {
                if (typeof args.tag !== 'string') return { l1_results: [], related_claims: [] };
                const tiers = Array.isArray(args.confidence) ? args.confidence : ['CONFIRMED'];
                const hits = kb.filter((e) => e.tags.includes(args.tag) && tiers.includes(e.confidence) && !e.superseded_at);
                return { l1_results: hits.slice(0, args.limit ?? 20).map((e) => ({ ...e })) };
            }
            case 'kb_promote': {
                const e = kb.find((x) => x.id === args.id && own(x));
                if (!e) fail(`Entry not found: ${args.id}`);
                const before = e.confidence;
                const basis = stamp(name, e.source_files);
                const rebased = before === 'CONFIRMED' && JSON.stringify(basis) !== JSON.stringify(e.basis);
                e.confidence = 'CONFIRMED';
                e.basis = basis;
                return { id: e.id, previous_confidence: before, new_confidence: 'CONFIRMED', ...(before === 'CONFIRMED' ? { rebased } : {}) };
            }
            case 'kb_invalidate': {
                const out = { discarded: [], not_found: [], already_discarded: [] };
                for (const i of args.ids || []) {
                    const e = kb.find((x) => x.id === i && own(x));
                    if (!e) out.not_found.push(i);
                    else { e.superseded_at = new Date().toISOString(); out.discarded.push(i); }
                }
                return out;
            }
            case 'kb_bible_commit': {
                const before = bibleState();
                const merged = [];
                const skipped = [];
                for (const i of args.ids || []) {
                    const e = kb.find((x) => x.id === i && x.confidence === 'CONFIRMED');
                    if (!e) { skipped.push({ id: i, reason: 'not_confirmed_or_unknown' }); continue; }
                    const changed = drift(name, e);
                    if (changed.length > 0) { skipped.push({ id: i, reason: 'basis_mismatch', changed_files: changed }); continue; }
                    merged.push(i);
                    bible.entries.set(i, { ...e.basis });
                    bible.tombstones.delete(i);
                }
                const withdrawn = [];
                for (const w of args.withdrawals || []) {
                    if (!bible.entries.has(w.id) && !kb.some((x) => x.id === w.id && x.confidence === 'CONFIRMED')) {
                        skipped.push({ id: w.id, reason: 'not_withdrawable' });
                        continue;
                    }
                    withdrawn.push(w.id);
                    bible.entries.delete(w.id);
                    bible.tombstones.add(w.id);
                }
                const restored = (args.restore_ids || []).filter((i) => bible.tombstones.has(i));
                // Unchanged content (bases included) is a no-op: no commit.
                const committed = bibleState() !== before;
                if (committed) {
                    bibleCommits.push({ ids: [...(args.ids || [])], merged, withdrawn });
                    fleetState.unpushedBible = true;
                }
                return { path: BIBLE_FILE, merged, demoted: [], withdrawn, restored, skipped, removed: [], entry_count: bible.entries.size, committed };
            }
            default: return {};
        }
    }

    return {
        kbs, checkouts, published, events, bible, bibleCommits, fleetState, kbOf, checkoutOf, memberTool,
        seedEntry(memberName, entry) {
            kbOf(memberUuid(memberName)).push({ tags: [ownTag(memberUuid(memberName))], confidence: 'INFERRED', superseded_at: null, basis: {}, ...entry });
        },
        gPull(name) {
            for (const [f, v] of published) checkoutOf(name).set(f, v);
        },
    };
}

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
        if (typeof name === 'string' && name.startsWith('kb_')) return { content: [{ type: 'text', text: '{}' }] };
        if (name === 'send_files') {
            const kbArgs = (args.local_paths || []).filter((p) => !/vcs-body-/.test(p));
            for (const p of kbArgs) lastArgs = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (kbArgs.length === (args.local_paths || []).length) return { content: [{ type: 'text', text: 'sent' }] };
        }
        if (name === 'execute_command' && typeof args.command === 'string' && args.command.includes('apra-fleet call') && args.command.includes('--list-tools')) {
            return { content: [{ type: 'text', text: JSON.stringify({ tools: [
                { name: 'kb_capabilities', inputSchema: { type: 'object', properties: {} } },
                { name: 'kb_import', inputSchema: { type: 'object', properties: { path: { type: 'string' }, ref: { type: 'string' }, skip_sweep: { type: 'boolean' } } } },
                { name: 'kb_bible_commit', inputSchema: { type: 'object', properties: { ids: { type: 'array' }, withdrawals: { type: 'array' }, restore_ids: { type: 'array' } } } },
            ] }) }] };
        }
        if (name === 'execute_command' && typeof args.command === 'string' && args.command.includes('apra-fleet call')) {
            const m = /apra-fleet call --member (\S+) (?:--kb-maintainer )?(\w+) --args-file/.exec(args.command);
            const id = m && m[1];
            const tool = m && m[2];
            const member = byId.get(id);
            const grant = / --kb-maintainer /.test(args.command);
            fleet.events.push({ type: 'kb', member, tool, args: lastArgs, grant });
            if (tool === 'kb_promote' && !grant) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: { code: 'E-TOOL', message: 'MCP error -32602: Tool kb_promote not found' } }) }] };
            }
            try {
                return { content: [{ type: 'text', text: JSON.stringify(fleet.memberTool(member, id, tool, lastArgs || {})) }] };
            } catch (err) {
                return { content: [{ type: 'text', text: JSON.stringify({ error: { code: err.toolCode || 'E-TOOL', message: err.message } }) }] };
            }
        }
        return base(name, args);
    };
}

function buildOnCommand(fleet) {
    return (ev) => {
        if (/^git merge --ff-only origin\//.test(ev.command)) fleet.gPull(ev.member_name);
        if (/^git rev-list --count /.test(ev.command)) return mockCmdResult(0, '1\n', '');
        if (ev.member_name !== 'maint') return undefined;
        if (/^git rev-parse HEAD\s*$/.test(ev.command)) return mockCmdResult(0, 'b'.repeat(40), '');
        if (/^git diff --name-only \S+\.\.\.\S+\s*$/.test(ev.command)) return mockCmdResult(0, `${CITED}\n`, '');
        if (/^git merge-base HEAD origin\//.test(ev.command)) return mockCmdResult(0, 'a'.repeat(40), '');
        // The bible is a local-only commit between a committing
        // kb_bible_commit and the next push; the work tree is always clean.
        if (/^git push\b/.test(ev.command)) fleet.fleetState.unpushedBible = false;
        if (/^git log -m --name-only --pretty=format: /.test(ev.command)) return mockCmdResult(0, fleet.fleetState.unpushedBible ? `${BIBLE_FILE}\n` : '', '');
        if (/^git status --porcelain --untracked-files=all -- /.test(ev.command)) return mockCmdResult(0, '', '');
        if (/^git diff --name-only origin\/\S+ HEAD -- /.test(ev.command)) return mockCmdResult(0, '', '');
        return undefined;
    };
}

/**
 * One sprint, two cycles. Cycle 1's doer publishes CITED v1; the round-1
 * reviewer promotes ENTRY_ID (stamped at v1) and reopens the bead, so the
 * round's bible commit merges the entry at v1. Cycle 2's doer publishes
 * CITED at `secondVersion` (2: a later commit changes the cited file; 1:
 * nothing drifts). `finalVerdict` decides what the final reviewer returns
 * for a re-verification candidate: 'confirm', 'refuse', or null (none).
 */
async function runRecheckSprint(label, { secondVersion, finalVerdict }) {
    const fleet = createFakeFleet();
    let doerCalls = 0;
    const doerHandler = async ({ opts, tempDir, runCmd: run }) => {
        doerCalls += 1;
        // The entry is captured during the sprint (inside the promotion
        // window), as an INFERRED entry on the maintainer.
        if (doerCalls === 1) {
            fleet.seedEntry('maint', {
                id: ENTRY_ID, type: 'knowledge', title: 'Cache keys carry the tenant id', summary: 'Every widget cache key starts with the tenant id.',
                source_files: [CITED], created_at: new Date().toISOString(),
            });
        }
        const ids = (opts.prompt.match(/Assigned bead ids \(comma-separated\):\s*(.+)/)?.[1] || '').split(',').map((s) => s.trim()).filter(Boolean);
        for (const id of ids) await run(`bd close ${id}`, tempDir);
        fleet.published.set(CITED, doerCalls === 1 ? 1 : secondVersion);
        return { content: [{ text: JSON.stringify({ status: 'VERIFY', closedIds: ids, notes: 'done' }) }] };
    };
    const reviewerHandler = async ({ reviewRound, tempDir, opts }) => {
        if (reviewRound === 1) {
            const list = JSON.parse((await runCmd('bd list --all --json', tempDir)).stdout || '[]');
            const task = list.find((b) => /^Task: kb final head recheck/.test(b.title));
            const offered = opts.prompt.includes(`"id": "${ENTRY_ID}"`);
            return { content: [{ text: JSON.stringify({
                verdict: 'CHANGES_NEEDED', notes: 'One more change needed.', reopenIds: [task.id], newTasks: [],
                ...(offered ? { kb_promotions: [{ id: ENTRY_ID, reason: `verified against ${CITED}:12, the key builder prefixes the tenant id` }] } : {}),
            }) }] };
        }
        return { content: [{ text: JSON.stringify({ verdict: 'APPROVED', notes: 'Approved.', reopenIds: [], newTasks: [] }) }] };
    };
    let finalPrompt = null;
    const finalReviewHandler = async ({ opts }) => {
        finalPrompt = opts.prompt;
        const at = opts.prompt.indexOf('KNOWLEDGE BANK -- re-verification candidates');
        const offered = at >= 0 && opts.prompt.slice(at).includes(`"id": "${ENTRY_ID}"`);
        const kb = !offered || !finalVerdict ? {}
            : finalVerdict === 'confirm'
                ? { kb_promotions: [{ id: ENTRY_ID, reason: `re-checked ${CITED}:14 at HEAD, the tenant prefix is still applied` }] }
                : { kb_discards: [{ id: ENTRY_ID, reason: `${CITED}:14 now keys by region; the tenant claim no longer holds` }] };
        return { content: [{ text: JSON.stringify({ verdict: 'PASS', notes: 'All goal beads closed.', ...kb }) }] };
    };
    const r = await runDevelopLoopScenario(label, {
        members: ['maint', 'dev'],
        roleMap: { doer: ['dev'], reviewer: ['dev'] },
        beadsIdentity: { maint: { repoRemote: REPO_URL }, dev: { repoRemote: REPO_URL } },
        taskSpecs: [{ title: `Task: kb final head recheck ${label}` }],
        doerHandler, reviewerHandler, finalReviewHandler,
        maxCycles: 2,
        callToolFactory: (executeCommand) => buildCallTool(fleet, executeCommand),
        onCommand: buildOnCommand(fleet),
    });
    return { r, fleet, finalPrompt: () => finalPrompt, doerCalls: () => doerCalls };
}

describe('mock sprint: the sprint\'s own bible entries are re-checked at the final head', () => {
    test('a later commit drifts an entry; the final reviewer confirms it -> the branch bible carries its basis at the final head', { timeout: scaledTimeout(240000) }, async () => {
        await withScenarioMarkers('kb final head recheck confirm', async () => {
            const { r, fleet, finalPrompt, doerCalls } = await runRecheckSprint('recheckconfirm', { secondVersion: 2, finalVerdict: 'confirm' });
            assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
            assert.equal(doerCalls(), 2, 'sanity: the cited file changed in a second develop round');
            assert.ok(fleet.bibleCommits.length >= 1 && fleet.bibleCommits[0].merged.includes(ENTRY_ID), `sanity: the round-1 bible commit merged the entry; log:\n${r.logs.filter((l) => l.includes('[kb-work]')).join('\n')}`);

            const at = finalPrompt().indexOf('KNOWLEDGE BANK -- re-verification candidates');
            assert.ok(at >= 0, 'the final reviewer is offered the drifted entry for re-verification');
            assert.ok(finalPrompt().slice(at).includes(`"path": "${CITED}"`), 'naming the changed cited file');

            const promotes = fleet.events.filter((e) => e.type === 'kb' && e.tool === 'kb_promote' && e.args.id === ENTRY_ID);
            assert.equal(promotes.length, 2, 'promoted once in round 1, re-stamped once at the final review');
            assert.ok(promotes.every((e) => e.member === 'maint' && e.grant), 'both on the maintainer as kb_maintainer');

            assert.ok(fleet.bible.entries.has(ENTRY_ID), 'the branch bible still carries the entry');
            assert.deepEqual(fleet.bible.entries.get(ENTRY_ID), { [CITED]: fleet.published.get(CITED) }, 'its basis matches the cited file at the final head');
            assert.equal(fleet.published.get(CITED), 2);
            assert.ok(!r.logs.some((l) => /WARN: dropping /.test(l)), r.logs.filter((l) => l.includes('[kb-work]')).join('\n'));
        });
    });

    test('a later commit drifts an entry; the final reviewer refuses it -> the branch bible no longer carries it and a WARN names it', { timeout: scaledTimeout(240000) }, async () => {
        await withScenarioMarkers('kb final head recheck refuse', async () => {
            const { r, fleet } = await runRecheckSprint('recheckrefuse', { secondVersion: 2, finalVerdict: 'refuse' });
            assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
            assert.ok(fleet.bibleCommits[0] && fleet.bibleCommits[0].merged.includes(ENTRY_ID), 'sanity: the round-1 bible commit merged the entry');

            assert.ok(!fleet.bible.entries.has(ENTRY_ID), 'the final branch bible does not carry the refused entry');
            const warn = r.logs.find((l) => /\[kb-work\] WARN: dropping /.test(l) && l.includes(ENTRY_ID));
            assert.ok(warn, r.logs.filter((l) => l.includes('[kb-work]')).join('\n'));
            assert.ok(warn.includes(CITED), 'the WARN names the changed cited file');
            assert.match(warn, /withdrawal is queued/);
            const row = fleet.kbOf(memberUuid('maint')).find((e) => e.id === ENTRY_ID);
            assert.equal(row.confidence, 'CONFIRMED', 'the maintainer\'s local entry is neither deleted nor demoted');
            assert.equal(row.superseded_at, null);
            const kbTools = fleet.events.filter((e) => e.type === 'kb').map((e) => e.tool);
            assert.ok(!kbTools.includes('kb_invalidate') && !kbTools.includes('kb_demote'), `no delete or demote: ${kbTools.join(', ')}`);
        });
    });

    test('nothing drifts after the sprint\'s bible commit -> no extra bible commit', { timeout: scaledTimeout(240000) }, async () => {
        await withScenarioMarkers('kb final head recheck no drift', async () => {
            const { r, fleet, finalPrompt, doerCalls } = await runRecheckSprint('recheckclean', { secondVersion: 1, finalVerdict: 'confirm' });
            assert.equal(r.error, null, `sprint error: ${r.error && r.error.message}`);
            assert.equal(doerCalls(), 2, 'sanity: a second develop round ran');
            assert.equal(fleet.bibleCommits.length, 1, `only the round-1 bible commit changed the bible: ${JSON.stringify(fleet.bibleCommits)}`);
            assert.ok(!finalPrompt().includes('KNOWLEDGE BANK -- re-verification candidates'), 'nothing to re-verify');
            assert.ok(r.logs.some((l) => /final head: every bible entry this sprint committed for .* still matches the branch head/.test(l)),
                r.logs.filter((l) => l.includes('[kb-work]')).join('\n'));
            assert.deepEqual(fleet.bible.entries.get(ENTRY_ID), { [CITED]: 1 });
        });
    });
});
