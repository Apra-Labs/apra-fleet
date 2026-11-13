import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createKbWorkClient } from '../fleet-sprint/kb.mjs';
import { validateArgs } from '../fleet-sprint/sprint-args.mjs';
import { selfMaintainer } from './helpers/kb-maintainer-fakes.mjs';
import { buildRunnerArgs } from '../bin/cli.mjs';
import { buildSprintArgv, createSpawner } from '../src/supervisor/spawner.mjs';
import { createSprintController, ApiError } from '../src/supervisor/api.mjs';
import { createLedger, LEDGER_FILENAME } from '../src/supervisor/ledger.mjs';
import { createHistory, HISTORY_FILENAME } from '../src/supervisor/history.mjs';

// The reviewer demotion loop off switch (sprint arg kb_demotion_loop). Runs the
// real createKbWorkClient; only the memberCall boundary records calls.

const MAINT = { id: 'id-maint', name: 'maint', type: 'local' };
const REASON = 'verified against the merged code in this round';
const CHANGED_FILE = 'src/thing.js';
const ROW = {
    id: 'kb-ok', type: 'knowledge', confidence: 'CONFIRMED', title: 'kb-ok', summary: 'kb-ok',
    source_files: [CHANGED_FILE],
};

function build(extra = {}) {
    const events = [];
    const logs = [];
    const memberCall = async (member, tool, args) => {
        events.push({ ev: tool, args });
        if (tool === 'kb_query') return { l1_results: args.own_scope ? [ROW] : [] };
        return {};
    };
    const client = createKbWorkClient({
        memberCall,
        maintainers: selfMaintainer(MAINT, ['maint', 'reviewer-1']),
        gPull: async () => {},
        gPush: async () => {},
        bibleBase: async () => ({ baseBranch: 'main', baseCommit: 'a'.repeat(40) }),
        roundChangedFiles: async () => [CHANGED_FILE],
        log: (m) => logs.push(m),
        ...extra,
    });
    return { client, events, logs };
}

const demoteOutput = { kb_demotions: [{ id: 'kb-ok', reason: REASON, evidence_files: [CHANGED_FILE] }] };

describe('kb_demotion_loop switch: createKbWorkClient', () => {
    for (const [label, extra] of [['absent', {}], ["'on'", { demotionLoop: 'on' }]]) {
        test(`setting ${label}: candidates are offered and the demotion is applied`, async () => {
            const { client, events } = build(extra);
            const offered = await client.demotionCandidates('reviewer-1');
            assert.deepEqual(offered.map((e) => e.id), ['kb-ok']);
            const out = await client.apply('reviewer', 'reviewer-1', demoteOutput);
            assert.equal(out.demoted, 1);
            assert.equal(events.filter((e) => e.ev === 'kb_demote').length, 1);
        });
    }

    test("setting 'off': no candidates, no kb_query read, no kb_demote, and the log names the setting", async () => {
        const { client, events, logs } = build({ demotionLoop: 'off' });
        const offered = await client.demotionCandidates('reviewer-1');
        assert.deepEqual(offered, []);
        const out = await client.apply('reviewer', 'reviewer-1', demoteOutput);
        assert.equal(out.demoted, 0);
        assert.equal(events.filter((e) => e.ev === 'kb_demote').length, 0);
        assert.equal(events.filter((e) => e.ev === 'kb_query').length, 0);
        assert.ok(logs.some((l) => l.includes('demotion loop is disabled') && l.includes('kb_demotion_loop')), JSON.stringify(logs));
    });

    test('an invalid value fails loudly, naming the value', () => {
        assert.throws(() => build({ demotionLoop: 'maybe' }), /Invalid demotionLoop "maybe"/);
    });
});

describe('kb_demotion_loop switch: sprint arg validation', () => {
    const base = { target_issue: 'x-1', members: ['m1'], branch: 'sprint/a', base_branch: 'main' };
    test('defaults to on when absent; accepts on/off', () => {
        assert.equal(validateArgs(base).kbDemotionLoop, 'on');
        assert.equal(validateArgs({ ...base, kb_demotion_loop: 'off' }).kbDemotionLoop, 'off');
    });
    test('rejects any other value loudly', () => {
        assert.throws(() => validateArgs({ ...base, kb_demotion_loop: 'false' }), /Invalid kb_demotion_loop "false"/);
    });
});

