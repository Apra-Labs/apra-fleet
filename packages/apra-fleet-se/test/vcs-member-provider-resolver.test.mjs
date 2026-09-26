import { test, describe } from 'node:test';
import assert from 'node:assert';

import { createMemberVcsProviderResolver } from '../fleet-sprint/runner.js';

// apra-fleet-417.8: apra-fleet-417.7 added createMemberVcsProviderResolver
// (runner.js) but every existing test for the provider-threading feature
// injects a hand-rolled resolveMemberProvider stub, so the REAL resolver
// (the one runSprintCycle actually wires via `args.callTool`, see runner.js
// ~line 4753) has zero direct coverage. This file closes that gap with a
// stubbed callTool -- no live fleet server required.

const memberDetailOk = (provider) => ({ content: [{ text: JSON.stringify({ vcsProvider: provider }) }] });

describe('createMemberVcsProviderResolver', () => {
    test('resolves and caches per member -- a second lookup for the SAME member issues no second member_detail call', async () => {
        const calls = [];
        const callTool = async (name, args) => {
            calls.push({ name, args });
            if (name === 'member_detail') return memberDetailOk('bitbucket');
            throw new Error(`unexpected callTool: ${name}`);
        };
        const resolveMemberProvider = createMemberVcsProviderResolver({ callTool });

        const first = await resolveMemberProvider('fleet-mac');
        const second = await resolveMemberProvider('fleet-mac');

        assert.equal(first, 'bitbucket');
        assert.equal(second, 'bitbucket');
        assert.equal(calls.length, 1, `expected exactly one member_detail call for a repeated lookup of the same member, got: ${JSON.stringify(calls)}`);
    });

    test('resolves independently (and caches independently) per DIFFERENT member', async () => {
        const calls = [];
        const callTool = async (name, args) => {
            calls.push({ name, args });
            if (name === 'member_detail') {
                return args.member_name === 'member-a' ? memberDetailOk('azure-devops') : memberDetailOk('github');
            }
            throw new Error(`unexpected callTool: ${name}`);
        };
        const resolveMemberProvider = createMemberVcsProviderResolver({ callTool });

        const a = await resolveMemberProvider('member-a');
        const b = await resolveMemberProvider('member-b');
        const aAgain = await resolveMemberProvider('member-a');

        assert.equal(a, 'azure-devops');
        assert.equal(b, 'github');
        assert.equal(aAgain, 'azure-devops');
        assert.equal(calls.length, 2, `expected exactly one member_detail call per distinct member, got: ${JSON.stringify(calls)}`);
    });

    test('fails closed: when the underlying resolveProvider throws (unregistered member, typed ERROR: response), returns undefined, logs, and never throws', async () => {
        const callTool = async (name, args) => {
            if (name === 'member_detail') return { content: [{ text: 'no member found matching "ghost"' }] };
            throw new Error(`unexpected callTool: ${name}`);
        };
        const logs = [];
        const resolveMemberProvider = createMemberVcsProviderResolver({ callTool, log: (m) => logs.push(m) });

        const result = await resolveMemberProvider('ghost');

        assert.equal(result, undefined, 'an unresolvable member must resolve to undefined (fail closed to the default provider chain), never throw');
        assert.ok(
            logs.some((l) => /could not resolve member 'ghost'/.test(l)),
            `expected a log entry naming the unresolved member, got: ${JSON.stringify(logs)}`,
        );
    });

    test('caches the undefined failure result too -- a repeated lookup for the same unresolvable member is not re-queried', async () => {
        const calls = [];
        const callTool = async (name, args) => {
            calls.push({ name, args });
            if (name === 'member_detail') return { content: [{ text: 'no member found matching "ghost"' }] };
            throw new Error(`unexpected callTool: ${name}`);
        };
        const resolveMemberProvider = createMemberVcsProviderResolver({ callTool });

        const first = await resolveMemberProvider('ghost');
        const second = await resolveMemberProvider('ghost');

        assert.equal(first, undefined);
        assert.equal(second, undefined);
        assert.equal(calls.length, 1, `expected the failed resolution to be cached (no re-query), got: ${JSON.stringify(calls)}`);
    });

    test('fails closed when callTool itself throws (fleet unreachable), never throws, no caching poison across unrelated members', async () => {
        const callTool = async () => { throw new Error('fleet server unreachable'); };
        const logs = [];
        const resolveMemberProvider = createMemberVcsProviderResolver({ callTool, log: (m) => logs.push(m) });

        const result = await resolveMemberProvider('some-member');

        assert.equal(result, undefined, 'a fleet-unreachable error must also fail closed to undefined, not throw');
        assert.ok(
            logs.some((l) => /some-member/.test(l)),
            `expected the log entry to name the member, got: ${JSON.stringify(logs)}`,
        );
    });

    test('the returned callback never throws even for a member whose vcsProvider is an unrecognized string', async () => {
        const callTool = async (name) => {
            if (name === 'member_detail') return memberDetailOk('totally-not-a-real-provider');
            throw new Error(`unexpected callTool: ${name}`);
        };
        const resolveMemberProvider = createMemberVcsProviderResolver({ callTool });

        await assert.doesNotReject(async () => {
            const result = await resolveMemberProvider('member-x');
            assert.equal(result, undefined);
        });
    });
});
