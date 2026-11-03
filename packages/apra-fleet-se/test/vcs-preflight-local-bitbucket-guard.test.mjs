import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { createVcsAuthPreflightCallback } from '../fleet-sprint/runner.js';

// The preflight caches a no-probe plan when its first member_detail answer is
// non-JSON (a tool-level error comes back as text, it does not throw). Once
// member_detail answers again with a LOCAL Bitbucket record, the provisioning
// path must still refuse it: provisioning would overwrite the host's own git
// credential helper.

const bbCommand = async (cmd) => {
    if (cmd === 'git remote get-url origin') {
        return { ok: true, output: 'https://bitbucket.org/acme/widgets.git', error: null };
    }
    return { ok: true, output: '', error: null };
};

function makeCallTool(records) {
    const state = { detailCalls: 0, provisioned: [] };
    const callTool = async (name, args) => {
        if (name === 'member_detail') {
            state.detailCalls += 1;
            // First answer: a tool-level error as plain text; later: the record.
            if (state.detailCalls === 1) return { content: [{ text: 'Error: fleet server busy, try again' }] };
            return { content: [{ text: JSON.stringify(records[args.member_name]) }] };
        }
        if (name === 'credential_store_list') return { content: [{ text: JSON.stringify([{ name: 'bitbucket_api_token' }]) }] };
        if (name === 'provision_vcs_auth') {
            state.provisioned.push(args.member_name);
            return { content: [{ text: 'Provisioned.' }], structuredContent: { ok: true, reason: 'ok', expiresAt: null } };
        }
        return { content: [{ text: '' }] };
    };
    return { callTool, state };
}

describe('createVcsAuthPreflightCallback: local non-re-mintable member after a non-JSON member_detail', () => {
    test('never provisions a local Bitbucket member across the non-JSON then local-record sequence, and logs the refusal', async () => {
        const { callTool, state } = makeCallTool({ 'local-bb': { type: 'local', vcsProvider: 'bitbucket' } });
        const logs = [];
        const ensure = createVcsAuthPreflightCallback({ callTool, command: bbCommand, log: (m) => logs.push(m) });
        await ensure('local-bb');
        await ensure('local-bb');
        assert.deepEqual(state.provisioned, [], `provision_vcs_auth must never run for a local member, logs: ${logs.join('\n')}`);
        assert.ok(
            logs.some((l) => /local member/.test(l) && /provision_vcs_auth failed/.test(l)),
            `expected the local-member refusal to be logged, got: ${logs.join('\n')}`,
        );
    });

    test('still provisions a non-local Bitbucket member in the same setup (no over-refusal)', async () => {
        const { callTool, state } = makeCallTool({ 'remote-bb': { type: 'remote', vcsProvider: 'bitbucket' } });
        const logs = [];
        const ensure = createVcsAuthPreflightCallback({ callTool, command: bbCommand, log: (m) => logs.push(m) });
        await ensure('remote-bb');
        assert.deepEqual(state.provisioned, ['remote-bb'], `logs: ${logs.join('\n')}`);
    });
});
