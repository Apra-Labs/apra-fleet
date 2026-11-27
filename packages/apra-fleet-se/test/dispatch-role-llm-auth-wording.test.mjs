import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';

import { dispatchRole, llmAuthFixText } from '../fleet-sprint/dispatch-role.mjs';
import { ROLE_CALL_OPTS, createRecordingCtx } from './helpers/dispatch-role-harness.mjs';

// An unhealed LLM-auth failure on a ladder that rethrows: the log line and the
// appended error text must name the fix for the member kind. provision_llm_auth
// skips local members, so it may only be named for a remote one. No real
// credentials or home directory are touched (the dispatch is a stub).

const ROLE = 'final-review';

const authError = (message = 'Authentication failed on "m1". Not logged in') => new AgentDispatchError(
    `[Workflow Error] Agent dispatch failed (auth): ${message}`,
    { details: { reason: 'auth' } },
);

async function run(kind, error) {
    const { ctx, rec } = createRecordingCtx({ responses: [error] });
    if (kind !== undefined) ctx.memberKind = async () => kind;
    let thrown = null;
    try { await dispatchRole(ctx, ROLE, ROLE_CALL_OPTS[ROLE]); } catch (e) { thrown = e; }
    assert.ok(thrown, 'the unhealed auth failure is rethrown');
    return { thrown, log: rec.logs.join('\n') };
}

const count = (text, needle) => text.split(needle).length - 1;

describe('dispatch-role LLM auth failure wording per member kind', () => {
    test('llmAuthFixText: local never names provision_llm_auth, remote does', () => {
        assert.doesNotMatch(llmAuthFixText('local'), /provision_llm_auth/);
        assert.match(llmAuthFixText('local'), /interactively in the LLM CLI on this host/);
        assert.match(llmAuthFixText('remote'), /provision_llm_auth/);
    });

    test('local member: log line and rethrown message omit provision_llm_auth and name an interactive login on this host', async () => {
        const { thrown, log } = await run('local', authError());
        assert.doesNotMatch(log, /provision_llm_auth/);
        assert.doesNotMatch(thrown.message, /provision_llm_auth/);
        assert.match(log, /interactively in the LLM CLI on this host/);
        assert.match(thrown.message, /interactively in the LLM CLI on this host/);
    });

    test('remote member (and unresolved kind): both keep the provision_llm_auth / API-key guidance', async () => {
        for (const kind of ['remote', undefined]) {
            const { thrown, log } = await run(kind, authError());
            assert.match(log, /provision_llm_auth \(or provision an API key\)/);
            assert.match(thrown.message, /provision_llm_auth \(or provision an API key\)/);
        }
    });

    test('the failed heal is stated exactly once, even if the message names provision_llm_auth or already carries a heal-failed note', async () => {
        for (const kind of ['local', 'remote']) {
            const named = await run(kind, authError('Run /login, then run provision_llm_auth to deploy them. auth'));
            assert.equal(count(named.thrown.message, 'LLM auth self-heal failed'), 1, `${kind}/named`);
            const already = await run(kind, authError("auth [LLM auth heal failed for member 'm1': earlier]"));
            assert.equal(count(already.thrown.message, 'LLM auth self-heal failed'), 1, `${kind}/already`);
            assert.equal(count(already.thrown.message, 'LLM auth heal failed'), 1, `${kind}/already keeps the earlier note, not re-added`);
        }
    });
});
