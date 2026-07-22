import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
    validateNewTask,
    createChildBeadWithAllocatedId,
    appendRejectedFindingToParentNotes,
    persistNewTaskBestEffort,
} from '../auto-sprint/runner.js';

// apra-fleet-eft.73.2: verifies the eft.73.1 fix -- newTask/notes body content
// reaches `bd` via a MEMBER-LOCAL staged file (stageCommandBodyMemberSide in
// runner.js), never an orchestrator-host os.tmpdir() path, and that the
// injection-safety + best-effort degradation properties from eft.56.1/56.2
// survive the transport change. This file complements (does not replace)
// newtask-body-file-roundtrip.test.mjs, which already pins the base64-carry /
// literal round-trip behavior in detail.
//
// Four things asserted here, matching the eft.73.2 acceptance criteria:
//   1. No orchestrator-host os.tmpdir() path ever appears in a dispatched
//      command string; the ONLY path that appears is the one the member-side
//      staging dispatch itself returns.
//   2. (regression) the existing newtask-body-file-roundtrip suite still
//      passes -- not re-asserted in this file; see that suite directly.
//   3. persistNewTaskBestEffort's full degradation ladder -- bd create fails,
//      then the notes attempt ALSO fails, so the run-log verbatim line is
//      the last resort that fires.
//   4. A command() fake standing in for a REMOTE member (fully decoupled from
//      this process's own os.tmpdir()) can still complete a newTask
//      end-to-end, proving the mechanism carries no shared-filesystem
//      assumption between the orchestrator host and the member.

