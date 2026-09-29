import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createDispatchAccounting, CODE_CALLS_NOT_OBSERVABLE } from '../fleet-sprint/dispatch-accounting.mjs';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import { renderKbCodeIntelHtml, renderBeadsHtml, kbCodeIntelExtension, beadsExtension } from '../fleet-sprint/viewer-extensions.mjs';
import { driveEngineDispatch } from './helpers/dispatch-role-harness.mjs';

// =============================================================================
// apra-fleet-b4g.34 -- acceptance suite for the kbpanel lane: apra-fleet-b4g.33
// (accounting) and apra-fleet-b4g.21 (panel). Numbered to this bead's own 14
// assertions. Every dependency (callTool) is stubbed -- no real MCP server,
// network or sprint run.
//
// Assertion 14 ("reverting the accounting change makes assertion 1 fail;
// reverting the panel change makes assertion 7 fail") was verified by hand
// during authoring (git-stash the implementation files, re-run this suite,
// confirm the module-not-found / missing-export failure, restore) -- see the
// doer's final report for the exact command/output. It is not re-encoded as
// its own runtime test because "does removing the file break the import"
// is not a property `node --test` can assert on a live module graph.
// =============================================================================

/** A callTool stub that drives kb_list/kb_query/kb_capture/kb_promote/kb_export exactly the way a real dispatch would. */
function createStubCallTool() {
    const calls = [];
    async function callTool(name, args) {
        calls.push({ name, args });
        if (name === 'kb_list') return { content: [{ text: JSON.stringify({ results: [{ id: 'e1', type: 'knowledge' }] }) }] };
        if (name === 'kb_query') return { content: [{ text: JSON.stringify({ l1_results: [{ id: 'e1', title: 'a fact' }] }) }] };
        if (name === 'kb_capture') {
            if (args.title === 'rejected-by-tool') return { isError: true, content: [{ text: 'zod validation failed' }] };
            if (args.title === 'throws') throw new Error('transport reset mid-capture');
            return { content: [{ text: '{}' }] };
        }
        if (name === 'kb_promote') return { content: [{ text: '{}' }] };
        if (name === 'kb_export') return { content: [{ text: '{}' }] };
        throw new Error('unexpected tool: ' + name);
    }
    return { callTool, calls };
}

describe('assertion 1 -- accounting kb_* counts, driven through the real kb.mjs call sites, keyed by role and member', () => {
    test('a stubbed doer dispatch making a known set of kb_* calls is counted exactly', async () => {
        const accounting = createDispatchAccounting();
        const { callTool } = createStubCallTool();
        const kbWork = createKbWorkClient({ callTool, accounting });
        const dispatch = { role: 'doer', member: 'alice' };

        await kbWork.relevantKnowledge('/r/alice', ['term'], dispatch); // 1x kb_query
        await kbWork.promotionCandidates('/r/alice', dispatch); // 1x kb_list
        await kbWork.apply('doer', '/r/alice', {
            kb_captures: [
                { type: 'knowledge', title: 'kept-1', summary: 's', content: 'c', source_files: ['a.ts'] },
                { type: 'knowledge', title: 'rejected-by-tool', summary: 's', content: 'c', source_files: ['b.ts'] },
                { type: 'knowledge', title: 'throws', summary: 's', content: 'c', source_files: ['c.ts'] },
            ],
        }, { member: 'alice' }); // 3x kb_capture attempts
        await kbWork.exportBible('/r/alice', dispatch); // 1x kb_export

        const rec = accounting.dispatchRecordFor('doer', 'alice');
        assert.ok(rec, 'a record must exist for (doer, alice) after real calls');
        assert.deepEqual(rec.kbCounts, { kb_list: 1, kb_query: 1, kb_capture: 3, kb_promote: 0, kb_export: 1 },
            'counts must match exactly, including the untouched tool (kb_promote) staying at its zero-init');
    });

    test('a second, independent (role, member) pair through the same client is counted separately', async () => {
        const accounting = createDispatchAccounting();
        const { callTool } = createStubCallTool();
        const kbWork = createKbWorkClient({ callTool, accounting });

        await kbWork.relevantKnowledge('/r/bob', ['q'], { role: 'reviewer', member: 'bob' });
        await kbWork.promotionCandidates('/r/bob', { role: 'reviewer', member: 'bob' });
        await kbWork.apply('reviewer', '/r/bob', {
            kb_promotions: [{ id: 'e1', reason: 'verified against the diff and the cited test file directly' }],
        }, { member: 'bob' });

        const alice = accounting.dispatchRecordFor('doer', 'alice');
        const bob = accounting.dispatchRecordFor('reviewer', 'bob');
        assert.equal(alice, null, 'a role/member pair this test never touched must have no record');
        assert.equal(bob.kbCounts.kb_query, 1);
        assert.equal(bob.kbCounts.kb_list, 1);
        assert.equal(bob.kbCounts.kb_promote, 1);
        assert.equal(bob.kbCounts.kb_capture, 0, 'untouched tool is explicit 0, not absent, WITHIN an existing record');
    });
});

