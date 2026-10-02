import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ApraFleet, KB_REMOVED_SCOPE_KEYS, assertNoRemovedKbScopeKeys } from '../src/client/api.mjs';

const serverSrc = readFileSync(fileURLToPath(new URL('../../../src/services/knowledge/kb-removed-scope-keys.ts', import.meta.url)), 'utf8');

// The server refuses the pre-redesign kb_* scope keys with E-SCOPE-KEY-REMOVED
// (src/services/knowledge/kb-removed-scope-keys.ts); the client's kb_*
// wrappers refuse them before sending, with the same code.

function recordingFleet() {
    const calls = [];
    const fleet = new ApraFleet({ async callTool(name, args) { calls.push({ name, args }); return { content: [] }; } });
    return { fleet, calls };
}

describe('kb_* wrappers refuse the removed scope keys', () => {
    test('the removed key set matches the server module', () => {
        const union = serverSrc.match(/export type KbRemovedScopeKey = ([^;]+);/);
        assert.ok(union, 'server KbRemovedScopeKey union not found');
        const serverKeys = [...union[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
        assert.deepEqual([...KB_REMOVED_SCOPE_KEYS].sort(), serverKeys.sort());
    });

    for (const [method, tool, base] of [
        ['kbExport', 'kb_export', {}],
        ['kbBibleCommit', 'kb_bible_commit', { ids: ['a'], baseBranch: 'main', baseCommit: 'abc' }],
    ]) {
        for (const key of KB_REMOVED_SCOPE_KEYS) {
            test(`${method} with ${key} throws E-SCOPE-KEY-REMOVED and sends nothing`, async () => {
                const { fleet, calls } = recordingFleet();
                await assert.rejects(fleet[method]({ ...base, [key]: '/elsewhere' }), (err) => {
                    assert.equal(err.code, 'E-SCOPE-KEY-REMOVED');
                    assert.match(err.message, new RegExp(`^E-SCOPE-KEY-REMOVED: ${tool} no longer accepts '${key}'`));
                    return true;
                });
                assert.deepEqual(calls, []);
            });
        }

        test(`${method} without a removed key forwards the options unchanged`, async () => {
            const { fleet, calls } = recordingFleet();
            await fleet[method]({ ...base });
            assert.deepEqual(calls, [{ name: tool, args: { ...base } }]);
        });
    }

    test('an explicitly undefined key is treated as absent', () => {
        assert.doesNotThrow(() => assertNoRemovedKbScopeKeys('kb_export', { repo_path: undefined }));
    });
});
