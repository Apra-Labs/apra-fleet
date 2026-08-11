import { test, describe } from 'node:test';
import assert from 'node:assert';

import { resolveMemberOs, clearMemberOsCache, buildCredentialReadCommand } from '../fleet-sprint/runner.js';

// apra-fleet-ot2z.13: resolveMemberOs must cache ONLY a successful
// member_detail-derived OS, never the 'linux' fallback path. A transient
// member_detail failure (asleep member, flaky SSH, MCP hiccup) must not
// permanently pin a Windows member to POSIX command construction for the
// rest of the runner process -- the very next call must re-probe and, once
// member_detail succeeds, resolve (and cache) the real OS.
describe('resolveMemberOs cache (apra-fleet-ot2z.13)', () => {
    test('does not cache the fallback: a rejected member_detail call is re-probed next time, and a subsequent success resolves windows', async () => {
        clearMemberOsCache();
        const member = 'flaky-windows-member';
        let callCount = 0;
        const fleetApi = {
            memberDetail: async () => {
                callCount += 1;
                if (callCount === 1) {
                    throw new Error('transient: member briefly unreachable');
                }
                return { content: [{ text: JSON.stringify({ os: 'windows' }) }] };
            },
        };
        const logs = [];
        const log = (m) => logs.push(m);

        const first = await resolveMemberOs({ fleetApi, member, log });
        assert.equal(first, 'linux', 'transient failure must degrade to the linux fallback, uncached');
        assert.equal(callCount, 1);

        const second = await resolveMemberOs({ fleetApi, member, log });
        assert.equal(second, 'windows', 'the fallback must not have been cached -- the second call must re-probe member_detail');
        assert.equal(callCount, 2, 'member_detail must be re-dispatched on the second call, not served from cache');

        // Third call must now be served from cache (member_detail not called again).
        const third = await resolveMemberOs({ fleetApi, member, log });
        assert.equal(third, 'windows');
        assert.equal(callCount, 2, 'a successful resolution IS cached -- the third call must not re-dispatch member_detail');

        // The second call's resolved OS must build the Windows -EncodedCommand
        // credential-read form (not the POSIX $HOME string).
        const { command } = buildCredentialReadCommand(second, 'github-push-pr');
        assert.match(command, /^powershell -EncodedCommand [A-Za-z0-9+/=]+$/, `expected a Windows -EncodedCommand form, got: ${command}`);
        clearMemberOsCache();
    });
});
