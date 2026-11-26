// Fake per-member KB fleet for mock-sprint bible tests (shared by
// mock-sprint-kb-final-head-recheck and mock-sprint-kb-post-harvest-recheck).
//
// Every member is REMOTE; each member-scoped kb_* call is answered by a fake
// per-member KB that versions files: a G-pull copies the published file
// versions into the member's checkout, kb_promote stamps an entry's basis from
// the maintainer's checkout (re-stamping a CONFIRMED one, rebased: true when
// it moved), and kb_bible_commit merges an id only while its basis matches the
// checkout.
import fs from 'node:fs';
import { defaultMockCallTool, mockCmdResult } from './mock-sprint-harness.mjs';
import { ALL_KB_ROUTES, CURRENT_FLEET_BUILD } from './kb-maintainer-fakes.mjs';

export const BIBLE_FILE = '.fleet/kb-canonical.json';

export function memberUuid(name) {
    const hex = Buffer.from(name).toString('hex').padEnd(12, '0').slice(0, 12);
    return `0b9d3a1e-5f2c-4c6e-9a7b-${hex}`;
}

export function createFakeFleet() {
    const kbs = new Map();          // member uuid -> entries[]
    const checkouts = new Map();    // member name -> Map<file, version>
    const published = new Map();    // file -> version on the remote branch
    const events = [];
    const bible = { entries: new Map(), tombstones: new Set() }; // id -> basis {file: version}
    // The bible at the merge-base commit (id -> basis): what a restore re-adds and what `git show <base>:<bible>` reads.
    const baseEntries = new Map();
    const bibleCommits = [];        // every kb_bible_commit that changed the bible
    // unpushedBible: a local bible commit not pushed yet. failBibleCommit: every kb_bible_commit fails
    // (a maintainer whose bible commit cannot be reached). refuseBiblePush: the maintainer's git push is rejected.
    const fleetState = { unpushedBible: false, failBibleCommit: false, refuseBiblePush: false };

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
                if (fleetState.failBibleCommit) fail('maintainer unreachable: kb_bible_commit could not run');
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
                for (const i of restored) {
                    bible.tombstones.delete(i);
                    if (baseEntries.has(i)) bible.entries.set(i, { ...baseEntries.get(i) });
                }
                // Unchanged content (bases included) is a no-op: no commit.
                const committed = bibleState() !== before;
                if (committed) {
                    bibleCommits.push({ ids: [...(args.ids || [])], merged, withdrawn, restored });
                    fleetState.unpushedBible = true;
                }
                return { path: BIBLE_FILE, merged, demoted: [], withdrawn, restored, skipped, removed: [], entry_count: bible.entries.size, committed };
            }
            default: return {};
        }
    }

    return {
        kbs, checkouts, published, events, bible, baseEntries, bibleCommits, fleetState, kbOf, checkoutOf, memberTool,
        seedEntry(memberName, entry) {
            kbOf(memberUuid(memberName)).push({ tags: [ownTag(memberUuid(memberName))], confidence: 'INFERRED', superseded_at: null, basis: {}, ...entry });
        },
        gPull(name) {
            for (const [f, v] of published) checkoutOf(name).set(f, v);
        },
    };
}

export function buildCallTool(fleet, executeCommand) {
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

/** `changedFiles`: what the maintainer's `git diff --name-only base...head` lists. */
export function buildOnCommand(fleet, { changedFiles }) {
    return (ev) => {
        if (/^git merge --ff-only origin\//.test(ev.command)) fleet.gPull(ev.member_name);
        if (/^git rev-list --count /.test(ev.command)) return mockCmdResult(0, '1\n', '');
        if (ev.member_name !== 'maint') return undefined;
        if (/^git rev-parse HEAD\s*$/.test(ev.command)) return mockCmdResult(0, 'b'.repeat(40), '');
        if (/^git diff --name-only \S+\.\.\.\S+\s*$/.test(ev.command)) return mockCmdResult(0, changedFiles.map((f) => `${f}\n`).join(''), '');
        if (/^git merge-base HEAD origin\//.test(ev.command)) return mockCmdResult(0, 'a'.repeat(40), '');
        if (/^git ls-tree --name-only a{40} -- /.test(ev.command)) return mockCmdResult(0, fleet.baseEntries.size > 0 ? `${BIBLE_FILE}\n` : '', '');
        if (/^git show a{40}:/.test(ev.command)) return mockCmdResult(0, JSON.stringify({ entries: [...fleet.baseEntries.keys()].map((id) => ({ id })) }), '');
        // The bible is a local-only commit between a committing
        // kb_bible_commit and the next push; the work tree is always clean.
        if (/^git push\b/.test(ev.command) && fleet.fleetState.refuseBiblePush && fleet.fleetState.unpushedBible) return mockCmdResult(1, '', '! [rejected] (fetch first)');
        if (/^git push\b/.test(ev.command)) fleet.fleetState.unpushedBible = false;
        if (/^git log -m --name-only --pretty=format: /.test(ev.command)) return mockCmdResult(0, fleet.fleetState.unpushedBible ? `${BIBLE_FILE}\n` : '', '');
        if (/^git status --porcelain --untracked-files=all -- /.test(ev.command)) return mockCmdResult(0, '', '');
        if (/^git diff --name-only origin\/\S+ HEAD -- /.test(ev.command)) return mockCmdResult(0, '', '');
        return undefined;
    };
}
