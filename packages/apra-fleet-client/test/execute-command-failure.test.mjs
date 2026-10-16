// execute_command failure shape: a command that never produced an exit code
// (exec timeout, transport failure, cloud start failure) comes back with
// structuredContent.isError + reason and exitCode -1. commandFailureOf() is
// the client's typed read of it, and the ExecuteCommandStructured typedef
// must match the server's interface field-for-field. Reads source files only;
// writes nothing.

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ApraFleet, commandFailureOf } from '../src/client/api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const apiMjsSrc = readFileSync(path.join(__dirname, '..', 'src', 'client', 'api.mjs'), 'utf8');
const executeCommandSrc = readFileSync(path.join(repoRoot, 'src', 'tools', 'execute-command.ts'), 'utf8');

function typedefBlock(name) {
    const start = apiMjsSrc.indexOf(`@typedef {Object} ${name}`);
    assert.notStrictEqual(start, -1, `typedef not found: ${name}`);
    return apiMjsSrc.slice(start, apiMjsSrc.indexOf('*/', start));
}

function typedefProps(name) {
    const props = new Set();
    for (const m of typedefBlock(name).matchAll(/@property \{[^}]*\} \[?([a-zA-Z_][a-zA-Z0-9_]*)/g)) props.add(m[1]);
    return props;
}

function serverInterfaceFields() {
    const start = executeCommandSrc.indexOf('export interface ExecuteCommandStructured {');
    assert.notStrictEqual(start, -1, 'ExecuteCommandStructured interface not found in execute-command.ts');
    const block = executeCommandSrc.slice(start, executeCommandSrc.indexOf('\n}', start));
    const fields = new Set();
    for (const m of block.matchAll(/^ {2}([a-zA-Z_][a-zA-Z0-9_]*)\??:/gm)) fields.add(m[1]);
    return fields;
}

const timeoutResult = {
    content: [{ type: 'text', text: 'Failed to execute command on "m1": Command timed out after 600000ms of inactivity' }],
    structuredContent: { isError: true, reason: 'timeout', exitCode: -1, stdout: '', stderr: 'Command timed out after 600000ms of inactivity' },
};

describe('commandFailureOf', () => {
    test('a timed-out command is a failure with reason timeout', () => {
        const f = commandFailureOf(timeoutResult);
        assert.deepStrictEqual(f, { reason: 'timeout', message: timeoutResult.content[0].text });
    });

    test('a transport failure is a failure with reason transport_error', () => {
        const f = commandFailureOf({
            content: [{ type: 'text', text: 'Failed to execute command on "m1": connect ECONNREFUSED' }],
            structuredContent: { isError: true, reason: 'transport_error', exitCode: -1, stdout: '', stderr: 'connect ECONNREFUSED' },
        });
        assert.strictEqual(f.reason, 'transport_error');
        assert.match(f.message, /ECONNREFUSED/);
    });

    test('the bare failure text of an older server (no structuredContent) is still a failure', () => {
        for (const text of [
            'Failed to execute command on "m1": Command timed out after 600000ms of inactivity',
            'Failed to launch task on "m1": socket hang up',
        ]) {
            const f = commandFailureOf({ content: [{ type: 'text', text }] });
            assert.deepStrictEqual(f, { reason: 'unflagged_failure', message: text });
        }
    });

    test('an MCP-level isError result is a failure', () => {
        const f = commandFailureOf({ isError: true, content: [{ type: 'text', text: 'boom' }] });
        assert.deepStrictEqual(f, { reason: 'unknown', message: 'boom' });
    });

    test('a command that ran is not a failure, whatever its exit code', () => {
        assert.strictEqual(commandFailureOf({ content: [{ type: 'text', text: 'Exit code: 0\nok' }], structuredContent: { exitCode: 0, stdout: 'ok', stderr: '' } }), null);
        assert.strictEqual(commandFailureOf({ content: [{ type: 'text', text: 'Exit code: 2\nno' }], structuredContent: { exitCode: 2, stdout: '', stderr: 'no' } }), null);
        // structuredContent present: the text sniff never applies, even to output that happens to start with the failure wording.
        assert.strictEqual(commandFailureOf({ content: [{ type: 'text', text: 'Failed to execute command on "x": printed by the command' }], structuredContent: { exitCode: 0, stdout: '', stderr: '' } }), null);
        assert.strictEqual(commandFailureOf(null), null);
        assert.strictEqual(commandFailureOf(undefined), null);
    });

    test('executeCommand returns the server result unchanged, so commandFailureOf can read it', async () => {
        const fleet = new ApraFleet({ async callTool() { return timeoutResult; } });
        const result = await fleet.executeCommand({ member_name: 'm1', command: 'bd dolt push', timeout_s: 600 });
        assert.strictEqual(result, timeoutResult);
        assert.strictEqual(commandFailureOf(result).reason, 'timeout');
    });
});

describe('ExecuteCommandStructured typedef vs server interface', () => {
    test('fields match field-for-field', () => {
        const server = serverInterfaceFields();
        const client = typedefProps('ExecuteCommandStructured');
        assert.ok(server.has('isError') && server.has('reason'), 'sanity: server interface declares isError and reason');
        assert.deepStrictEqual([...client].sort(), [...server].sort());
    });

    test('every failure reason the server can emit is documented on the typedef', () => {
        const m = /export type ExecuteCommandFailureReason = ([^;]+);/.exec(executeCommandSrc);
        assert.ok(m, 'ExecuteCommandFailureReason not found in execute-command.ts');
        const reasons = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
        reasons.push('cloud_start_failed');
        for (const r of /reason: preflightReason/.test(executeCommandSrc) ? ['preflight_offline', 'preflight_auth_expired', 'preflight_auth_missing'] : []) reasons.push(r);
        assert.ok(reasons.includes('timeout'), 'sanity: timeout is a server reason');
        const block = typedefBlock('ExecuteCommandStructured');
        for (const r of reasons) assert.ok(block.includes(`'${r}'`), `typedef does not document reason '${r}'`);
    });
});
