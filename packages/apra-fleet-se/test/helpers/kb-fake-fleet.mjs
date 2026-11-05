// The fake fleet shared by the mock-sprint KB scenarios: per-member KBs keyed
// by member uuid, per-member checkouts, a mocked callTool that answers
// `apra-fleet call --member <uuid> <tool>` from the fake KB, and the onCommand
// hook that turns a maintainer G-pull into a checkout update. See
// mock-sprint-kb-write-routing.test.mjs for the full description.
import fs from 'node:fs';
import { defaultMockCallTool } from './mock-sprint-harness.mjs';

export function memberUuid(name) {
    const hex = Buffer.from(name).toString('hex').padEnd(12, '0').slice(0, 12);
    return `0b9d3a1e-5f2c-4c6e-9a7b-${hex}`;
}

export const isWriteTool = (tool) => tool === 'kb_capture' || tool === 'kb_promote' || tool === 'kb_invalidate';

/**
 * A fake fleet: per-member KBs (keyed by member uuid), per-member checkouts,
 * the files published to the remote branch, and one ordered event list.
 */
export function createFakeFleet() {
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
                    type: args.type, title: args.title, summary: args.summary, content: args.content, trigger: args.trigger,
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
                    else {
                        e.superseded_at = new Date().toISOString();
                        // The retirement note kb_invalidate {ids, reason} stores.
                        if (typeof args.reason === 'string') e.retired_reason = args.reason;
                        out.discarded.push(i);
                    }
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
        if (typeof name === 'string' && name.startsWith('kb_')) {
            fleet.orchestratorKbCalls.push({ name, args });
            return { content: [{ type: 'text', text: '{}' }] };
        }
        if (name === 'send_files') {
            for (const p of args.local_paths || []) lastArgs = JSON.parse(fs.readFileSync(p, 'utf8'));
            return { content: [{ type: 'text', text: 'sent' }] };
        }
        if (name === 'execute_command' && typeof args.command === 'string' && args.command.includes('apra-fleet call') && args.command.includes('--list-tools')) {
            // A current member server: its kb_import advertises `ref` (the
            // engine's version gate before the priming grant import).
            fleet.events.push({ type: 'list-tools' });
            return { content: [{ type: 'text', text: JSON.stringify({ tools: [{ name: 'kb_import', inputSchema: { type: 'object', properties: { path: { type: 'string' }, ref: { type: 'string' }, skip_sweep: { type: 'boolean' } } } }] }) }] };
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
export function buildOnCommand(fleet) {
    return ({ command, member_name: member }) => {
        if (/^git fetch origin /.test(command)) fleet.events.push({ type: 'gfetch', member });
        if (/^git merge --ff-only origin\//.test(command)) {
            fleet.gPull(member);
            fleet.events.push({ type: 'gpull', member });
        }
        return undefined;
    };
}

/** Parse the promotion-candidate block out of a reviewer prompt: its entry ids, or null when absent. */
export function candidateIds(prompt) {
    const m = /Source: kb_query --tag[^\n]*\n(`{3,})[^\n]*\n([\s\S]*?)\n\1/.exec(prompt || '');
    return m ? JSON.parse(m[2]).map((e) => e.id) : null;
}

