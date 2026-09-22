import { test, describe, after } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createChildBeadWithAllocatedId } from '../fleet-sprint/runner.js';

// Every mkdtemp'd staging dir created by the command fakes below is tracked
// here and removed in the file-level after() hook, so this test file leaves
// no leftover directories under the system temp dir.
const stagedTempDirs = [];
after(async () => {
    await Promise.all(stagedTempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// apra-fleet-btj9.2: regression test for the create-landed-but-link-failed
// path in createChildBeadWithAllocatedId (fleet-sprint/beads-children.mjs).
//
// THE BUG. createChildBeadWithAllocatedId used to wrap `bd create` AND the
// follow-up `bd update <id> --parent <parentId>` link in a SINGLE try/catch
// whose catch unconditionally called allocator.release(grant.token) and
// logged "the bd create failed and released the reservation" -- true on the
// create-dispatch-fault branch, but FALSE on the link-failure branch, where
// the create already landed. Releasing an id that is genuinely occupied
// returns it to the allocator's reuse pool; the NEXT allocate() under that
// parent re-mints the SAME id, assertChildIdFree's probe finds the
// (unlinked) bead already there, and every subsequent newTask under that
// parent hard-refuses forever (apra-fleet-btj9's collision guard doing its
// job, but against a self-inflicted collision).
//
// THE FIX. Split the try so a create-dispatch failure (the create did NOT
// land) still releases, but confirm() fires as soon as `bd create` lands,
// and a subsequent link failure throws a distinct, orphan-naming error
// instead of releasing.
//
// Falsifiability confirmed by hand: reverting to a single try/catch around
// both the create and the link dispatch, with an unconditional
// allocator.release() in the catch, makes the first and third tests below
// fail -- release fires instead of confirm in the first test, and the
// second createChildBeadWithAllocatedId call in the third test re-mints
// 'parent-4.1' and hits the id-already-exists refusal instead of minting a
// fresh id.

function extractStageBase64(cmd) {
    if (!/^node -e "/.test(cmd)) return null;
    const m = cmd.match(/"([A-Za-z0-9+/=]*)"\s*$/);
    return m ? m[1] : null;
}

// A command() fake modelling a tiny persistent bd store (bd show reads it,
// bd create writes it), PLUS a configurable bd-update-link outcome:
// `linkShouldFail(id)` decides, per dispatched `bd update <id> --parent
// <parentId>` call, whether that link succeeds.
function makeStoreEmulatingCommand({ linkShouldFail = () => false } = {}) {
    const store = new Map();
    const calls = [];
    const command = async (cmd) => {
        calls.push(cmd);
        const b64 = extractStageBase64(cmd);
        if (b64 !== null) {
            const content = Buffer.from(b64, 'base64').toString('utf-8');
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'link-failure-'));
            stagedTempDirs.push(dir);
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
            store.set(id, { id, title, description, priority, issue_type: 'task', status: 'open' });
            return '';
        }
        const updateMatch = cmd.match(/^bd update (\S+) --parent (\S+)$/);
        if (updateMatch) {
            const [, id] = updateMatch;
            if (linkShouldFail(id)) {
                throw new Error(`simulated bd update --parent dispatch fault for ${id}`);
            }
            return '';
        }
        throw new Error(`unexpected command in link-failure test fake: ${cmd}`);
    };
    return { command, calls, store };
}

// A sequential allocator mirroring the REAL reserve -> confirm/release
// contract documented in beads-children.mjs (line 228 and around): allocate()
// reserves the next id past the durable floor (pending); confirm() durably
// advances the floor (the id can never be re-minted again); release() drops
// the pending reservation WITHOUT advancing the floor, so the next
// allocate() re-mints the SAME id. This is what lets the third test below
// prove the fix end to end: if the fix regressed back to releasing on a
// link failure, the second createChildBeadWithAllocatedId call would
// re-mint the orphaned first id instead of a fresh one.
function makeSequentialAllocator(parentId, startFloor = 0) {
    const calls = { allocate: 0, confirm: 0, release: 0 };
    let floor = startFloor;
    let pending = null;
    return {
        calls,
        async allocate() {
            calls.allocate += 1;
            const seq = floor + 1;
            pending = { seq, token: `tok-${seq}` };
            return { childId: `${parentId}.${seq}`, token: pending.token };
        },
        async confirm(token) {
            calls.confirm += 1;
            if (pending && pending.token === token) {
                floor = pending.seq;
                pending = null;
            }
        },
        async release(token) {
            calls.release += 1;
            if (pending && pending.token === token) {
                pending = null;
            }
        },
    };
}

describe('createChildBeadWithAllocatedId -- a post-create link failure does not release the reservation (apra-fleet-btj9.2)', () => {
    test('bd create lands, bd update --parent fails: confirm is called, release is NOT, and the error names the orphan id', async () => {
        const parentId = 'parent-2';
        const { command } = makeStoreEmulatingCommand({ linkShouldFail: () => true });
        const allocator = makeSequentialAllocator(parentId);

        await assert.rejects(
            () => createChildBeadWithAllocatedId({
                command,
                allocator,
                member: 'local',
                title: 'Task whose link will fail',
                description: 'The create lands but the parent link dispatch fails.',
                priority: 'P2',
                parentId,
            }),
            (err) => {
                assert.match(err.message, /child bead 'parent-2\.1' was created but is UNLINKED/);
                assert.doesNotMatch(
                    err.message,
                    /refusing to create child bead/,
                    'must be distinct from the PRESENT/UNKNOWN probe refusals',
                );
                assert.doesNotMatch(
                    err.message,
                    /collision probe could not be evaluated/,
                    'must be distinct from the UNKNOWN probe refusal',
                );
                return true;
            },
        );

        assert.strictEqual(allocator.calls.confirm, 1, 'confirm must be called -- the create genuinely landed');
        assert.strictEqual(allocator.calls.release, 0, 'release must NOT be called -- the id is genuinely occupied');
    });

    test('a genuine create-dispatch failure (the create itself never lands) still releases the reservation', async () => {
        const parentId = 'parent-3';
        const calls = [];
        const command = async (cmd) => {
            calls.push(cmd);
            const b64 = extractStageBase64(cmd);
            if (b64 !== null) {
                const content = Buffer.from(b64, 'base64').toString('utf-8');
                const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'link-failure-create-fault-'));
                stagedTempDirs.push(dir);
                const filePath = path.join(dir, 'body.txt');
                await fs.writeFile(filePath, content, 'utf-8');
                return filePath;
            }
            if (/^bd show \S+ --json$/.test(cmd)) return '[]';
            if (/^bd create /.test(cmd)) {
                throw new Error('simulated bd create dispatch fault');
            }
            throw new Error(`unexpected command in create-fault test fake: ${cmd}`);
        };
        const allocator = makeSequentialAllocator(parentId);

        await assert.rejects(
            () => createChildBeadWithAllocatedId({
                command,
                allocator,
                member: 'local',
                title: 'Task whose create dispatch fails',
                description: 'The create itself faults before landing.',
                priority: 'P2',
                parentId,
            }),
            /simulated bd create dispatch fault/,
        );

        assert.strictEqual(allocator.calls.release, 1, 'release must be called -- the create never landed, no permanent id gap');
        assert.strictEqual(allocator.calls.confirm, 0, 'confirm must NOT be called -- nothing durably exists at this id');
    });

    test('a second create attempt after a link failure does not hit the id-already-exists refusal', async () => {
        const parentId = 'parent-4';
        let firstLinkAttempted = false;
        const { command, store } = makeStoreEmulatingCommand({
            linkShouldFail: () => {
                // Fail only the FIRST bd update --parent dispatch (the link
                // for the first child); the second create's link succeeds.
                if (!firstLinkAttempted) {
                    firstLinkAttempted = true;
                    return true;
                }
                return false;
            },
        });
        const allocator = makeSequentialAllocator(parentId);

        await assert.rejects(
            () => createChildBeadWithAllocatedId({
                command,
                allocator,
                member: 'local',
                title: 'First task, link will fail',
                description: 'First attempt, whose link dispatch fails.',
                priority: 'P2',
                parentId,
            }),
            /child bead 'parent-4\.1' was created but is UNLINKED/,
        );

        // The orphan bead genuinely exists at parent-4.1 (unlinked, but
        // present) -- exactly the state the old buggy release() path would
        // have handed back out as "free" on the next allocation.
        assert.ok(store.get(`${parentId}.1`), 'the orphaned first child must still exist in the store');

        // A second createChildBeadWithAllocatedId call under the SAME
        // allocator (mirroring a retried newTask) must land at a FRESH id,
        // not re-mint parent-4.1 and hit the id-already-exists refusal.
        const result = await createChildBeadWithAllocatedId({
            command,
            allocator,
            member: 'local',
            title: 'Second task, link succeeds',
            description: 'Second attempt, after the first orphaned the parent-4.1 id.',
            priority: 'P2',
            parentId,
        });

        assert.strictEqual(result.childId, `${parentId}.2`, 'the second attempt must mint a fresh id, not re-collide with the orphan');
        assert.strictEqual(allocator.calls.confirm, 2, 'both the orphan and the successful second create durably confirm');
        assert.strictEqual(allocator.calls.release, 0, 'no reservation is ever released across either attempt');
    });
});
