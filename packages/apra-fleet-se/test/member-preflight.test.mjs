import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    createMemberPreflight,
    buildIndexLaunchCommand,
    renderPreflightWarning,
    PREFLIGHT_WARNING_TEMPLATES,
    PREFLIGHT_WARNING_OUTCOMES,
    PREFLIGHT_INFORMATIONAL_OUTCOMES,
    PREFLIGHT_OUTCOMES,
    PREFLIGHT_CHECK_INDEX,
    PREFLIGHT_CHECK_KB,
    PREFLIGHT_CHECK_CODE,
    PREFLIGHT_STATE_NAMESPACE,
    INDEX_LAUNCH_SENTINEL,
    OUTCOME_OK,
    OUTCOME_ANALYZE_STARTED,
    OUTCOME_ANALYZE_NOT_STARTED,
    OUTCOME_TOOL_UNAVAILABLE,
    OUTCOME_KB_EMPTY,
    OUTCOME_UNSCOPED,
    OUTCOME_INDEX_NOT_READY,
} from '../fleet-sprint/member-preflight.mjs';
import { createKbPrimingClient } from '../fleet-sprint/kb.mjs';

// =============================================================================
// Verification for the Sprint Setup per-member knowledge/code-intelligence
// preflight.
//
// THE CONTRACT THESE TESTS PIN IS WARN-AND-CONTINUE. A missing or broken
// kb/code tool must NOT fail the sprint: it warns visibly and the sprint
// proceeds to dispatch. A test asserting that a failed check BLOCKS would pin
// the opposite of the owner decision, so every failure-mode case below asserts
// "the preflight completed and the sprint can proceed" as its FIRST assertion.
// That assertion is the one that catches a regression back to a blocking gate.
//
// Two shapes are deliberately NOT tested, because they cannot exist:
//   - the OUTCOME of the indexing run. The indexer is started DETACHED and
//     never awaited, so the engine can only ever observe whether the LAUNCH was
//     issued. A test asserting on indexing success is unwritable.
//   - an open-ended "no string contains a target-specific token" universal
//     negative. There is no enumerated forbidden set, so no such assertion
//     could pass or fail for a definite reason. It is replaced by the bounded,
//     falsifiable template-equality check in section (9) below: every warning
//     emitted at runtime must EQUAL its exported template rendered with only
//     the fixture's own values, which makes any target-specific token baked
//     into a template a definite failure with a definite reason. The static
//     case stays covered by scripts/check-generic-boundary.mjs.
//
// Every dependency (MCP client, KB priming, indexer launch, member exec seam)
// is stubbed. No real server, network, clone, member connection or index run is
// needed, and nothing is written outside the process.
// =============================================================================

/**
 * The FIXED member fixture section (9) asserts against. Every value a warning
 * is allowed to carry comes from here (or from the stubbed upstream reason),
 * so a token in an emitted warning that is in neither is a template leak.
 */
const FIXTURE = Object.freeze({
    member: 'fixture-member',
    repoPath: '/fixture/checkout',
    remoteUrl: 'https://example.invalid/fixture/checkout.git',
});

/** A kb-priming stub: the real client's read-back surface, no transport. */
function stubKbPriming({
    members = [FIXTURE.member],
    folders = { [FIXTURE.member]: FIXTURE.repoPath },
    counts = { [FIXTURE.member]: 3 },
    outcomes = { [FIXTURE.member]: 'ok' },
    errors = {},
    scopes = {},
    primeAll,
} = {}) {
    const calls = { primeAll: 0 };
    return {
        calls,
        members,
        async primeAll() {
            calls.primeAll += 1;
            if (typeof primeAll === 'function') return primeAll();
            return { primed: members.length, skipped: 0 };
        },
        folderOf: (m) => folders[m] ?? null,
        remoteUrlOf: () => FIXTURE.remoteUrl,
        mcpScopeOf: (m) => scopes[m] ?? null,
        entryCountOf: (m) => counts[m] ?? 0,
        primeOutcomeOf: (m) => outcomes[m] ?? null,
        primeErrorOf: (m) => errors[m] ?? null,
        knowledgeOf: () => [],
    };
}

/** A member exec seam that records dispatches and reports a clean launch. */
function stubCommand(behaviour = {}) {
    const calls = [];
    const fn = async (cmd, opts) => {
        calls.push({ cmd, opts });
        if (typeof behaviour.respond === 'function') return behaviour.respond(cmd, opts);
        return { ok: true, output: `${INDEX_LAUNCH_SENTINEL}:4242`, error: null };
    };
    fn.calls = calls;
    return fn;
}

/** A code-tool stub. `answer` may be a value, or a function of (name, args). */
function stubCallTool(answer) {
    const calls = [];
    const fn = async (name, args) => {
        calls.push({ name, args });
        if (typeof answer === 'function') return answer(name, args);
        return answer;
    };
    fn.calls = calls;
    return fn;
}

