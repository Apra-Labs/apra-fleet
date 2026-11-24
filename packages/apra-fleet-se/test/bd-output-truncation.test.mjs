import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    createBeadsScope, parseBdJson, BdOutputTruncatedError, FULL_DB_BRIEF_FETCH_CMD, BD_BRIEF_OMITTED_FIELDS,
} from '../fleet-sprint/beads-scope.mjs';

// A large beads database used to crash every sprint at its first scope read:
// execute_command keeps only the head of an over-cap stdout and puts an
// `[OUTPUT TRUNCATED -- ...]` note in front, so the unscoped full-text
// `bd list --all --limit 0 --json` came back as non-JSON. These tests stand
// in for that server cap and pin (1) a typed, named error instead of a bare
// JSON parse crash and (2) engine reads that stay under the cap on a database
// whose full-text dump does not.

const CAP_BYTES = 200 * 1024;

/** execute_command's over-cap behaviour: head kept, spill note in front. */
function capped(stdout) {
    if (Buffer.byteLength(stdout) <= CAP_BYTES) return stdout;
    return `[OUTPUT TRUNCATED -- full stdout saved to /tmp/fleet-stdout-test.txt]\n${stdout.slice(0, CAP_BYTES)}`;
}

function strip(row) {
    const out = { ...row };
    for (const f of BD_BRIEF_OMITTED_FIELDS) delete out[f];
    return out;
}

/** 400 beads with 2KB of free text each (~0.9MB full text, well over CAP_BYTES). */
function bigDb() {
    const text = 'x'.repeat(2048);
    const beads = [{ id: 'root', status: 'open', title: 'Root', description: 'root text' }];
    beads.push({ id: 'root.1', parent: 'root', status: 'closed', title: 'Child 1', description: 'child one text', acceptance_criteria: 'ac one' });
    beads.push({ id: 'root.2', parent: 'root', status: 'open', title: 'Child 2', description: 'child two text' });
    for (let i = 0; i < 400; i++) {
        beads.push({ id: `other-${i}`, status: 'closed', title: `Unrelated ${i}`, description: text, notes: text });
    }
    return beads;
}

/** A `bd list` stand-in honouring --brief, --id and --status, behind the cap. */
function makeCommand(beads, log) {
    return async (cmd) => {
        log.push(cmd);
        if (!/^bd list /.test(cmd)) return '';
        let rows = beads;
        const ids = /--id\s+(\S+)/.exec(cmd);
        if (ids) rows = rows.filter((b) => ids[1].split(',').includes(b.id));
        const status = /--status=(\S+)/.exec(cmd);
        if (status) rows = rows.filter((b) => b.status === status[1]);
        if (/\s--brief(\s|$)/.test(cmd)) rows = rows.map(strip);
        return capped(JSON.stringify(rows, null, 2));
    };
}

describe('bd JSON output cut by the execute_command size cap', () => {
    test('parseBdJson throws a typed BdOutputTruncatedError naming the command and the spill path', () => {
        const raw = '[OUTPUT TRUNCATED -- full stdout saved to C:\\Temp\\fleet-local-stdout-1.txt]\n[\n  {\n    "id": "a"';
        assert.throws(
            () => parseBdJson(raw, 'bd list --all --limit 0 --json'),
            (err) => {
                assert.ok(err instanceof BdOutputTruncatedError);
                assert.equal(err.code, 'BD_OUTPUT_TRUNCATED');
                assert.equal(err.commandLabel, 'bd list --all --limit 0 --json');
                assert.equal(err.spillPath, 'C:\\Temp\\fleet-local-stdout-1.txt');
                assert.match(err.message, /narrow it/);
                assert.doesNotMatch(err.message, /JSON Parse Error/);
                return true;
            },
        );
    });

    test('the stand-in really does truncate the old unscoped full-text read', async () => {
        const run = makeCommand(bigDb(), []);
        const raw = await run('bd list --all --limit 0 --json');
        assert.throws(() => parseBdJson(raw, 'bd list --all --limit 0 --json'), BdOutputTruncatedError);
    });

    test('the scope snapshot stays under the cap and in-scope rows keep their free text', async () => {
        const log = [];
        const scope = createBeadsScope({ targetIssues: ['root'], parseBdJson, getBacklogMember: () => 'm' });
        scope.wrapCommand(makeCommand(bigDb(), log));

        const all = await scope.fetchAllBeadsShared();
        assert.equal(all.length, 403);
        assert.ok(!log.includes('bd list --all --limit 0 --json'), 'the unscoped full-text read must not be issued');
        assert.equal(log[0], FULL_DB_BRIEF_FETCH_CMD);

        const inScope = await scope.bdListScoped('');
        const byId = new Map(inScope.map((b) => [b.id, b]));
        assert.deepEqual([...byId.keys()].sort(), ['root', 'root.1', 'root.2']);
        assert.equal(byId.get('root.1').description, 'child one text');
        assert.equal(byId.get('root.1').acceptance_criteria, 'ac one');
        assert.equal(byId.get('root.1').parent, 'root');
        const outOfScope = all.find((b) => b.id === 'other-0');
        assert.equal(outOfScope.description, undefined, 'out-of-scope rows stay brief');
    });

    test('the per-cycle closed read stays under the cap on the same database', async () => {
        const log = [];
        const scope = createBeadsScope({ targetIssues: ['root'], parseBdJson, getBacklogMember: () => 'm' });
        scope.wrapCommand(makeCommand(bigDb(), log));
        const closed = await scope.bdListScoped('--status=closed --json --brief');
        assert.deepEqual(closed.map((b) => b.id), ['root.1']);
    });

    test('a scope larger than one id chunk is read back in several commands', async () => {
        const beads = [{ id: 'root', status: 'open', title: 'Root' }];
        for (let i = 0; i < 250; i++) beads.push({ id: `root.${i}`, parent: 'root', status: 'open', title: `C${i}`, description: `d${i}` });
        const log = [];
        const scope = createBeadsScope({ targetIssues: ['root'], parseBdJson, getBacklogMember: () => 'm' });
        scope.wrapCommand(makeCommand(beads, log));
        const inScope = await scope.bdListScoped('');
        assert.equal(inScope.length, 251);
        assert.ok(inScope.filter((b) => b.id !== 'root').every((b) => /^d\d+$/.test(b.description)));
        assert.equal(log.filter((c) => / --id /.test(c)).length, 3);
    });
});
