import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
    initScenarioClone,
    createBeadOrThrow,
    describeBdResult,
    setup,
    setupMinimal,
} from './helpers/mock-sprint-harness.mjs';

// =============================================================================
// apra-fleet-38o8.2 -- regression guard for apra-fleet-38o8.1's fix.
//
// apra-fleet-38o8.1 diagnosed the recurring real-bd-lane failure
// "setupMinimal(<scenario>): bd create --silent did not return an epic id" as
// the DOWNSTREAM symptom of a preceding `bd init` FAILURE that both setup()
// and setupMinimal() used to issue and then silently discard (see
// mock-sprint-harness.mjs's own header comment above initScenarioClone(),
// lines ~348-385). The fix: check `bd init`'s exit status and throw AT that
// failure, with its own evidence, instead of limping on to a `bd create`
// that cannot succeed and reporting a bare, cause-less "did not return an
// epic id" message.
//
// This suite drives the three shared helpers (initScenarioClone,
// createBeadOrThrow, and setup()/setupMinimal() themselves) with an INJECTED
// runCmdFn (the apra-fleet-38o8.2 seam added to all four functions), so every
// case below is deterministic and requires no contended real-bd run to
// exercise the failure path.
// =============================================================================

/** Every apra-fleet-mock-sprint-<suffix>-* tempDir setup()/setupMinimal() may
 * have created on disk before throwing (they always fs.mkdir(tempDir) first,
 * unconditionally of the injected runCmdFn) -- swept up after each test so
 * this guard's own suite leaves nothing behind (acceptance criterion 6). */
async function cleanupTempDirs(suffix) {
    const tmp = os.tmpdir();
    const prefix = `apra-fleet-mock-sprint-${suffix}-`;
    let entries;
    try {
        entries = await fs.readdir(tmp);
    } catch {
        return;
    }
    await Promise.all(
        entries
            .filter((name) => name.startsWith(prefix))
            .map((name) => fs.rm(path.join(tmp, name), { recursive: true, force: true })),
    );
}

// A real bd init failure, captured verbatim in shape by apra-fleet-38o8.1's
// own diagnosis: exit=1, empty stdout, an "already initialized" stderr.
const FAILED_INIT_RESULT = {
    err: Object.assign(new Error('Command failed: bd init'), { code: 1 }),
    stdout: '',
    stderr: 'Error:\n  Found existing Dolt database: <dir>/.beads/embeddeddolt/<db>\n\n' +
        'This workspace is already initialized. Aborting.',
};

// A real bd create failure downstream of a missing database -- what a
// genuinely failed create looks like once init is confirmed to have
// succeeded (never a masked pass).
const FAILED_CREATE_RESULT = {
    err: Object.assign(new Error('Command failed: bd create'), { code: 1 }),
    stdout: '',
    stderr: "Error: no beads database found\nHint: run 'bd where' ... or 'bd init' to create a new database",
};

const OK_INIT_RESULT = { err: null, stdout: '', stderr: '' };

describe('initScenarioClone(): unit behaviour', () => {
    test('a failed bd init throws its OWN rich diagnosis naming bd init as the cause, not a downstream create-side message', async () => {
        const fakeRunCmd = async (cmd) => {
            assert.equal(cmd, 'bd init', 'initScenarioClone must issue exactly "bd init"');
            return FAILED_INIT_RESULT;
        };
        await assert.rejects(
            () => initScenarioClone('setupMinimal(guardtest)', '/fake/tmp/dir', fakeRunCmd),
            (err) => {
                assert.match(err.message, /'bd init' FAILED/, 'expected the init-failure diagnosis, not a generic message');
                assert.match(err.message, /no beads database/, 'expected the diagnosis to explain the downstream symptom it prevents');
                assert.doesNotMatch(err.message, /did not return a bead id/, 'the init-failure path must never mention the create-side symptom text');
                return true;
            },
        );
    });

    test('a successful bd init returns the init result unchanged, for later diagnostics to quote', async () => {
        const fakeRunCmd = async () => OK_INIT_RESULT;
        const result = await initScenarioClone('setupMinimal(guardtest)', '/fake/tmp/dir', fakeRunCmd);
        assert.deepStrictEqual(result, OK_INIT_RESULT);
    });

    test('bd init throwing before producing a result (e.g. a vanished template) is labelled with the scenario and tempDir, not left as an opaque error', async () => {
        const fakeRunCmd = async () => {
            throw new Error('ENOENT: no such file or directory');
        };
        await assert.rejects(
            () => initScenarioClone('setupMinimal(guardtest)', '/fake/tmp/dir', fakeRunCmd),
            (err) => {
                assert.match(err.message, /'bd init' threw before producing a result/);
                assert.match(err.message, /\/fake\/tmp\/dir/);
                return true;
            },
        );
    });
});