/** Collects log output so "printed, not merely computed" is assertable. */
function makeLog() {
    const lines = [];
    const log = (line) => { lines.push(String(line)); };
    log.lines = lines;
    log.text = () => lines.join('\n');
    return log;
}

/** Builds a preflight over the fixture member with sane defaults. */
function buildPreflight(overrides = {}) {
    const log = overrides.log ?? makeLog();
    const command = overrides.command ?? stubCommand();
    const callTool = overrides.callTool === null
        ? undefined
        : (overrides.callTool ?? stubCallTool({ content: [{ text: JSON.stringify({ results: [{ symbol: 'x' }] }) }] }));
    const kbPriming = overrides.kbPriming ?? stubKbPriming();
    const preflight = createMemberPreflight({
        members: overrides.members ?? [FIXTURE.member],
        command,
        callTool,
        kbPriming,
        log,
        publishState: overrides.publishState,
        // Tiny settle window: every assertion here is about WHICH outcome is
        // recorded, never about how long the engine is willing to wait.
        launchSettleMs: overrides.launchSettleMs ?? 5,
    });
    return { preflight, log, command, callTool, kbPriming };
}

function outcomeOf(record, check) {
    return record.checks[check] && record.checks[check].outcome;
}

// ---------------------------------------------------------------------------
// (1) Happy path.
// ---------------------------------------------------------------------------

describe('Sprint Setup preflight -- happy path', () => {
    test('all three checks satisfied: the sprint proceeds, a structured per-member record is written, and the KB entry count is PRINTED', async () => {
        const { preflight, log } = buildPreflight();

        const records = await preflight.runAll();

        // The sprint proceeds: runAll() returned normally, nothing threw.
        assert.equal(records.length, 1);
        const rec = records[0];
        assert.equal(rec.member, FIXTURE.member);
        assert.equal(rec.repoPath, FIXTURE.repoPath);

        // Structured, machine-readable, one outcome per check, all from the
        // closed set.
        for (const check of [PREFLIGHT_CHECK_INDEX, PREFLIGHT_CHECK_KB, PREFLIGHT_CHECK_CODE]) {
            const entry = rec.checks[check];
            assert.ok(entry, `check '${check}' must be recorded`);
            assert.ok(PREFLIGHT_OUTCOMES.includes(entry.outcome), `'${entry.outcome}' is outside the closed outcome set`);
        }
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_INDEX), OUTCOME_ANALYZE_STARTED);
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_KB), OUTCOME_OK);
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_CODE), OUTCOME_OK);
        assert.deepEqual(rec.warnings, []);

        // PRINTED, not merely computed.
        assert.match(log.text(), /KB entries = 3/);
        assert.match(log.text(), new RegExp(`member '${FIXTURE.member}'`));
        assert.equal(rec.kbEntryCount, 3);
    });

    test('the records are published in the structured form the panel lane reads back', async () => {
        const published = [];
        const { preflight } = buildPreflight({ publishState: (ns, data) => published.push({ ns, data }) });

        await preflight.runAll();

        assert.equal(published.length, 1);
        assert.equal(published[0].ns, PREFLIGHT_STATE_NAMESPACE);
        assert.equal(published[0].data.members.length, 1);
        assert.equal(published[0].data.members[0].member, FIXTURE.member);
        // Machine-readable, not only free prose: it survives a JSON round trip.
        const roundTripped = JSON.parse(JSON.stringify(published[0].data));
        assert.equal(roundTripped.members[0].checks.kb.outcome, OUTCOME_OK);
    });
});

// ---------------------------------------------------------------------------
// (2) One test per failure mode, asserted SEPARATELY. Each asserts the sprint
//     still proceeds -- that is the assertion that catches a regression back
//     to a blocking gate -- plus a warning record carrying all four parts.
// ---------------------------------------------------------------------------

/** Every warning must name member, check, cause and remediation. */
function assertWarningIsComplete(warning) {
    assert.ok(warning, 'a warning record must exist');
    for (const field of ['member', 'check', 'cause', 'remediation', 'outcome', 'message']) {
        assert.ok(
            typeof warning[field] === 'string' && warning[field].length > 0,
            `a warning missing '${field}' is a defect; got ${JSON.stringify(warning)}`,
        );
    }
    assert.ok(warning.message.includes(warning.member), 'the warning must name the member');
    assert.ok(warning.message.includes(warning.check), 'the warning must name the failed check');
    assert.ok(warning.message.includes(warning.cause), 'the warning must name the cause');
    assert.ok(warning.message.includes(warning.remediation), 'the warning must name a remediation');
}

