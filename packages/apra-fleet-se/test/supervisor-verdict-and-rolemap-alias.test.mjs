// Watchdog FINISHED verdict falls back to result.verdict (a normal finish has no
// extensions.terminal), and the roleMap 400 for a non-backlog member names the
// key the caller actually sent.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { defaultRecordFinished, formatFinishedDetail } from '../src/supervisor/watchdog.mjs';
import { HISTORY_EVENTS } from '../src/supervisor/history.mjs';
import { createSprintController } from '../src/supervisor/api.mjs';

function record(state) {
    const lines = [];
    const events = [];
    defaultRecordFinished({
        sprintId: 's1', state,
        logger: { log: (...a) => lines.push(a.join(' ')), error() {} },
        history: { record: async (e) => { events.push(e); return e; } },
    });
    return { lines, events };
}

describe('FINISHED verdict from result.verdict', () => {
    for (const verdict of ['PASS', 'FAIL']) {
        test(`result.verdict ${verdict} with no extensions.terminal reaches the log line and history event`, () => {
            const { lines, events } = record({ terminalReason: 'success', result: { verdict } });
            assert.match(lines[0], new RegExp(`verdict=${verdict}`));
            assert.equal(events[0].event, HISTORY_EVENTS.FINISHED);
            assert.equal(events[0].verdict, verdict);
        });
    }

    test('extensions.terminal.verdict ABORTED still wins and is recorded', () => {
        const { lines, events } = record({ terminalReason: 'ABORT', extensions: { terminal: { verdict: 'ABORTED' } }, result: { verdict: 'PASS' } });
        assert.match(lines[0], /verdict=ABORTED/);
        assert.equal(events[0].verdict, 'ABORTED');
    });

    test('no verdict anywhere stays null / omitted', () => {
        assert.equal(record({ terminalReason: 'x' }).events[0].verdict, null);
        assert.doesNotMatch(formatFinishedDetail({ terminalReason: 'x' }), /verdict/);
    });
});

describe('roleMap 400 names the key the caller sent', () => {
    function controller() {
        return createSprintController({
            ledger: { list: () => [], get: () => undefined, claim: async () => { throw new Error('must not claim'); } },
            spawner: { spawnSprint: async () => { throw new Error('must not spawn'); } },
            listMembers: () => ({ members: [] }),
            backlogMember: { get: () => ({ status: 'ready', member: { name: 'pinned' }, reason: null }) },
        });
    }
    const launch = (roleMap) => controller().launch({ issue: 'x-1', members: ['m1'], branch: 'f/x', base: 'main', roleMap: JSON.stringify(roleMap) });

    test('deprecated orchestrator key -> text names it as the deprecated alias of roleMap.backlog', async () => {
        await assert.rejects(launch({ orchestrator: ['other'] }), (err) => {
            assert.equal(err.status, 400);
            assert.match(err.message, /roleMap\.orchestrator \(the deprecated alias of roleMap\.backlog\)/);
            return true;
        });
    });

    test('backlog key -> text names roleMap.backlog, not the alias', async () => {
        await assert.rejects(launch({ backlog: ['other'] }), (err) => {
            assert.equal(err.status, 400);
            assert.match(err.message, /^\[Arg Contract\] roleMap\.backlog must be/);
            assert.doesNotMatch(err.message, /orchestrator/);
            return true;
        });
    });
});