describe('assertion 2 -- code_* is the not-observable marker, never 0, distinct from an absent record', () => {
    test('an existing dispatch record always carries the marker, never a number', async () => {
        const accounting = createDispatchAccounting();
        const { callTool } = createStubCallTool();
        const kbWork = createKbWorkClient({ callTool, accounting });
        await kbWork.relevantKnowledge('/r/carol', ['x'], { role: 'doer', member: 'carol' });

        const rec = accounting.dispatchRecordFor('doer', 'carol');
        assert.equal(rec.code.status, CODE_CALLS_NOT_OBSERVABLE);
        assert.notEqual(typeof rec.code.status, 'number');
        assert.notEqual(rec.code.status, 0);
    });

    test('a role/member pair never touched has NO record at all -- absent, not a zero and not a marker', () => {
        const accounting = createDispatchAccounting();
        assert.equal(accounting.dispatchRecordFor('doer', 'nobody'), null);
    });
});

describe('assertion 3 -- the preflight code signal is readable from the SAME store the panel reads', () => {
    test('preflightCodeOutcomeFor reflects each member exactly as setPreflightRecords received it', () => {
        const accounting = createDispatchAccounting();
        const records = [
            { member: 'm-ok', repoPath: '/r', remoteUrl: null, mcpScope: null, kbEntryCount: 1, checks: { code: { outcome: 'ok' } }, warnings: [] },
            { member: 'm-not-ready', repoPath: '/r', remoteUrl: null, mcpScope: null, kbEntryCount: 0, checks: { code: { outcome: 'index-not-ready' } }, warnings: [] },
            { member: 'm-unavailable', repoPath: '/r', remoteUrl: null, mcpScope: null, kbEntryCount: 0, checks: { code: { outcome: 'tool-unavailable' } }, warnings: [] },
            { member: 'm-unscoped', repoPath: null, remoteUrl: null, mcpScope: { scoped: false, reason: 'r' }, kbEntryCount: 0, checks: { code: { outcome: 'unscoped' } }, warnings: [] },
        ];
        accounting.setPreflightRecords(records);

        assert.equal(accounting.preflightCodeOutcomeFor('m-ok'), 'ok');
        assert.equal(accounting.preflightCodeOutcomeFor('m-not-ready'), 'index-not-ready');
        assert.equal(accounting.preflightCodeOutcomeFor('m-unavailable'), 'tool-unavailable');
        assert.equal(accounting.preflightCodeOutcomeFor('m-unscoped'), 'unscoped');

        // Same store the panel reads: preflightRecords() returns the identical array.
        assert.deepEqual(accounting.preflightRecords(), records);
    });
});