describe('Sprint Setup preflight -- failure modes never fail the sprint', () => {
    test('the indexer could not be STARTED: warns, records analyze-not-started, and the sprint proceeds', async () => {
        const command = stubCommand({ respond: async () => ({ ok: false, output: '', error: 'node is not on PATH' }) });
        const { preflight } = buildPreflight({ command });

        const [rec] = await preflight.runAll();

        // PROCEEDS TO DISPATCH: the preflight completed and reported.
        assert.equal(rec.member, FIXTURE.member);
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_INDEX), OUTCOME_ANALYZE_NOT_STARTED);
        const warning = rec.warnings.find((w) => w.check === PREFLIGHT_CHECK_INDEX);
        assertWarningIsComplete(warning);
        assert.ok(warning.cause.includes('node is not on PATH'));
        // The other two checks still ran: one broken check never short-circuits.
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_KB), OUTCOME_OK);
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_CODE), OUTCOME_OK);
    });

    test('the indexer launch dispatch THROWS: still analyze-not-started, still non-fatal', async () => {
        const command = stubCommand({ respond: async () => { throw new Error('member unreachable'); } });
        const { preflight } = buildPreflight({ command });

        const [rec] = await preflight.runAll();

        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_INDEX), OUTCOME_ANALYZE_NOT_STARTED);
        assertWarningIsComplete(rec.warnings.find((w) => w.check === PREFLIGHT_CHECK_INDEX));
    });

    test('kb prime unavailable or throwing: warns tool-unavailable and the sprint proceeds', async () => {
        const kbPriming = stubKbPriming({
            counts: { [FIXTURE.member]: 0 },
            outcomes: { [FIXTURE.member]: 'tool-unavailable' },
            errors: { [FIXTURE.member]: 'the knowledge server refused the call' },
        });
        const { preflight } = buildPreflight({ kbPriming });

        const [rec] = await preflight.runAll();

        assert.equal(rec.member, FIXTURE.member);
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_KB), OUTCOME_TOOL_UNAVAILABLE);
        const warning = rec.warnings.find((w) => w.check === PREFLIGHT_CHECK_KB);
        assertWarningIsComplete(warning);
        assert.ok(warning.cause.includes('the knowledge server refused the call'));
    });

    test('the whole priming pass throwing does not abort Sprint Setup', async () => {
        const kbPriming = stubKbPriming({
            primeAll: () => { throw new Error('priming exploded'); },
            counts: { [FIXTURE.member]: 0 },
            outcomes: { [FIXTURE.member]: 'tool-unavailable' },
        });
        const { preflight } = buildPreflight({ kbPriming });

        const [rec] = await preflight.runAll();

        assert.equal(rec.member, FIXTURE.member);
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_KB), OUTCOME_TOOL_UNAVAILABLE);
    });

    test('KB scope RESOLVES but reports ZERO entries: warns kb-empty, prints the zero, and the sprint proceeds', async () => {
        const kbPriming = stubKbPriming({
            counts: { [FIXTURE.member]: 0 },
            outcomes: { [FIXTURE.member]: 'ok' },
        });
        const { preflight, log } = buildPreflight({ kbPriming });

        const [rec] = await preflight.runAll();

        assert.equal(rec.member, FIXTURE.member);
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_KB), OUTCOME_KB_EMPTY);
        assertWarningIsComplete(rec.warnings.find((w) => w.check === PREFLIGHT_CHECK_KB));
        // The count is printed even -- especially -- when it is zero.
        assert.match(log.text(), /KB entries = 0/);
    });

    test('the code tool probe does not answer: warns tool-unavailable and the sprint proceeds', async () => {
        const callTool = stubCallTool(() => { throw new Error('code intelligence transport closed'); });
        const { preflight } = buildPreflight({ callTool });

        const [rec] = await preflight.runAll();

        assert.equal(rec.member, FIXTURE.member);
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_CODE), OUTCOME_TOOL_UNAVAILABLE);
        const warning = rec.warnings.find((w) => w.check === PREFLIGHT_CHECK_CODE);
        assertWarningIsComplete(warning);
        assert.ok(warning.cause.includes('code intelligence transport closed'));
    });

    test('the code tool returns a tool-level MCP error (which RESOLVES, not throws): still tool-unavailable', async () => {
        const callTool = stubCallTool({ isError: true, content: [{ text: 'no code intelligence provider is configured' }] });
        const { preflight } = buildPreflight({ callTool });

        const [rec] = await preflight.runAll();

        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_CODE), OUTCOME_TOOL_UNAVAILABLE);
        const warning = rec.warnings.find((w) => w.check === PREFLIGHT_CHECK_CODE);
        assertWarningIsComplete(warning);
        assert.ok(warning.cause.includes('no code intelligence provider is configured'));
    });

    test('the member arrives already carrying the upstream UNSCOPED reason: warned verbatim, never re-probed, sprint proceeds', async () => {
        const upstream = {
            scoped: false,
            reason: 'no-install-found',
            remediation: 'install the fleet tooling on this member, then re-run member configuration',
            detail: 'nothing executable at the expected install path',
            resolvedAt: '2026-09-29T00:00:00.000Z',
        };
        const callTool = stubCallTool({ content: [{ text: JSON.stringify({ results: [{ symbol: 'x' }] }) }] });
        const kbPriming = stubKbPriming({ scopes: { [FIXTURE.member]: upstream } });
        const { preflight } = buildPreflight({ callTool, kbPriming });

        const [rec] = await preflight.runAll();

        assert.equal(rec.member, FIXTURE.member);
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_KB), OUTCOME_UNSCOPED);
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_CODE), OUTCOME_UNSCOPED);
        for (const w of rec.warnings.filter((x) => x.outcome === OUTCOME_UNSCOPED)) {
            assertWarningIsComplete(w);
            // VERBATIM: the upstream reason and remediation are carried, not
            // paraphrased and not replaced by a generic message.
            assert.equal(w.cause, upstream.reason);
            assert.equal(w.remediation, upstream.remediation);
        }
        // NOT re-probed: an unscoped member's code tool is never called.
        assert.equal(callTool.calls.filter((c) => c.name === 'code_query').length, 0);
    });

    test('no MCP transport wired into the run: both tool checks warn rather than being silently skipped', async () => {
        const { preflight } = buildPreflight({ callTool: null, kbPriming: stubKbPriming({ outcomes: { [FIXTURE.member]: 'no-transport' }, counts: { [FIXTURE.member]: 0 } }) });

        const [rec] = await preflight.runAll();

        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_KB), OUTCOME_TOOL_UNAVAILABLE);
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_CODE), OUTCOME_TOOL_UNAVAILABLE);
        assert.equal(rec.warnings.length, 2);
    });
});

