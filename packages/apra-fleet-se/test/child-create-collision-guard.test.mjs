import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createChildBeadWithAllocatedId } from '../fleet-sprint/runner.js';

// apra-fleet-btj9.2: regression test for the collision guard added to
// createChildBeadWithAllocatedId (fleet-sprint/beads-children.mjs) by the
// sibling impl task apra-fleet-btj9.1. `bd create --id <id>` SILENTLY
// OVERWRITES an existing bead at that id (open OR closed) -- it reuses the
// same row and clobbers title/description/priority/type with no error. The
// fix probes `bd show <id> --json` before creating and refuses (throws,
// releases the allocator reservation) rather than create when a bead
// already occupies the allocated id.
//
// This drives createChildBeadWithAllocatedId directly (the real production
// seam, re-exported from runner.js) against an injected command() fake that
// emulates a small persistent bd STORE: `bd show` reads it, and `bd create
// --id <id>` (the ACTUAL bd behavior being guarded against) unconditionally
// overwrites it. That lets the test assert the stronger property the bead
// calls for -- the original bead's content is byte-for-byte unchanged
// afterward -- not merely that an error was thrown: if the collision guard
// regresses and the create dispatch reaches the fake, the fake's overwrite
// semantics will actually mutate the store and the content assertion will
// catch it, exactly as a real `bd create --id` would.
//
// Falsifiability confirmed by hand: temporarily reverting the `if
// (grant.childId) { ... }` probe block in createChildBeadWithAllocatedId
// (fleet-sprint/beads-children.mjs) makes both tests below fail --
// createChildBeadWithAllocatedId no longer rejects, and the store's content
// for the target id changes to the NEW title/description passed to this
// call, exactly like a real silent overwrite.

function extractStageBase64(cmd) {
    if (!/^node -e "/.test(cmd)) return null;
    const m = cmd.match(/"([A-Za-z0-9+/=]*)"\s*$/);
    return m ? m[1] : null;
}

// A command() fake that plays a tiny persistent bd store: `bd show <id>
// --json` reads it, `bd create ... --id <id> --silent` OVERWRITES it (the
// real bd behavior the guard exists to prevent from ever being reached),
// and `bd update <id> --parent <parentId>` is a no-op success.
function makeStoreEmulatingCommand(initialEntries) {
    const store = new Map(initialEntries.map((b) => [b.id, { ...b }]));
    const calls = [];
    const command = async (cmd) => {
        calls.push(cmd);
        const b64 = extractStageBase64(cmd);
        if (b64 !== null) {
            const content = Buffer.from(b64, 'base64').toString('utf-8');
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'collision-guard-'));
            const filePath = path.join(dir, 'body.txt');
            await fs.writeFile(filePath, content, 'utf-8');
            return filePath;
        }
        const showMatch = cmd.match(/^bd show (\S+) --json$/);
        if (showMatch) {
            const existing = store.get(showMatch[1]);
            return JSON.stringify(existing ? [existing] : []);
        }
        const createMatch = cmd.match(/^bd create "([^"]*)" --body-file "([^"]*)" -p "([^"]*)" --id (\S+) --silent$/);
        if (createMatch) {
            const [, title, bodyFile, priority, id] = createMatch;
            const description = await fs.readFile(bodyFile, 'utf-8');
            // Mirrors real bd: overwrites the row unconditionally, no error.
            store.set(id, { id, title, description, priority, issue_type: 'task', status: 'open' });
            return '';
        }
        if (/^bd update \S+ --parent \S+$/.test(cmd)) return '';
        throw new Error(`unexpected command in collision-guard test fake: ${cmd}`);
    };
    return { command, calls, store };
}

function makeFixedIdAllocator(childId) {
    const calls = { allocate: 0, confirm: 0, release: 0 };
    return {
        calls,
        async allocate() { calls.allocate += 1; return { childId, token: 'tok-collision' }; },
        async confirm() { calls.confirm += 1; return true; },
        async release() { calls.release += 1; return true; },
    };
}

describe('createChildBeadWithAllocatedId -- collision guard refuses to overwrite an existing id (apra-fleet-btj9.2)', () => {
    test('a CLOSED bead already at the allocated id: create is refused, content unchanged', async () => {
        const targetId = 'parent-1.2';
        const original = {
            id: targetId,
            title: 'Original Title',
            description: 'Original description text.',
            priority: 'P2',
            issue_type: 'task',
            status: 'closed',
        };
        const { command, calls, store } = makeStoreEmulatingCommand([original]);
        const allocator = makeFixedIdAllocator(targetId);

        await assert.rejects(
            () => createChildBeadWithAllocatedId({
                command,
                allocator,
                member: 'local',
                title: 'New Title',
                description: 'New description that would have overwritten the original.',
                priority: 'P0',
                parentId: 'parent-1',
            }),
            /refusing to create child bead at id 'parent-1\.2': a bead with that id already exists/,
        );

        assert.deepStrictEqual(
            store.get(targetId),
            original,
            'the original CLOSED bead content must be byte-for-byte unchanged after the rejected create',
        );
        assert.strictEqual(allocator.calls.release, 1, 'the reservation must be released on collision');
        assert.strictEqual(allocator.calls.confirm, 0, 'confirm must never be called on a refused create');
        assert.ok(
            !calls.some((c) => c.startsWith('bd create ')),
            `no bd create dispatch must occur on a refused create, got: ${JSON.stringify(calls)}`,
        );
    });

    test('an OPEN bead already at the allocated id: create is likewise refused, content unchanged', async () => {
        const targetId = 'parent-1.5';
        const original = {
            id: targetId,
            title: 'Untouched Open Title',
            description: 'Untouched open description.',
            priority: 'P1',
            issue_type: 'bug',
            status: 'open',
        };
        const { command, calls, store } = makeStoreEmulatingCommand([original]);
        const allocator = makeFixedIdAllocator(targetId);

        await assert.rejects(
            () => createChildBeadWithAllocatedId({
                command,
                allocator,
                member: 'local',
                title: 'Colliding New Title',
                description: 'Colliding new description.',
                priority: 'P3',
                parentId: 'parent-1',
            }),
            /refusing to create child bead at id 'parent-1\.5': a bead with that id already exists/,
        );

        assert.deepStrictEqual(
            store.get(targetId),
            original,
            'the original OPEN bead content must be byte-for-byte unchanged after the rejected create',
        );
        assert.strictEqual(allocator.calls.release, 1);
        assert.strictEqual(allocator.calls.confirm, 0);
        assert.ok(!calls.some((c) => c.startsWith('bd create ')));
    });

    test('a genuinely free allocated id still creates successfully (no false-positive collision)', async () => {
        const targetId = 'parent-1.9';
        const { command, store } = makeStoreEmulatingCommand([]);
        const allocator = makeFixedIdAllocator(targetId);

        const result = await createChildBeadWithAllocatedId({
            command,
            allocator,
            member: 'local',
            title: 'Brand New Task',
            description: 'A genuinely new follow-up.',
            priority: 'P2',
            parentId: 'parent-1',
        });

        assert.strictEqual(result.childId, targetId);
        assert.strictEqual(allocator.calls.confirm, 1);
        assert.strictEqual(allocator.calls.release, 0);
        const created = store.get(targetId);
        assert.strictEqual(created.title, 'Brand New Task');
        assert.strictEqual(created.description, 'A genuinely new follow-up.');
    });
});