describe('assertion 4 -- kept vs rejected captures, cause retained, both the isError and the throw path in kb.mjs', () => {
    test('both rejection paths are recorded distinctly from a kept capture, with cause', async () => {
        const accounting = createDispatchAccounting();
        const { callTool } = createStubCallTool();
        const kbWork = createKbWorkClient({ callTool, accounting });

        const { captured } = await kbWork.apply('doer', '/r/dave', {
            kb_captures: [
                { type: 'knowledge', title: 'kept-1', summary: 's', content: 'c', source_files: ['a.ts'] },
                { type: 'knowledge', title: 'rejected-by-tool', summary: 's', content: 'c', source_files: ['b.ts'] },
                { type: 'knowledge', title: 'throws', summary: 's', content: 'c', source_files: ['c.ts'] },
            ],
        }, { member: 'dave' });

        assert.equal(captured, 1, 'only the genuinely-kept capture increments the real captured count');
        const rec = accounting.dispatchRecordFor('doer', 'dave');
        const byTitle = Object.fromEntries(rec.captureOutcomes.map((c) => [c.title, c]));
        assert.equal(byTitle['kept-1'].outcome, 'kept');
        assert.equal(byTitle['rejected-by-tool'].outcome, 'rejected');
        assert.match(byTitle['rejected-by-tool'].cause, /zod validation failed/);
        assert.equal(byTitle['rejected-by-tool'].source, 'isError');
        assert.equal(byTitle['throws'].outcome, 'rejected');
        assert.match(byTitle['throws'].cause, /transport reset mid-capture/);
        assert.equal(byTitle['throws'].source, 'throw');
        assert.equal(rec.captureOutcomes.length, 3, 'a rejected capture must not vanish from the record');
    });
});

describe('assertion 5 -- accounting is best-effort and non-fatal: the underlying kb/code call result is unchanged even when recording throws', () => {
    test('a throwing accounting object never fails the dispatch or changes its real result', async () => {
        const brokenAccounting = {
            forDispatch() { throw new Error('accounting store is down'); },
            recordKbCall() { throw new Error('still down'); },
            recordCaptureOutcome() { throw new Error('still down'); },
        };
        const { callTool } = createStubCallTool();
        const kbWork = createKbWorkClient({ callTool, accounting: brokenAccounting });

        const knowledge = await kbWork.relevantKnowledge('/r/eve', ['q'], { role: 'doer', member: 'eve' });
        assert.equal(knowledge.length, 1, 'the real kb_query result is unaffected by a broken accounting object');

        const { captured, refused } = await kbWork.apply('doer', '/r/eve', {
            kb_captures: [{ type: 'knowledge', title: 'kept-1', summary: 's', content: 'c', source_files: ['a.ts'] }],
        }, { member: 'eve' });
        assert.equal(captured, 1, 'the real capture result is unaffected by a broken accounting object');
        assert.equal(refused, 0);
    });
});