// ---------------------------------------------------------------------------
// (3) The three confusable outcomes are THREE distinct kinds, and none of them
//     is reported as a clean pass.
// ---------------------------------------------------------------------------

describe('Sprint Setup preflight -- kb-empty, tool-unavailable and unscoped are three distinct kinds', () => {
    test('each resolves to its own outcome kind, none equals ok, and all three are warning kinds', async () => {
        const upstream = { scoped: false, reason: 'provider-unsupported', remediation: 'use a provider that can host the fleet tools for this member' };

        const empty = buildPreflight({
            kbPriming: stubKbPriming({ counts: { [FIXTURE.member]: 0 }, outcomes: { [FIXTURE.member]: 'ok' } }),
        });
        const unavailable = buildPreflight({
            kbPriming: stubKbPriming({ counts: { [FIXTURE.member]: 0 }, outcomes: { [FIXTURE.member]: 'tool-unavailable' } }),
        });
        const unscoped = buildPreflight({
            kbPriming: stubKbPriming({ scopes: { [FIXTURE.member]: upstream } }),
        });

        const [emptyRec] = await empty.preflight.runAll();
        const [unavailableRec] = await unavailable.preflight.runAll();
        const [unscopedRec] = await unscoped.preflight.runAll();

        const kinds = [
            outcomeOf(emptyRec, PREFLIGHT_CHECK_KB),
            outcomeOf(unavailableRec, PREFLIGHT_CHECK_KB),
            outcomeOf(unscopedRec, PREFLIGHT_CHECK_KB),
        ];
        assert.deepEqual(kinds, [OUTCOME_KB_EMPTY, OUTCOME_TOOL_UNAVAILABLE, OUTCOME_UNSCOPED]);
        assert.equal(new Set(kinds).size, 3, 'the three must not collapse into fewer kinds');
        for (const kind of kinds) {
            assert.notEqual(kind, OUTCOME_OK, 'none of the three may be reported as a clean pass');
            assert.ok(PREFLIGHT_WARNING_OUTCOMES.includes(kind), `'${kind}' must be a warning kind`);
        }
    });
});

// ---------------------------------------------------------------------------
// (4) Check (a) is FIRE-AND-FORGET.
// ---------------------------------------------------------------------------

