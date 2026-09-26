// execute_prompt's 'permission_denied' result as seen through the client:
// permissionDenialOf() returns the typed PermissionDenied block, and the
// client's typedefs are pinned against the server's PermissionDenial /
// ExecutePromptStructured declarations (read from the real sources).
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { ApraFleet, permissionDenialOf } from '../src/client/api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const apiSrc = readFileSync(path.join(__dirname, '..', 'src', 'client', 'api.mjs'), 'utf8');
const providerSrc = readFileSync(path.join(repoRoot, 'src', 'providers', 'provider.ts'), 'utf8');
const executePromptSrc = readFileSync(path.join(repoRoot, 'src', 'tools', 'execute-prompt.ts'), 'utf8');

// Shape execute_prompt returns for the recorded agy denial (tests/agy-permission-denial.test.ts).
const recorded = {
    content: [{ type: 'text', text: '[FAIL] execute_prompt on "agy-denied": permission denied -- ...' }],
    structuredContent: {
        isError: true,
        reason: 'permission_denied',
        permissionDenied: {
            actions: ['command'],
            denials: [{ action: 'command', target: 'git status --short --branch' }],
            suggestedGrants: ['Bash(git status --short --branch)'],
            hint: 'agy auto-denied command "git status --short --branch" (headless mode cannot prompt for permission).',
            signals: ['result_json', 'stderr', 'transcript'],
        },
        sessionId: '48ae7611-290b-4396-90c6-c266d09c9473',
        usage: { input_tokens: 17220, output_tokens: 68, total_tokens: 17288 },
    },
};

function typedefProps(name) {
    const start = apiSrc.indexOf(`@typedef {Object} ${name}`);
    assert.notStrictEqual(start, -1, `typedef ${name} missing`);
    const block = apiSrc.slice(start, apiSrc.indexOf('*/', start));
    return [...block.matchAll(/@property \{[^}]*\}+ \[?([A-Za-z_]+)\]?/g)].map((m) => m[1]).sort();
}

function interfaceProps(src, name) {
    const start = src.indexOf(`export interface ${name} {`);
    assert.notStrictEqual(start, -1, `interface ${name} missing`);
    const body = src.slice(start, src.indexOf('\n}', start));
    return [...body.matchAll(/^ {2}([A-Za-z_]+)\??:/gm)].map((m) => m[1]).sort();
}

describe('permission_denied', () => {
    test('executePrompt passes the structured denial through and permissionDenialOf types it', async () => {
        const fleet = new ApraFleet({ async callTool() { return recorded; } });
        const result = await fleet.executePrompt({ prompt: 'run git status', member_name: 'agy-denied', resume: false });
        assert.strictEqual(result.structuredContent.reason, 'permission_denied');
        const d = permissionDenialOf(result);
        assert.deepStrictEqual(d, recorded.structuredContent.permissionDenied);
        assert.deepStrictEqual(permissionDenialOf(result.structuredContent), d);
        assert.strictEqual(typeof d.hint, 'string');
        assert.ok(Array.isArray(d.suggestedGrants));
    });

    test('returns null for other outcomes and malformed blocks', () => {
        assert.strictEqual(permissionDenialOf({ structuredContent: { isError: true, reason: 'empty_response' } }), null);
        assert.strictEqual(permissionDenialOf({ structuredContent: { response: 'ok' } }), null);
        assert.strictEqual(permissionDenialOf(null), null);
        assert.strictEqual(permissionDenialOf({ structuredContent: { reason: 'permission_denied', permissionDenied: { actions: 'command' } } }), null);
        assert.strictEqual(permissionDenialOf({ structuredContent: { reason: 'permission_denied', permissionDenied: { actions: [], denials: [{}], suggestedGrants: [], hint: '' } } }), null);
    });

    test('client typedefs match the server declarations', () => {
        assert.deepStrictEqual(typedefProps('PermissionDenied'), interfaceProps(providerSrc, 'PermissionDenial'));
        assert.deepStrictEqual(typedefProps('PermissionDenialItem'), interfaceProps(providerSrc, 'PermissionDenialItem'));
        assert.match(executePromptSrc, /'permission_denied'/);
        assert.match(executePromptSrc, /permissionDenied\?: PermissionDenial;/);
        assert.match(apiSrc, /'permission_denied'/);
        assert.match(apiSrc, /@property \{PermissionDenied\} \[permissionDenied\]/);
    });
});