describe('assertion 6 -- zero vs missing vs not-observable are three distinguishable states, at BOTH the accounting and the panel layer', () => {
    test('accounting layer: a touched tool leaves its SIBLING tools at an explicit 0 within the same record (not absent)', async () => {
        const accounting = createDispatchAccounting();
        const { callTool } = createStubCallTool();
        const kbWork = createKbWorkClient({ callTool, accounting });
        await kbWork.relevantKnowledge('/r/frank', ['q'], { role: 'doer', member: 'frank' }); // kb_query only

        const rec = accounting.dispatchRecordFor('doer', 'frank');
        assert.equal(rec.kbCounts.kb_query, 1);
        assert.equal(rec.kbCounts.kb_capture, 0, 'kb_capture was never attempted for this dispatch -- explicit 0');
        assert.equal(rec.kbCounts.kb_promote, 0);
        assert.equal(rec.kbCounts.kb_export, 0);
        assert.equal(rec.kbCounts.kb_list, 0);
    });

    test('accounting layer: a role/member pair genuinely DISPATCHED this sprint (through the real dispatchRole() engine, apra-fleet-b4g.33 review round 2) but that makes ZERO kb_* calls gets a real record with explicit-zero counts, not an absent one', async () => {
        const accounting = createDispatchAccounting();
        // No kb.mjs call happens anywhere in this test -- dispatchRole() alone
        // is what must leave the record behind, exactly as it does for every
        // real deployer/integ-test-runner dispatch and any planner/harvester
        // round that returns no captures.
        const { dispatch } = await driveEngineDispatch('reviewer', 'main', { ctx: { dispatchAccounting: accounting } });

        const rec = accounting.dispatchRecordFor('reviewer', dispatch.options.member_name);
        assert.ok(rec, 'the real engine dispatched this (role, member) pair -- it must leave a record behind even though it made no kb_* call at all');
        assert.deepEqual(rec.kbCounts, { kb_list: 0, kb_query: 0, kb_capture: 0, kb_promote: 0, kb_export: 0 });
    });

    test('accounting layer: a role/member pair genuinely NEVER dispatched this sprint stays absent (dispatchRecordFor returns null), never a fabricated zero-record', () => {
        const accounting = createDispatchAccounting();
        assert.equal(accounting.dispatchRecordFor('doer', 'ghost'), null);
        assert.deepEqual(accounting.dispatchRecords(), []);
    });

    test('panel layer: an explicit zero total -- produced by a REAL zero-kb-call dispatch through the engine, not a hand-built fixture -- renders the literal 0 + highlight, a malformed/missing kbCounts renders (unknown), and code_* renders its own marker', async () => {
        const accounting = createDispatchAccounting();
        await driveEngineDispatch('reviewer', 'main', { ctx: { dispatchAccounting: accounting } });
        // accounting.dispatchRecords() is the ACTUAL shape dispatchRole() left
        // behind -- the same object runner.js's real dispatchCtx.dispatchAccounting
        // would publish to the panel. Only the malformed second entry is a
        // hand-built fixture, and deliberately so: it is proving defensive
        // rendering against a shape the real store can never produce, not the
        // zero-call state itself.
        const html = renderKbCodeIntelHtml({ members: [] }, {
            dispatches: [
                ...accounting.dispatchRecords(),
                { role: 'doer', member: 'no-data', kbCounts: null, captureOutcomes: [], code: { status: CODE_CALLS_NOT_OBSERVABLE } },
            ],
        });
        assert.match(html, /data-kb-panel-zero-calls="true"/);
        assert.match(html, /ZERO KB CALLS/);
        assert.match(html, /data-kb-panel-unknown="true"/);
        assert.match(html, /data-kb-panel-not-observable="true"/);
        assert.match(html, /not observable/);
    });
});

describe('assertion 7 -- the panel is its own distinct extension; its content does not appear inside Activities or Backlog', () => {
    test('kbCodeIntelExtension is a SEPARATE dashboardExtensions entry from beadsExtension (Sprint/Backlog\'s own tab)', () => {
        assert.notEqual(kbCodeIntelExtension.id, beadsExtension.id);
        assert.notEqual(kbCodeIntelExtension.id, 'core', "must not collide with core's fixed Activity Tree tab id");
    });

    test('renderKbCodeIntelHtml output never appears inside renderBeadsHtml (the Sprint/Backlog tree), and vice versa', () => {
        const kbHtml = renderKbCodeIntelHtml(
            { members: [{ member: 'alice', repoPath: '/r', kbEntryCount: 2, checks: {}, warnings: [] }] },
            { dispatches: [{ role: 'doer', member: 'alice', kbCounts: { kb_query: 1 }, captureOutcomes: [], code: { status: CODE_CALLS_NOT_OBSERVABLE } }] },
        );
        const beadsHtml = renderBeadsHtml(
            [{ id: '1', title: 'a sprint task', status: 'open' }],
            [{ id: '2', title: 'a backlog task', status: 'open' }],
        );
        assert.doesNotMatch(beadsHtml, /data-kb-code-intel="true"/, 'the Sprint/Backlog panel must never carry the KB panel marker');
        assert.doesNotMatch(kbHtml, /data-beads-identity="true"|tree-toggle/, 'the KB panel must never carry Sprint/Backlog tree markup');
        assert.match(kbHtml, /data-kb-code-intel="true"/, 'sanity: the KB panel does carry its own marker');
    });
});