describe('Sprint Setup preflight -- the index launch is fire-and-forget', () => {
    test('an indexer launch that NEVER settles does not prevent Sprint Setup from finishing', async () => {
        // A launch dispatch that never resolves. If the preflight awaited the
        // indexer, runAll() could never return and this test would time out.
        const command = stubCommand({ respond: () => new Promise(() => {}) });
        const { preflight } = buildPreflight({ command, launchSettleMs: 5 });

        const [rec] = await preflight.runAll();

        assert.equal(rec.member, FIXTURE.member);
        // The record says the indexer was STARTED. It never claims the index is
        // current, and it never reports the indexing run's outcome.
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_INDEX), OUTCOME_ANALYZE_STARTED);
        const detail = rec.checks[PREFLIGHT_CHECK_INDEX].detail || '';
        assert.ok(!/\bcurrent\b/.test(detail) || /never|not a claim/.test(detail),
            'the index record must not assert the index is current');
        // The other two checks completed while the launch was still pending,
        // which is only possible if the launch was not awaited inline.
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_KB), OUTCOME_OK);
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_CODE), OUTCOME_OK);
    });

    test('the launch is dispatched to the member BEFORE the kb/code checks run, and exactly once per member', async () => {
        const order = [];
        const command = stubCommand({
            respond: async (cmd) => {
                order.push(`command:${cmd.includes(INDEX_LAUNCH_SENTINEL) ? 'index-launch' : 'other'}`);
                return { ok: true, output: '', error: null };
            },
        });
        const callTool = stubCallTool((name) => {
            order.push(`tool:${name}`);
            return { content: [{ text: JSON.stringify({ results: [{ symbol: 'x' }] }) }] };
        });
        const { preflight } = buildPreflight({ command, callTool });

        await preflight.runAll();

        assert.equal(order[0], 'command:index-launch', `expected the launch first, got ${JSON.stringify(order)}`);
        assert.equal(order.filter((o) => o === 'command:index-launch').length, 1);
        assert.equal(command.calls.length, 1);
        assert.equal(command.calls[0].opts.member_name, FIXTURE.member);
    });

    test('the member-bound launch command relies on no shell expansion and is a detached spawn', () => {
        const cmd = buildIndexLaunchCommand();

        assert.ok(cmd.includes('detached:true'), 'the launch must spawn detached');
        assert.ok(cmd.includes('unref'), 'the launch must unref so the dispatch can exit immediately');
        assert.ok(cmd.includes(INDEX_LAUNCH_SENTINEL));
        // No shell-level expansion of any dialect: the member may be running
        // PowerShell or cmd.exe, not POSIX sh.
        assert.ok(!cmd.includes('$'), 'no POSIX/PowerShell variable expansion or $( )');
        assert.ok(!cmd.includes('`'), 'no backtick command substitution');
        assert.ok(!cmd.includes('~/'), 'no leading tilde path');
        assert.ok(!cmd.includes('%'), 'no cmd.exe %VAR% expansion');
        // The argv reaches node as ONE inert base64 token, never interpolated
        // into the shell command as free text.
        const b64 = /"([A-Za-z0-9+/=]+)"\s*$/.exec(cmd);
        assert.ok(b64, `expected a trailing base64 argv token, got: ${cmd}`);
        assert.deepEqual(JSON.parse(Buffer.from(b64[1], 'base64').toString('utf8')), ['npx', 'gitnexus', 'analyze']);
    });
});

// ---------------------------------------------------------------------------
// (5) The code probe PASSES on an empty index.
// ---------------------------------------------------------------------------

describe('Sprint Setup preflight -- the code probe is independent of index content', () => {
    for (const [label, answer] of [
        ['an empty results array', { content: [{ text: JSON.stringify({ results: [] }) }] }],
        ['an explicit indexed:false', { content: [{ text: JSON.stringify({ indexed: false }) }] }],
        ['prose saying the repo is not indexed', { content: [{ text: 'This repository is not indexed yet.' }] }],
    ]) {
        test(`the code tool answering with ${label} is INFORMATIONAL index-not-ready, not a warning and not a failure`, async () => {
            const { preflight } = buildPreflight({ callTool: stubCallTool(answer) });

            const [rec] = await preflight.runAll();

            assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_CODE), OUTCOME_INDEX_NOT_READY);
            assert.ok(PREFLIGHT_INFORMATIONAL_OUTCOMES.includes(OUTCOME_INDEX_NOT_READY));
            assert.ok(!PREFLIGHT_WARNING_OUTCOMES.includes(OUTCOME_INDEX_NOT_READY));
            // NO warning was raised for the code check, and the sprint proceeds.
            assert.equal(rec.warnings.filter((w) => w.check === PREFLIGHT_CHECK_CODE).length, 0);
        });
    }

    test('the probe is scoped to the MEMBER\'s own repo path', async () => {
        const callTool = stubCallTool({ content: [{ text: JSON.stringify({ results: [] }) }] });
        const { preflight } = buildPreflight({ callTool });

        await preflight.runAll();

        const probes = callTool.calls.filter((c) => c.name === 'code_query');
        assert.equal(probes.length, 1);
        assert.equal(probes[0].args.repo, FIXTURE.repoPath);
        assert.ok(typeof probes[0].args.query === 'string' && probes[0].args.query.length > 0);
    });
});

// ---------------------------------------------------------------------------
// (6) A local member is CHECKED, not skipped. (7) A provider with no MCP
//     support yields a NAMED warning and the sprint continues.
// ---------------------------------------------------------------------------

