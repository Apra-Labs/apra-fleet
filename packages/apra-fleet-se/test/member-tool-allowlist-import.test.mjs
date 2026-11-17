// Proves the shared member tool allowlist is importable from a plain Node .mjs
// test without a hardcoded copy: import the BUILT root module
// (dist/services/member-tool-allowlist.js, produced by the root `npm run build`).
// Same root-dist import pattern as fyc3-se-package-json-shipped.test.mjs.
// Role-prompt contract tests should import the allowlist from this exact path.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('member tool allowlist is importable from the built dist module', async () => {
    const mod = await import('../../../dist/services/member-tool-allowlist.js');
    assert.ok(Array.isArray(mod.MEMBER_ALLOWED_TOOLS), 'MEMBER_ALLOWED_TOOLS is not an array');
    assert.ok(mod.MEMBER_ALLOWED_TOOLS.includes('kb_query'));
    assert.ok(mod.MEMBER_ALLOWED_TOOLS.includes('version'));
    assert.ok(!mod.MEMBER_ALLOWED_TOOLS.includes('execute_prompt'));
    assert.ok(Array.isArray(mod.MEMBER_CHANNEL_TOOLS));
    assert.ok(mod.MEMBER_CHANNEL_TOOLS.includes('respond_to_message'));
    assert.equal(typeof mod.isMemberAllowedTool, 'function');
});