describe('createBeadOrThrow(): unit behaviour', () => {
    test('a well-formed single-token id (with trailing newline, as bd --silent actually emits) is returned trimmed', async () => {
        const fakeRunCmd = async () => ({ err: null, stdout: 'apra-fleet-abcd\n', stderr: '' });
        const id = await createBeadOrThrow('label', '/fake/tmp/dir', 'bd create ... --silent', OK_INIT_RESULT, fakeRunCmd);
        assert.equal(id, 'apra-fleet-abcd');
    });

    test('a genuinely failed create (init already confirmed OK) still throws -- the fix must not convert a real failure into a pass', async () => {
        const fakeRunCmd = async () => FAILED_CREATE_RESULT;
        await assert.rejects(
            () => createBeadOrThrow('label', '/fake/tmp/dir', 'bd create -t epic ... --silent', OK_INIT_RESULT, fakeRunCmd),
            (err) => {
                assert.match(err.message, /did not return a bead id/);
                // Full evidence chain: both the (already-successful) init result
                // and this create's own exit/stdout/stderr must be present, so
                // criterion 4 of the impl sibling (no loss of diagnostic
                // richness) is pinned here too.
                assert.match(err.message, new RegExp(describeBdResult('bd init', OK_INIT_RESULT).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
                assert.match(err.message, new RegExp(describeBdResult('bd create', FAILED_CREATE_RESULT).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
                return true;
            },
        );
    });

    test('empty stdout (the originally reported symptom) is rejected, not treated as a zero-length id', async () => {
        const fakeRunCmd = async () => ({ err: null, stdout: '', stderr: '' });
        await assert.rejects(
            () => createBeadOrThrow('label', '/fake/tmp/dir', 'bd create ... --silent', OK_INIT_RESULT, fakeRunCmd),
            /did not return a bead id/,
        );
    });

    test('multi-token stdout (bd prose where an id belongs) is rejected, not fed downstream as if it were an id', async () => {
        const fakeRunCmd = async () => ({ err: null, stdout: 'Warning: something happened\n', stderr: '' });
        await assert.rejects(
            () => createBeadOrThrow('label', '/fake/tmp/dir', 'bd create ... --silent', OK_INIT_RESULT, fakeRunCmd),
            /did not return a bead id/,
        );
    });
});

// apra-fleet-38o8.2 acceptance criterion 4: setup() and setupMinimal() are
// both covered end to end, through the exact same shared helpers, not just
// the helpers in isolation above.
describe('setup() / setupMinimal(): end-to-end coverage of the shared fix', () => {
    test('setupMinimal(): a failing bd init is caught before any bd create is attempted, and the thrown message names bd init as the cause', async () => {
        const seenCmds = [];
        const fakeRunCmd = async (cmd) => {
            seenCmds.push(cmd);
            if (cmd === 'bd init') return FAILED_INIT_RESULT;
            // Reached only if the fix regresses; would previously report the
            // bare, cause-less "did not return an epic id" symptom.
            return { err: null, stdout: '', stderr: '' };
        };
        try {
            await assert.rejects(
                () => setupMinimal('38o8g-initfail', [{ title: 'Task: guard scenario work' }], fakeRunCmd),
                (err) => {
                    assert.match(err.message, /'bd init' FAILED/);
                    assert.doesNotMatch(err.message, /did not return a bead id/);
                    return true;
                },
            );
            assert.deepStrictEqual(seenCmds, ['bd init'], 'setupMinimal must stop at the failed bd init and never attempt a create');
        } finally {
            await cleanupTempDirs('38o8g-initfail');
        }
    });

    test('setup(): a failing bd init is caught before any bd create is attempted, and the thrown message names bd init as the cause', async () => {
        const seenCmds = [];
        const fakeRunCmd = async (cmd) => {
            seenCmds.push(cmd);
            if (cmd === 'bd init') return FAILED_INIT_RESULT;
            return { err: null, stdout: '', stderr: '' };
        };
        try {
            await assert.rejects(
                () => setup('38o8g-initfail-full', fakeRunCmd),
                (err) => {
                    assert.match(err.message, /'bd init' FAILED/);
                    assert.doesNotMatch(err.message, /did not return a bead id/);
                    return true;
                },
            );
            assert.deepStrictEqual(seenCmds, ['bd init'], 'setup must stop at the failed bd init and never attempt a create');
        } finally {
            await cleanupTempDirs('38o8g-initfail-full');
        }
    });

    test('setupMinimal(): init succeeds but the epic create genuinely fails -- still throws, does not silently proceed', async () => {
        const fakeRunCmd = async (cmd) => {
            if (cmd === 'bd init') return OK_INIT_RESULT;
            if (/^bd create -t epic/.test(cmd)) return FAILED_CREATE_RESULT;
            throw new Error(`unexpected command reached after a create failure: ${JSON.stringify(cmd)}`);
        };
        try {
            await assert.rejects(
                () => setupMinimal('38o8g-createfail', [{ title: 'Task: guard scenario work' }], fakeRunCmd),
                /did not return a bead id/,
            );
        } finally {
            await cleanupTempDirs('38o8g-createfail');
        }
    });

    test('setup(): the full happy path (init + 3 creates + 2 parent links + list) still succeeds end to end through the shared helpers', async () => {
        const ids = { epic: 'apra-fleet-epic1', t1: 'apra-fleet-task1', t2: 'apra-fleet-task2' };
        const fakeRunCmd = async (cmd) => {
            if (cmd === 'bd init') return OK_INIT_RESULT;
            if (/^bd create -t epic/.test(cmd)) return { err: null, stdout: `${ids.epic}\n`, stderr: '' };
            if (/^bd create "Task: Implement registerMember/.test(cmd)) return { err: null, stdout: `${ids.t1}\n`, stderr: '' };
            if (/^bd create "Task: Implement listMembers/.test(cmd)) return { err: null, stdout: `${ids.t2}\n`, stderr: '' };
            if (cmd.startsWith('bd update ')) return { err: null, stdout: '', stderr: '' };
            if (cmd === 'bd list --json') {
                return {
                    err: null,
                    stdout: JSON.stringify([{ id: ids.epic }, { id: ids.t1 }, { id: ids.t2 }]),
                    stderr: '',
                };
            }
            throw new Error(`unexpected command: ${JSON.stringify(cmd)}`);
        };
        let result;
        try {
            result = await setup('38o8g-happy', fakeRunCmd);
            assert.equal(result.epicBead.id, ids.epic);
            assert.equal(result.task1.id, ids.t1);
            assert.equal(result.task2.id, ids.t2);
        } finally {
            await cleanupTempDirs('38o8g-happy');
        }
    });
});

// Falsifiability (acceptance criterion 3): this whole suite depends on
// apra-fleet-38o8.1's fix actually being in place. Documented here (not
// re-executed on every run, since it requires mutating source under test).
//
// The non-vacuous half of each "bd init is caught before any bd create is
// attempted" test is `assert.match(err.message, /'bd init' FAILED/)`: this
// is the assertion that must fail under ANY revert of the fix, because only
// the fixed initScenarioClone() ever produces that text. The paired
// `assert.doesNotMatch(err.message, /did not return a bead id/)` is NOT
// independently load-bearing here -- it is reached only if assert.match
// already passed, so a revert that makes assert.match fail short-circuits
// before doesNotMatch runs at all (per node:assert's callback-form
// assert.rejects, the callback throws on its first failing assertion and
// stops). doesNotMatch would only add coverage against a revert that kept
// the "'bd init' FAILED" wording but reintroduced the old symptom text
// alongside it, which is not what either revert below does.
//
// Verified this pass, restored afterward (this file is otherwise unchanged
// by either falsification):
//
// 1) Logic-only revert -- comment out just initScenarioClone()'s
//    `if (initRes.err) { throw ... }` block, keeping the runCmdFn seam so
//    the module still imports. setupMinimal()/setup() then proceed past the
//    failed 'bd init' straight into the epic create, whose injected
//    response in these tests is a synthetic success
//    ({err:null, stdout:'', stderr:''}); createBeadOrThrow()'s own
//    empty-stdout check then throws its OWN message, which reads (observed
//    verbatim): `[advanced-mock-runner-test] setupMinimal(38o8g-initfail):
//    "bd create -t epic ... --silent" did not return a bead id (parsed "").
//    ...`. assert.match(/'bd init' FAILED/) fails as expected
//    ("AssertionError [ERR_ASSERTION]: The input did not match the regular
//    expression /'bd init' FAILED/"); doesNotMatch is never reached.
//
// 2) Full revert (git checkout of a pre-38o8.1 mock-sprint-harness.mjs) does
//    NOT exercise either assertion at all: that file predates the
//    createBeadOrThrow/initScenarioClone exports this test file imports, so
//    the whole suite fails at import time
//    (SyntaxError: no export named 'createBeadOrThrow'), not inside these
//    two tests. It is not usable evidence for this guard's non-vacuousness.