describe('Sprint Setup preflight -- every participating member is checked', () => {
    test('a LOCAL member is checked rather than skipped', async () => {
        const local = 'local-member';
        const remote = 'remote-member';
        const kbPriming = stubKbPriming({
            members: [local, remote],
            folders: { [local]: '/local/checkout', [remote]: '/remote/checkout' },
            counts: { [local]: 2, [remote]: 4 },
            outcomes: { [local]: 'ok', [remote]: 'ok' },
        });
        const command = stubCommand();
        const { preflight, log } = buildPreflight({ members: [local, remote], kbPriming, command });

        const records = await preflight.runAll();

        assert.deepEqual(records.map((r) => r.member), [local, remote]);
        // All three checks ran for the LOCAL member too.
        const localRec = records[0];
        assert.equal(outcomeOf(localRec, PREFLIGHT_CHECK_INDEX), OUTCOME_ANALYZE_STARTED);
        assert.equal(outcomeOf(localRec, PREFLIGHT_CHECK_KB), OUTCOME_OK);
        assert.equal(outcomeOf(localRec, PREFLIGHT_CHECK_CODE), OUTCOME_OK);
        assert.equal(command.calls.filter((c) => c.opts.member_name === local).length, 1);
        // A per-member entry count is printed for each of them.
        assert.match(log.text(), new RegExp(`member '${local}': KB entries = 2`));
        assert.match(log.text(), new RegExp(`member '${remote}': KB entries = 4`));
    });

    test('a provider with no MCP support yields a NAMED warning and the sprint continues', async () => {
        const upstream = {
            scoped: false,
            reason: 'provider-unsupported',
            remediation: 'give this member a provider that can host the fleet tools, then re-run member configuration',
        };
        const kbPriming = stubKbPriming({ scopes: { [FIXTURE.member]: upstream } });
        const { preflight } = buildPreflight({ kbPriming });

        const [rec] = await preflight.runAll();

        // NAMED, not a silent skip.
        const warning = rec.warnings.find((w) => w.outcome === OUTCOME_UNSCOPED);
        assertWarningIsComplete(warning);
        assert.equal(warning.cause, 'provider-unsupported');
        // ... and the sprint continues: the member is still reported, and the
        // index launch still happened.
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_INDEX), OUTCOME_ANALYZE_STARTED);
    });
});

// ---------------------------------------------------------------------------
// (8) Every warning record carries all four fields.
// ---------------------------------------------------------------------------

describe('Sprint Setup preflight -- every warning carries member, check, cause and remediation', () => {
    test('a run that trips every warning kind at once produces four complete warnings and still finishes', async () => {
        const memberA = 'unscoped-member';
        const memberB = 'broken-member';
        const kbPriming = stubKbPriming({
            members: [memberA, memberB],
            folders: { [memberA]: '/a/checkout', [memberB]: '/b/checkout' },
            counts: { [memberA]: 0, [memberB]: 0 },
            outcomes: { [memberA]: 'ok', [memberB]: 'ok' },
            scopes: { [memberA]: { scoped: false, reason: 'install-unusable', remediation: 'upgrade the member-side fleet install' } },
        });
        const command = stubCommand({
            respond: async (_cmd, opts) => (opts.member_name === memberB
                ? { ok: false, output: '', error: 'the launcher is not installed on this member' }
                : { ok: true, output: '', error: null }),
        });
        const callTool = stubCallTool({ isError: true, content: [{ text: 'code intelligence is not configured' }] });
        const { preflight } = buildPreflight({ members: [memberA, memberB], kbPriming, command, callTool });

        const records = await preflight.runAll();

        const all = records.flatMap((r) => r.warnings);
        const kinds = new Set(all.map((w) => w.outcome));
        assert.deepEqual(
            [...kinds].sort(),
            [OUTCOME_ANALYZE_NOT_STARTED, OUTCOME_KB_EMPTY, OUTCOME_TOOL_UNAVAILABLE, OUTCOME_UNSCOPED].sort(),
        );
        for (const w of all) assertWarningIsComplete(w);
        // Warn-and-continue: both members are still reported, in order.
        assert.deepEqual(records.map((r) => r.member), [memberA, memberB]);
    });

    test('renderPreflightWarning REFUSES a non-warning outcome, so an informational result can never be emitted as a failure', () => {
        for (const informational of [OUTCOME_OK, OUTCOME_INDEX_NOT_READY, OUTCOME_ANALYZE_STARTED]) {
            assert.throws(
                () => renderPreflightWarning(informational, { member: 'm', check: 'code', cause: 'c', remediation: 'r' }),
                /is not a warning outcome/,
            );
        }
    });
});

// ---------------------------------------------------------------------------
// (9) Generic-boundary assertion -- bounded and falsifiable.
// ---------------------------------------------------------------------------

