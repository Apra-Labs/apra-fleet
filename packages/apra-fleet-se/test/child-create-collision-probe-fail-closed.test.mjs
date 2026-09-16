import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createChildBeadWithAllocatedId, classifyBdShowProbeError } from '../fleet-sprint/beads-children.mjs';

// apra-fleet-btj9.6: regression test for the fail-closed fix to the collision
// probe's catch branch in createChildBeadWithAllocatedId
// (fleet-sprint/beads-children.mjs).
//
// THE BUG THIS GUARDS AGAINST: the probe's old catch branch assumed `bd show
// <missing-id> --json` yields `[]` rather than throwing -- a false premise.
// Verified live against installed bd 1.1.0 (8e4e59d3): `bd show <missing-id>
// --json` exits non-zero and prints `{"error": "no issues found matching the
// provided IDs", "schema_version": 1}`. So the ordinary "id is free" case
// ALWAYS lands in the catch branch, indistinguishable there from a genuine
// dispatch fault unless the catch classifies its error payload. The old code
// treated every catch as "unknown, proceed with create" -- i.e. it FAILED
// OPEN on every unevaluable probe, degrading back into the exact overwrite
// behavior apra-fleet-btj9 exists to prevent.
//
// Falsifiability confirmed by hand: reverting the classification in the catch
// branch to unconditionally set `existing = null` (the old fail-open
// behavior) makes the "malformed/unknown probe error" test below fail -- the
// create proceeds instead of being refused.

function extractStageBase64(cmd) {
    if (!/^node -e "/.test(cmd)) return null;
    const m = cmd.match(/"([A-Za-z0-9+/=]*)"\s*$/);
    return m ? m[1] : null;
}

// Builds a `bd show` error exactly the way real bd 1.1.0 reports a missing
// issue (verified payload, see test/fixtures/bd-recordings/apra-fleet-mock-
// sprint-integfail.jsonl:35), wrapped the way production's
// FleetWorkflow.command() wraps a non-zero exit -- raw stdout embedded in
// `.message` AND mirrored on `.details.text` (see
// packages/apra-fleet-workflow/src/workflow/errors.mjs CommandError).
function bdShowMissingIdError(childId) {
    const stdout = '{\n  "error": "no issues found matching the provided IDs",\n  "schema_version": 1\n}\n';
    const err = new Error(`[Command Failed] Exit code 1: ${stdout}`);
    err.code = 'COMMAND_FAILED';
    err.details = { text: stdout, command: `bd show ${childId} --json`, exitCode: 1 };
    return err;
}

function makeFixedIdAllocator(childId) {
    const calls = { allocate: 0, confirm: 0, release: 0 };
    return {
        calls,
        async allocate() { calls.allocate += 1; return { childId, token: 'tok-fail-closed' }; },
        async confirm() { calls.confirm += 1; return true; },
        async release() { calls.release += 1; return true; },
    };
}

describe('classifyBdShowProbeError (apra-fleet-btj9.6)', () => {
    test('the real bd 1.1.0 no-issues-found payload classifies as absent', () => {
        const err = bdShowMissingIdError('parent-1.9');
        assert.strictEqual(classifyBdShowProbeError(err), 'absent');
    });

    test('a differently-shaped error payload classifies as unknown', () => {
        const err = new Error('[Command Failed] Exit code 1: {"error": "database locked", "schema_version": 1}');
        assert.strictEqual(classifyBdShowProbeError(err), 'unknown');
    });

    test('unparseable/non-JSON output classifies as unknown', () => {
        const err = new Error('ECONNRESET: transport failure reaching member');
        assert.strictEqual(classifyBdShowProbeError(err), 'unknown');
    });
});

describe('createChildBeadWithAllocatedId -- collision probe fails closed on an unevaluable outcome (apra-fleet-btj9.6)', () => {
    test('a genuinely free id (probe throws bd\'s real no-issues-found error) still creates normally', async () => {
        const targetId = 'parent-1.9';
        const calls = [];
        const created = {};
        const command = async (cmd) => {
            calls.push(cmd);
            const b64 = extractStageBase64(cmd);
            if (b64 !== null) {
                const content = Buffer.from(b64, 'base64').toString('utf-8');
                const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fail-closed-'));
                const filePath = path.join(dir, 'body.txt');
                await fs.writeFile(filePath, content, 'utf-8');
                return filePath;
            }
            if (new RegExp(`^bd show ${targetId} --json$`).test(cmd)) {
                throw bdShowMissingIdError(targetId);
            }
            const createMatch = cmd.match(/^bd create "([^"]*)" --body-file "([^"]*)" -p "([^"]*)" --id (\S+) --silent$/);
            if (createMatch) {
                const [, title, bodyFile, priority, id] = createMatch;
                created.title = title;
                created.priority = priority;
                created.id = id;
                created.description = await fs.readFile(bodyFile, 'utf-8');
                return '';
            }
            if (/^bd update \S+ --parent \S+$/.test(cmd)) return '';
            throw new Error(`unexpected command in fail-closed test fake: ${cmd}`);
        };
        const allocator = makeFixedIdAllocator(targetId);

        const result = await createChildBeadWithAllocatedId({
            command,
            allocator,
            member: 'local',
            title: 'Brand New Task',
            description: 'A genuinely new follow-up on a free id.',
            priority: 'P2',
            parentId: 'parent-1',
        });

        assert.strictEqual(result.childId, targetId);
        assert.strictEqual(allocator.calls.confirm, 1);
        assert.strictEqual(allocator.calls.release, 0);
        assert.strictEqual(created.id, targetId);
        assert.strictEqual(created.title, 'Brand New Task');
        assert.ok(
            calls.some((c) => c.startsWith('bd create ')),
            `expected a bd create dispatch, got: ${JSON.stringify(calls)}`,
        );
    });

    test('a probe that cannot be evaluated (malformed/unrecognized error payload) refuses the create -- fail closed', async () => {
        const targetId = 'parent-1.3';
        const calls = [];
        const command = async (cmd) => {
            calls.push(cmd);
            if (new RegExp(`^bd show ${targetId} --json$`).test(cmd)) {
                const err = new Error('[Workflow Error] Transport failure while executing command: ECONNRESET');
                err.code = 'TRANSPORT_ERROR';
                throw err;
            }
            throw new Error(`unexpected command in fail-closed test fake: ${cmd}`);
        };
        const allocator = makeFixedIdAllocator(targetId);

        await assert.rejects(
            () => createChildBeadWithAllocatedId({
                command,
                allocator,
                member: 'local',
                title: 'Should Not Be Created',
                description: 'This create must be refused, not silently allowed through.',
                priority: 'P2',
                parentId: 'parent-1',
            }),
            /refusing to create child bead at id 'parent-1\.3': the collision probe could not be evaluated/,
        );

        assert.strictEqual(allocator.calls.release, 1, 'the reservation must be released when the probe cannot be evaluated');
        assert.strictEqual(allocator.calls.confirm, 0, 'confirm must never be called when the probe cannot be evaluated');
        assert.ok(
            !calls.some((c) => c.startsWith('bd create ')),
            `no bd create dispatch must occur when the probe fails closed, got: ${JSON.stringify(calls)}`,
        );
    });
});
