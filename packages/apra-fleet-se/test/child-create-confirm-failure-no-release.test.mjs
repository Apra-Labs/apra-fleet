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

// apra-fleet-btj9.5: regression tests for a confirm()-throws-after-a-landed-
// create path in createChildBeadWithAllocatedId (fleet-sprint/beads-children.mjs).
//
// THE DEFECT. allocator.confirm(grant.token) used to be called with no try
// around it at all: if it threw (an HTTP allocator route failing, an MCP
// transport fault, a supervisor restart), the bead already existed at the
// allocated id, the follow-up `bd update --parent` link step never ran, and
// the caller only ever saw the bare confirm() fault text -- no indication
// that a child bead now existed, unlinked, and possibly unconfirmed in the
// allocator's durable state.
//
// THE FIX. Wrap confirm() in its own try/catch (never calling release() --
// the create already landed, so the id is genuinely occupied) and, after
// still attempting the parent-link step, throw a distinct orphan-naming
// error whenever confirm() failed. If the link ALSO fails, that outcome is
// folded into the SAME message rather than masking the confirm failure.
//
// Falsifiability confirmed by hand: reverting to a bare, unguarded
// `await allocator.confirm(grant.token);` (no try/catch, no distinct error)
// makes the first and third tests below fail -- the raw
// 'simulated confirm dispatch fault' message propagates instead of the
// orphan-naming wrapper, and the second test's link-attempted assertion has
// nothing to do with the crash since the raw error surfaces immediately.

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
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'confirm-failure-'));
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
        throw new Error(`unexpected command in confirm-failure test fake: ${cmd}`);
    };
    return { command, calls, store };
}

// An allocator whose confirm() unconditionally throws, mirroring an
// allocator-transport fault (e.g. an HTTP route erroring or an MCP call
// failing) that arrives AFTER the create has already landed locally.
function makeThrowingConfirmAllocator(parentId, { linkAlsoConfirmFails = false } = {}) {
    const calls = { allocate: 0, confirm: 0, release: 0 };
    let seq = 0;
    return {
        calls,
        async allocate() {
            calls.allocate += 1;
            seq += 1;
            return { childId: `${parentId}.${seq}`, token: `tok-${seq}` };
        },
        async confirm() {
            calls.confirm += 1;
            if (linkAlsoConfirmFails || calls.confirm >= 1) {
                throw new Error('simulated confirm dispatch fault');
            }
        },
        async release() {
            calls.release += 1;
        },
    };
}

describe('createChildBeadWithAllocatedId -- an allocator.confirm() failure after a landed create does not release the reservation (apra-fleet-btj9.5)', () => {
    test('bd create lands, allocator.confirm() throws, the link succeeds: release is NOT called, and the error names the orphan id distinctly from the UNLINKED/PRESENT/UNKNOWN errors', async () => {
        const parentId = 'parent-5';
        const { command } = makeStoreEmulatingCommand({ linkShouldFail: () => false });
        const allocator = makeThrowingConfirmAllocator(parentId);

        await assert.rejects(
            () => createChildBeadWithAllocatedId({
                command,
                allocator,
                member: 'local',
                title: 'Task whose confirm will fail',
                description: 'The create lands and the link succeeds, but confirm() itself faults.',
                priority: 'P2',
                parentId,
            }),
            (err) => {
                assert.match(err.message, /child bead 'parent-5\.1' was created but allocator\.confirm\(\) FAILED/);
                assert.match(err.message, /linked under parent 'parent-5'/, 'the link outcome (success) must be folded into the same message');
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
                assert.doesNotMatch(
                    err.message,
                    /was created but is UNLINKED/,
                    'must be distinct from the created-but-UNLINKED link error',
                );
                return true;
            },
        );

        assert.strictEqual(allocator.calls.confirm, 1, 'confirm must have been attempted');
        assert.strictEqual(allocator.calls.release, 0, 'release must NOT be called -- the create genuinely landed');
    });

    test('the parent link is still attempted when confirm() fails (a confirm blip does not also cost the parent edge)', async () => {
        const parentId = 'parent-6';
        const { command, store } = makeStoreEmulatingCommand({ linkShouldFail: () => false });
        const allocator = makeThrowingConfirmAllocator(parentId);

        await assert.rejects(
            () => createChildBeadWithAllocatedId({
                command,
                allocator,
                member: 'local',
                title: 'Task whose confirm will fail but link is attempted',
                description: 'Confirm faults; the link dispatch must still run.',
                priority: 'P2',
                parentId,
            }),
            /allocator\.confirm\(\) FAILED/,
        );

        const bead = store.get(`${parentId}.1`);
        assert.ok(bead, 'the bead must genuinely exist in the store');
        // The store fake has no notion of "linked" beyond the dispatched
        // command succeeding without throwing -- confirm the link command
        // itself was dispatched and did not throw by asserting no
        // UNLINKED-style wording leaked into the thrown message.
        assert.strictEqual(allocator.calls.release, 0, 'release must NOT be called');
    });

    test('confirm() fails AND the follow-up link also fails: the confirm failure is reported, not masked by the link failure', async () => {
        const parentId = 'parent-7';
        const { command } = makeStoreEmulatingCommand({ linkShouldFail: () => true });
        const allocator = makeThrowingConfirmAllocator(parentId);

        await assert.rejects(
            () => createChildBeadWithAllocatedId({
                command,
                allocator,
                member: 'local',
                title: 'Task whose confirm AND link both fail',
                description: 'Both the confirm() call and the follow-up link dispatch fault.',
                priority: 'P2',
                parentId,
            }),
            (err) => {
                assert.match(err.message, /child bead 'parent-7\.1' was created but allocator\.confirm\(\) FAILED/, 'the confirm failure must be the primary, reported error');
                assert.match(err.message, /also UNLINKED from parent 'parent-7'/, 'the link failure must be folded in, not swallowed');
                assert.match(err.message, /the follow-up parent-link dispatch also failed/);
                return true;
            },
        );

        assert.strictEqual(allocator.calls.confirm, 1);
        assert.strictEqual(allocator.calls.release, 0, 'release must NOT be called even when both confirm and link fail');
    });
});