describe('Sprint Setup preflight -- every warning is its template rendered with only member-supplied values', () => {
    test('each emitted warning EQUALS its exported template rendered with the fixture\'s own values', async () => {
        const upstreamReason = 'probe-failed';
        const upstreamRemediation = 'make this member reachable, then re-run member configuration';
        const kbPriming = stubKbPriming({
            counts: { [FIXTURE.member]: 0 },
            outcomes: { [FIXTURE.member]: 'ok' },
            scopes: { [FIXTURE.member]: { scoped: false, reason: upstreamReason, remediation: upstreamRemediation } },
        });
        const command = stubCommand({ respond: async () => ({ ok: false, output: '', error: 'launcher missing' }) });
        const { preflight } = buildPreflight({ kbPriming, command });

        const [rec] = await preflight.runAll();

        assert.ok(rec.warnings.length > 0, 'this fixture must produce warnings for the check to mean anything');
        for (const w of rec.warnings) {
            const template = PREFLIGHT_WARNING_TEMPLATES[w.outcome];
            assert.ok(typeof template === 'function', `outcome '${w.outcome}' has no exported template`);
            const expected = template({ member: w.member, check: w.check, cause: w.cause, remediation: w.remediation });
            assert.equal(
                w.message,
                expected,
                'a warning built outside the template set would let a target-specific token in unnoticed',
            );
            // The member fixture is the ONLY source of the interpolated values.
            assert.equal(w.member, FIXTURE.member);
        }
        // The upstream reason/remediation are carried verbatim, not rewritten.
        const unscopedWarning = rec.warnings.find((w) => w.outcome === OUTCOME_UNSCOPED);
        assert.equal(unscopedWarning.cause, upstreamReason);
        assert.equal(unscopedWarning.remediation, upstreamRemediation);
    });

    test('no template skeleton carries a value from the member fixture -- every member-specific token is interpolated', () => {
        const SENTINELS = { member: '<<MEMBER>>', check: '<<CHECK>>', cause: '<<CAUSE>>', remediation: '<<FIX>>' };
        for (const [outcome, template] of Object.entries(PREFLIGHT_WARNING_TEMPLATES)) {
            const skeleton = template(SENTINELS);
            for (const sentinel of Object.values(SENTINELS)) {
                assert.ok(skeleton.includes(sentinel), `template '${outcome}' must interpolate ${sentinel}`);
            }
            // Strip the interpolated values: what remains is the STATIC text,
            // and it must contain nothing drawn from a particular member/repo.
            let staticText = skeleton;
            for (const sentinel of Object.values(SENTINELS)) staticText = staticText.split(sentinel).join('');
            for (const fixtureValue of Object.values(FIXTURE)) {
                assert.ok(!staticText.includes(fixtureValue), `template '${outcome}' bakes in the fixture value '${fixtureValue}'`);
            }
            // A path or URL baked into the static half would be exactly the
            // kind of target-specific token that must be supplied, not hardcoded.
            assert.ok(!/https?:\/\//.test(staticText), `template '${outcome}' bakes in a URL`);
            assert.ok(!/(?:^|\s)\/[A-Za-z0-9_.-]+\//.test(staticText), `template '${outcome}' bakes in an absolute path`);
        }
    });

    test('the warning-kind set and the template set are the same set', () => {
        assert.deepEqual(Object.keys(PREFLIGHT_WARNING_TEMPLATES).sort(), [...PREFLIGHT_WARNING_OUTCOMES].sort());
    });
});

// ---------------------------------------------------------------------------
// (10)/(11) The two revert tripwires, stated as executable expectations.
// ---------------------------------------------------------------------------

describe('Sprint Setup preflight -- the revert tripwires', () => {
    test('REVERT TO A BLOCKING GATE: a preflight that threw on a failed check would fail section (2) -- proven by driving every failure at once', async () => {
        // This is the mechanical form of "reverting the implementation to a
        // blocking gate makes the failure-mode assertions fail": every check
        // fails at once and runAll() must still RESOLVE. A blocking gate would
        // reject here, and this assertion is what would catch it.
        const kbPriming = stubKbPriming({
            counts: { [FIXTURE.member]: 0 },
            outcomes: { [FIXTURE.member]: 'tool-unavailable' },
            errors: { [FIXTURE.member]: 'knowledge server down' },
        });
        const command = stubCommand({ respond: async () => { throw new Error('member unreachable'); } });
        const callTool = stubCallTool(() => { throw new Error('code tool down'); });
        const { preflight } = buildPreflight({ kbPriming, command, callTool });

        const records = await preflight.runAll();

        assert.equal(records.length, 1, 'the preflight must RESOLVE, not reject, when every check fails');
        const rec = records[0];
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_INDEX), OUTCOME_ANALYZE_NOT_STARTED);
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_KB), OUTCOME_TOOL_UNAVAILABLE);
        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_CODE), OUTCOME_TOOL_UNAVAILABLE);
        assert.equal(rec.warnings.length, 3);
    });

    test('REVERT TO AWAITING THE INDEXER: an unsettled launch must still let Sprint Setup finish within a bounded window', async () => {
        const command = stubCommand({ respond: () => new Promise(() => {}) });
        const { preflight } = buildPreflight({ command, launchSettleMs: 5 });

        const started = Date.now();
        const [rec] = await preflight.runAll();
        const elapsed = Date.now() - started;

        assert.equal(outcomeOf(rec, PREFLIGHT_CHECK_INDEX), OUTCOME_ANALYZE_STARTED);
        // An implementation that awaited indexer completion could not satisfy
        // this: the stub never settles at all.
        assert.ok(elapsed < 5000, `Sprint Setup must not wait on the indexer; waited ${elapsed}ms`);
    });
});