describe('assertion 8 -- panel per-member section renders the three check outcomes, KB entry count and resolved scope', () => {
    test('all four fields are rendered from the preflight record for each member', () => {
        const html = renderKbCodeIntelHtml({
            members: [{
                member: 'grace', repoPath: '/r/grace', remoteUrl: 'https://example.invalid/g.git', mcpScope: null,
                kbEntryCount: 9,
                checks: {
                    index: { outcome: 'analyze-started' },
                    kb: { outcome: 'ok' },
                    code: { outcome: 'index-not-ready' },
                },
                warnings: [],
            }],
        }, { dispatches: [] });
        assert.match(html, /grace/);
        assert.match(html, /launch issued/, 'index renders launch-issued');
        assert.match(html, /\bok\b/, 'kb outcome renders');
        assert.match(html, /index-not-ready/, 'code outcome renders');
        assert.match(html, />9</, 'kb entry count printed');
        assert.match(html, /\/r\/grace/, 'resolved scope (repoPath) printed');
        assert.match(html, /example\.invalid\/g\.git/, 'resolved scope (remoteUrl) printed');
    });
});

describe('assertion 9 -- the panel pins the ABSENCE of a code-index commit: no fabricated claim, no misleading blank', () => {
    test('a real-shaped preflight record (no commit field at all) renders neither a commit hash/id nor a blank that reads like a missing one', () => {
        const html = renderKbCodeIntelHtml({
            members: [{
                member: 'henry', repoPath: '/r/henry', remoteUrl: null, mcpScope: null, kbEntryCount: 0,
                checks: { index: { outcome: 'analyze-started' }, kb: { outcome: 'kb-empty' }, code: { outcome: 'index-not-ready' } },
                warnings: [],
            }],
        }, { dispatches: [] });
        // No commit-shaped claim of any kind.
        assert.doesNotMatch(html, /\bcommit\b/i);
        assert.doesNotMatch(html, /done at/i);
        assert.doesNotMatch(html, /\b[0-9a-f]{7,40}\b/i, 'no SHA-shaped token must appear -- there is no commit to report');
        // Not a blank/placeholder either -- the index cell carries real content.
        assert.match(html, /launch issued \(indexing continues in background\)/);
    });
});

describe('assertion 10 -- zero-call highlight vs the not-observable marker are mutually exclusive', () => {
    test('a zero-kb-call dispatch (through the real engine) is highlighted; a non-zero one (a real kb.mjs call layered onto the same engine seed) is not; the code_* marker never triggers the zero highlight either way', async () => {
        const accounting = createDispatchAccounting();

        // Zero: dispatchRole() seeds this (role, member) record; nothing ever
        // calls kb.mjs for it -- exactly the production shape apra-fleet-b4g.21's
        // highlight exists to catch.
        const { dispatch: zeroDispatch } = await driveEngineDispatch('reviewer', 'main', { ctx: { dispatchAccounting: accounting } });

        // Non-zero: dispatchRole() seeds a DIFFERENT (role, member) record,
        // then a real kb.mjs call -- exactly as develop.mjs's pre-dispatch
        // relevantKnowledge() threads it -- pushes its kb_query count above
        // zero on top of that same seed.
        const { dispatch: doerDispatch } = await driveEngineDispatch('doer', 'main', { ctx: { dispatchAccounting: accounting } });
        const doerMember = doerDispatch.options.member_name;
        const { callTool } = createStubCallTool();
        const kbWork = createKbWorkClient({ callTool, accounting });
        await kbWork.relevantKnowledge('/r/doer', ['q'], { role: 'doer', member: doerMember });

        const html = renderKbCodeIntelHtml({ members: [] }, { dispatches: accounting.dispatchRecords() });
        const zeroMember = zeroDispatch.options.member_name;
        const rows = html.split('<tr>').filter((s) => s.includes(zeroMember) || s.includes(doerMember));
        const zeroRow = rows.find((r) => r.includes(`>${zeroMember}<`));
        const nonzeroRow = rows.find((r) => r.includes(`>${doerMember}<`));
        assert.match(zeroRow, /data-kb-panel-zero-calls="true"/);
        assert.doesNotMatch(nonzeroRow, /data-kb-panel-zero-calls="true"/);
        // Both rows carry the not-observable marker regardless of their kb_* total.
        assert.match(zeroRow, /data-kb-panel-not-observable="true"/);
        assert.match(nonzeroRow, /data-kb-panel-not-observable="true"/);
    });
});