// Matches the staging command runner.js constructs: node -e "<script>" "<base64>"
function extractStageBase64(cmd) {
    if (!/^node -e "/.test(cmd)) return null;
    const m = cmd.match(/"([A-Za-z0-9+/=]*)"\s*$/);
    return m ? m[1] : null;
}

function extractQuotedFlagValue(cmd, flag) {
    const re = new RegExp(`${flag}\\s+"([^"]*)"`);
    const m = cmd.match(re);
    return m ? m[1] : null;
}

const NOOP_ALLOCATOR = {
    async allocate() { return { childId: null, token: null }; },
    async confirm() { return true; },
    async release() { return true; },
};

// A command() fake that plays the role of a REMOTE member: it has its OWN
// temp directory namespace (prefixed distinctly from this process's own
// os.tmpdir() usage elsewhere) so assertions can prove no path from THIS
// process's default tmp namespace leaks into a dispatched command string.
function makeRemoteMemberEmulatingCommand() {
    const calls = [];
    const stagedPaths = [];
    const command = async (cmd, opts) => {
        calls.push({ cmd, opts });
        const b64 = extractStageBase64(cmd);
        if (b64 !== null) {
            const content = Buffer.from(b64, 'base64').toString('utf-8');
            const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-member-emulated-'));
            const filePath = path.join(dir, 'body.txt');
            await fs.writeFile(filePath, content, 'utf-8');
            stagedPaths.push(filePath);
            return filePath;
        }
        return '';
    };
    const readBodyOf = async (cmd) => {
        const p = extractQuotedFlagValue(cmd, '--body-file') ?? extractQuotedFlagValue(cmd, '--file');
        return p ? fs.readFile(p, 'utf-8') : null;
    };
    return { command, calls, stagedPaths, readBodyOf };
}

describe('apra-fleet-eft.73.2 -- newTask/notes body reaches member-side without an orchestrator-host path', () => {
    test('assertion 1: no orchestrator-host os.tmpdir() path appears in any dispatched command string', async () => {
        // A host-local temp path this test process itself might have used
        // under the OLD (eft.56.1) writeCommandBodyTempFile() scheme -- if the
        // fix regressed, this exact orchestrator-host path would show up
        // verbatim in the `bd create --body-file` command string.
        const hostLocalPath = path.join(os.tmpdir(), `auto-sprint-body-orchestrator-host-${process.pid}.txt`);
        // Prove the path is real on THIS (orchestrator-host) process so the
        // assertion below is meaningful, not vacuous.
        await fs.writeFile(hostLocalPath, 'host-local sentinel, must never be referenced by bd', 'utf-8');

        const { command, calls, stagedPaths } = makeRemoteMemberEmulatingCommand();
        await createChildBeadWithAllocatedId({
            command,
            allocator: NOOP_ALLOCATOR,
            member: 'remote-member-1',
            title: 'Exercise host-path absence',
            description: 'Body content unrelated to any host tmp path.',
            priority: 'P2',
            parentId: 'parent-1',
        });

        assert.strictEqual(calls.length, 2, 'expected a member-side staging dispatch then a bd create dispatch');
        for (const { cmd } of calls) {
            // Note: the emulated member-side staging dispatch itself legitimately
            // resolves ITS staged path under this same process's os.tmpdir()
            // (the test fake runs in-process -- see makeRemoteMemberEmulatingCommand)
            // -- that is not a regression, since in production that path would be
            // resolved on the (possibly different) member host, not the
            // orchestrator's. What must NEVER appear is the DISTINCT
            // orchestrator-host sentinel path below, which no staging dispatch
            // ever produced -- i.e. the mechanism never silently falls back to
            // referencing a path this function wrote itself, host-side.
            assert.ok(!cmd.includes(hostLocalPath), `command must never reference the orchestrator-host sentinel path: ${cmd}`);
        }
        // The bd create command's --body-file value MUST be exactly the path
        // the (emulated) member-side staging dispatch returned -- i.e. it is
        // reachable because it was staged where bd will actually run, not
        // because the mechanism silently fell back to a host-local path.
        const createCmd = calls[1].cmd;
        assert.strictEqual(extractQuotedFlagValue(createCmd, '--body-file'), stagedPaths[0]);

        await fs.unlink(hostLocalPath).catch(() => {});
    });

    test('assertion 3: persistNewTaskBestEffort degrades bd create FAILURE -> notes FAILURE -> run-log verbatim', async () => {
        const newTask = {
            title: 'Everything fails downstream',
            description: 'Description content that must survive to the run log verbatim.',
            priority: 'P1',
        };
        const logLines = [];
        const log = (msg) => logLines.push(msg);

        // command() used only by the internal appendRejectedFindingToParentNotes
        // fallback path -- make its `bd note` dispatch fail too, so the ladder
        // bottoms out at the run-log-verbatim rung.
        const command = async (cmd) => {
            const b64 = extractStageBase64(cmd);
            if (b64 !== null) {
                const content = Buffer.from(b64, 'base64').toString('utf-8');
                const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'degradation-'));
                const filePath = path.join(dir, 'body.txt');
                await fs.writeFile(filePath, content, 'utf-8');
                return filePath;
            }
            if (/^bd note /.test(cmd)) {
                throw new Error('simulated: bd note also unreachable');
            }
            return '';
        };

        const ok = await persistNewTaskBestEffort({
            createFn: async () => {
                throw new Error('simulated: bd create failed');
            },
            command,
            member: 'remote-member-1',
            parentId: 'parent-1',
            newTask,
            cycle: 7,
            log,
            stage: 'develop-review',
        });

        assert.strictEqual(ok, false, 'persistNewTaskBestEffort must report failure once every rung has failed');
        assert.ok(
            logLines.some((l) => l.includes('newTask bd create FAILED') && l.includes('simulated: bd create failed')),
            `expected the bd-create-failure rung to be logged, got: ${JSON.stringify(logLines)}`
        );
        const verbatimLine = logLines.find((l) => l.includes('newTask persistence FAILED at every level'));
        assert.ok(verbatimLine, `expected the final run-log-verbatim rung to fire, got: ${JSON.stringify(logLines)}`);
        assert.ok(verbatimLine.includes(newTask.title), 'run-log verbatim line must include the original title');
        assert.ok(verbatimLine.includes(newTask.description), 'run-log verbatim line must include the original description verbatim');
        assert.ok(verbatimLine.includes('simulated: bd note also unreachable'), 'run-log verbatim line must include the last error from the notes rung');
    });

    test('assertion 4: end-to-end newTask via a remote-member command() fake, no shared-filesystem assumption', async () => {
        // This fake's staging half writes to ITS OWN temp namespace, entirely
        // decoupled from anything this test file (or runner.js) might resolve
        // via a shared/orchestrator-relative path -- standing in for a member
        // process on a different machine from the orchestrator.
        const { command, calls, readBodyOf } = makeRemoteMemberEmulatingCommand();
        const description = 'End-to-end remote-member delivery, no shared fs assumption.';

        const result = await createChildBeadWithAllocatedId({
            command,
            allocator: NOOP_ALLOCATOR,
            member: 'remote-member-1',
            title: 'Remote member end-to-end',
            description,
            priority: 'P2',
            parentId: 'parent-1',
        });

        assert.strictEqual(result.childId, null);
        assert.strictEqual(calls.length, 2);
        // Both dispatches must have been routed to the remote member, not
        // executed as if local to the orchestrator.
        for (const { opts } of calls) {
            assert.strictEqual(opts.member_name, 'remote-member-1', 'every dispatch must target the remote member, proving no local/host execution shortcut is taken');
        }
        const createCmd = calls[1].cmd;
        assert.strictEqual(await readBodyOf(createCmd), description, 'the remote-member-staged body must round-trip verbatim to the bd create dispatch');

        // Also cover the notes fallback path end-to-end against the same
        // remote-member fake, for a newTask that fails residual validation.
        const rejected = { title: 'Run `whoami`', description: 'looks fine', priority: 'P1' };
        const validation = validateNewTask(rejected);
        assert.strictEqual(validation.ok, false);

        const logLines = [];
        await appendRejectedFindingToParentNotes({
            command,
            member: 'remote-member-1',
            parentId: 'parent-2',
            newTask: rejected,
            reason: validation.reason,
            cycle: 1,
            log: (m) => logLines.push(m),
        });
        assert.strictEqual(calls.length, 4, 'expected one more staging + one more bd note dispatch');
        for (const { opts } of calls.slice(2)) {
            assert.strictEqual(opts.member_name, 'remote-member-1');
        }
        assert.ok(logLines.some((l) => l.includes("Rejected newTask finding appended verbatim to 'parent-2' notes")));
    });
});