// ---------------------------------------------------------------------------
// The kb-priming read-back surface the preflight depends on.
// ---------------------------------------------------------------------------

describe('kb priming read-back: the per-member facts the preflight reports', () => {
    function primingCallTool({ folder = '/srv/repo', mcpScope, prime }) {
        const calls = [];
        const callTool = async (name, args) => {
            calls.push({ name, args });
            if (name === 'member_detail') {
                return { content: [{ text: JSON.stringify({ folder, repo_remote_url: 'https://example.invalid/r.git', mcp_scope: mcpScope }) }] };
            }
            if (name === 'kb_import') return { content: [{ text: JSON.stringify({ imported: 0 }) }] };
            if (name === 'kb_session_prime') {
                if (typeof prime === 'function') return prime();
                return prime;
            }
            return {};
        };
        callTool.calls = calls;
        return callTool;
    }

    test('a resolving scope with entries reports outcome ok and the raw entry count', async () => {
        const callTool = primingCallTool({ prime: { content: [{ text: JSON.stringify({ top_entries: [{ id: 'a' }, { id: 'b' }] }) }] } });
        const client = createKbPrimingClient({ callTool, members: ['m'], log: () => {} });

        await client.primeAll();

        assert.equal(client.primeOutcomeOf('m'), 'ok');
        assert.equal(client.entryCountOf('m'), 2);
    });

    test('a resolving scope with ZERO entries reports outcome ok and a count of 0 -- not an error', async () => {
        const callTool = primingCallTool({ prime: { content: [{ text: JSON.stringify({ top_entries: [] }) }] } });
        const client = createKbPrimingClient({ callTool, members: ['m'], log: () => {} });

        await client.primeAll();

        assert.equal(client.primeOutcomeOf('m'), 'ok');
        assert.equal(client.entryCountOf('m'), 0);
    });

    test('a tool-level MCP error (which RESOLVES rather than throwing) reports tool-unavailable, never a zero-entry pass', async () => {
        const callTool = primingCallTool({ prime: { isError: true, content: [{ text: 'knowledge scope refused' }] } });
        const client = createKbPrimingClient({ callTool, members: ['m'], log: () => {} });

        await client.primeAll();

        assert.equal(client.primeOutcomeOf('m'), 'tool-unavailable');
        assert.ok(client.primeErrorOf('m').includes('knowledge scope refused'));
        assert.equal(client.entryCountOf('m'), 0);
    });

    test('a member with no work folder reports no-folder, distinctly from a tool failure', async () => {
        const callTool = primingCallTool({ folder: '', prime: { content: [{ text: '{}' }] } });
        const client = createKbPrimingClient({ callTool, members: ['m'], log: () => {} });

        await client.primeAll();

        assert.equal(client.primeOutcomeOf('m'), 'no-folder');
        assert.equal(client.entryCountOf('m'), 0);
    });

    test('the upstream mcp_scope record is carried through from member_detail verbatim', async () => {
        const mcpScope = { scoped: false, reason: 'human-disabled', remediation: 're-enable the fleet server for this member', resolvedAt: '2026-09-29T00:00:00.000Z' };
        const callTool = primingCallTool({ mcpScope, prime: { content: [{ text: JSON.stringify({ top_entries: [{ id: 'a' }] }) }] } });
        const client = createKbPrimingClient({ callTool, members: ['m'], log: () => {} });

        await client.primeAll();

        assert.deepEqual(client.mcpScopeOf('m'), mcpScope);
        // member_detail is asked ONCE per member: the scope record rides the
        // same round trip the folder does, never a second probe.
        assert.equal(callTool.calls.filter((c) => c.name === 'member_detail').length, 1);
    });

    test('with no transport wired, every member is still reported rather than silently absent', async () => {
        const client = createKbPrimingClient({ members: ['m'], log: () => {} });

        await client.primeAll();

        assert.equal(client.primeOutcomeOf('m'), 'no-transport');
        assert.equal(client.entryCountOf('m'), 0);
    });
});