describe('kb_demotion_loop switch: cli.mjs and the spawner argv', () => {
    test('cli.mjs forwards --kb-demotion-loop as the runner arg only when given', () => {
        const base = { targetIssues: ['PROJ-1'], members: ['m1'], branch: 'feat/x', baseBranch: 'main', goal: 'P1/P2', maxCycles: 1 };
        assert.equal(buildRunnerArgs({ ...base, kbDemotionLoop: 'off' }).kb_demotion_loop, 'off');
        assert.equal('kb_demotion_loop' in buildRunnerArgs({ ...base }), false);
    });
    test('buildSprintArgv emits --kb-demotion-loop <value> only when set', () => {
        const base = { issue: 'PROJ-1', members: 'm1', branch: 'feat/x', base: 'main', viewerPort: 9100 };
        const argv = buildSprintArgv({ ...base, kbDemotionLoop: 'off' });
        assert.equal(argv[argv.indexOf('--kb-demotion-loop') + 1], 'off');
        assert.equal(buildSprintArgv({ ...base }).includes('--kb-demotion-loop'), false);
    });
});

describe('kb_demotion_loop switch: supervisor POST /api/sprints kbDemotionLoop', () => {
    async function makeController(captured) {
        const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'kbdemote-api-'));
        const ledger = createLedger({ filePath: path.join(dir, LEDGER_FILENAME), now: () => '2026-10-01T00:00:00.000Z' });
        await ledger.start();
        const history = createHistory({ filePath: path.join(dir, HISTORY_FILENAME), now: () => '2026-10-01T00:00:00.000Z' });
        await history.start();
        let nextPid = 7100;
        const spawner = createSpawner({
            basePort: 9400,
            isPortAvailable: async () => true,
            dataDir: 'unused-data-dir',
            fs: { mkdirSync() {}, openSync() { return 3; }, closeSync() {} },
            spawn: (command, args) => {
                const pid = nextPid++;
                captured.push({ command, args, pid });
                return { pid, once() { return this; }, unref() {} };
            },
        });
        const controller = createSprintController({
            ledger, history, spawner,
            listMembers: () => ({ members: [] }),
            getBacklog: () => ({ tasks: [] }),
        });
        return { controller, dir };
    }
    const LAUNCH = { issue: 'PROJ-1', members: ['alice'], branch: 'feat/x', base: 'main' };

    for (const value of ['off', 'on']) {
        test(`kbDemotionLoop "${value}" reaches the child argv as --kb-demotion-loop ${value}`, async () => {
            const captured = [];
            const { controller, dir } = await makeController(captured);
            try {
                await controller.launch({ ...LAUNCH, kbDemotionLoop: value });
                assert.equal(captured.length, 1);
                const args = captured[0].args;
                assert.equal(args[args.indexOf('--kb-demotion-loop') + 1], value);
            } finally {
                await fsp.rm(dir, { recursive: true, force: true });
            }
        });
    }

    test('omitted: the child is launched without the flag (engine default on)', async () => {
        const captured = [];
        const { controller, dir } = await makeController(captured);
        try {
            await controller.launch({ ...LAUNCH });
            assert.equal(captured.length, 1);
            assert.equal(captured[0].args.includes('--kb-demotion-loop'), false);
        } finally {
            await fsp.rm(dir, { recursive: true, force: true });
        }
    });

    for (const bad of ['false', false, null, 'OFF', '']) {
        test(`rejects ${JSON.stringify(bad)} with a 400 naming kbDemotionLoop, and spawns nothing`, async () => {
            const captured = [];
            const { controller, dir } = await makeController(captured);
            try {
                await assert.rejects(
                    () => controller.launch({ ...LAUNCH, kbDemotionLoop: bad }),
                    (err) => err instanceof ApiError && err.status === 400 && err.field === 'kbDemotionLoop'
                        && err.message.includes(JSON.stringify(bad)),
                );
                assert.equal(captured.length, 0);
            } finally {
                await fsp.rm(dir, { recursive: true, force: true });
            }
        });
    }
});