describe('assertion 11 -- warning prominence: member, cause AND remediation, with the prominent-warning marker', () => {
    test('a warned member is NOT rendered as an ordinary row -- it carries the distinct warning marker with all three fields', () => {
        const html = renderKbCodeIntelHtml({
            members: [{
                member: 'iris', repoPath: '/r/iris', remoteUrl: null, mcpScope: null, kbEntryCount: 0,
                checks: { kb: { outcome: 'kb-empty' } },
                warnings: [{
                    member: 'iris', check: 'kb', outcome: 'kb-empty',
                    cause: 'the knowledge scope resolved and reported zero entries',
                    remediation: 'capture or import knowledge for this repo; until then roles start cold',
                }],
            }],
        }, { dispatches: [] });
        assert.match(html, /data-kb-panel-warning="true"/, 'the prominent-warning marker, distinct from an ordinary <tr> row');
        assert.match(html, /iris/);
        assert.match(html, /the knowledge scope resolved and reported zero entries/);
        assert.match(html, /capture or import knowledge for this repo; until then roles start cold/);
    });
});

describe('assertion 12 -- robustness: malformed and absent records render empty-but-valid, never throw', () => {
    test('absent input', () => {
        assert.doesNotThrow(() => renderKbCodeIntelHtml(undefined, undefined));
        assert.match(renderKbCodeIntelHtml(undefined, undefined), /data-kb-code-intel="true"/);
    });

    test('malformed input of several shapes', () => {
        assert.doesNotThrow(() => renderKbCodeIntelHtml(42, 'nope'));
        assert.doesNotThrow(() => renderKbCodeIntelHtml({ members: [{}, { checks: 'not-an-object' }] }, { dispatches: [{}, { kbCounts: 'nope' }] }));
    });
});

describe('assertion 13 -- ASCII only and no target-repo-specific string, including strings built at runtime', () => {
    test('a runtime render carrying a member/role/cause/remediation with no target-repo token stays ASCII and target-neutral', () => {
        const html = renderKbCodeIntelHtml({
            members: [{
                member: 'jack', repoPath: '/r/jack', remoteUrl: null, mcpScope: null, kbEntryCount: 3,
                checks: { index: { outcome: 'analyze-not-started', cause: 'launcher not on PATH' }, kb: { outcome: 'ok' }, code: { outcome: 'ok' } },
                warnings: [{ member: 'jack', cause: 'launcher not on PATH', remediation: 'make the code indexer runnable on this member' }],
            }],
        }, {
            dispatches: [{
                role: 'doer', member: 'jack',
                kbCounts: { kb_list: 1, kb_query: 2, kb_capture: 1, kb_promote: 0, kb_export: 1 },
                captureOutcomes: [{ title: 't', outcome: 'kept' }],
                code: { status: CODE_CALLS_NOT_OBSERVABLE },
            }],
        });
        // eslint-disable-next-line no-control-regex
        assert.ok(/^[\x00-\x7F]*$/.test(html), 'must be ASCII only');
        // No target-repo-specific command/env-var/port/tracker id -- this
        // renderer's own vocabulary is a fixed set of generic labels, never
        // a value that could carry one (every dynamic value is either a
        // number or a caller-supplied string run through escapeHtml, and the
        // fixture above deliberately contains none of those tokens either).
        for (const forbidden of ['npm run', 'APRA_FLEET_', 'localhost:', 'apra-fleet-b4g']) {
            assert.ok(!html.includes(forbidden), `must not contain target-specific token: ${forbidden}`);
        }
    });
});
