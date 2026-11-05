import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createKbInjection, withWrapperKbBlock } from '../fleet-sprint/kb-injection.mjs';
import { createMemberVerifiedLookup } from '../fleet-sprint/member-init-probe.mjs';
import { buildDoerPrompt, buildReviewerPrompt } from '../fleet-sprint/prompts.mjs';
import { agentTypeAppliesKbCaptures } from '../fleet-sprint/role-policies.mjs';

// =============================================================================
// apra-fleet-6agk.3.1.2 -- end-to-end check of push-to-every-dispatch (D1).
//
// Two members, one verified by the init probe (createMemberVerifiedLookup over
// init records, the same lookup runner.js stores on context.isMemberVerified)
// and one not. Each is dispatched the doer and the reviewer (whose prompt
// builders place the block from kbInjection.blockFor) and six wrapper roles
// (whose block is appended by withWrapperKbBlock, the exact step runner.js's
// agent() wrapper runs). The final prompt of every dispatch is then checked.
//
// Revert check (done by hand when this test was written): restoring the old
// gate in kb-injection.mjs -- `shouldInject` returning !verified(member) and
// blockFor's `if (verified(member)) return [];` early return -- makes the
// verified-member assertions below fail ("verified-1 / doer: block header
// count" expected 1, got 0), while the unverified-member ones still pass.
// =============================================================================

const HEADER = 'KNOWLEDGE BANK -- what this repo already knows';
const count = (text, needle) => text.split(needle).length - 1;

const records = [
    { member: 'verified-1', verified: true },
    { member: 'unverified-1', verified: false },
];

function fakeKbWork() {
    const calls = [];
    return {
        calls,
        knowledgeFor: async (member, hints) => {
            calls.push({ member, hints });
            return {
                entries: [{ id: 'k1', title: 'pushed fact', summary: 'pushed fact summary', confidence: 'CONFIRMED', source_files: ['src/a.mjs'] }],
                source: 'query',
            };
        },
    };
}

/** The final prompt of one dispatch, built the way the engine builds it. */
async function dispatchPrompt(kbInjection, role, member) {
    const context = { beadTitles: [{ title: 'push topic' }] };
    if (role === 'doer') {
        const kbBlock = await kbInjection.blockFor({ role, member, context, captureChannel: true });
        const prompt = buildDoerPrompt({ beadIds: ['x-1'], branch: 'b', feedback: null, kbBlock });
        return withWrapperKbBlock(prompt, { kbInjection, agentType: role, member, context });
    }
    if (role === 'reviewer') {
        const kbBlock = await kbInjection.blockFor({ role, member, context, captureChannel: true });
        const prompt = buildReviewerPrompt({
            beadIds: ['x-1'], acceptanceCriteriaJson: '[]', baseBranch: 'main', branch: 'b',
            mergeBaseSha: '0123456789abcdef0123456789abcdef01234567', goal: 'g', kbCandidates: [], kbBlock,
        });
        return withWrapperKbBlock(prompt, { kbInjection, agentType: role, member, context });
    }
    return withWrapperKbBlock(`You are the ${role}.`, {
        kbInjection, agentType: role, member, context, captureChannel: agentTypeAppliesKbCaptures(role),
    });
}

describe('KB block reaches verified and unverified members exactly once per role (D1)', () => {
    const roles = [
        'doer', 'reviewer', 'planner', 'plan-reviewer', 'harvester', 'deployer',
        'integ-test-runner', 'regression-test-runner',
    ];
    const members = ['verified-1', 'unverified-1'];

    test('every dispatch carries the block once, and knowledgeFor runs once per dispatch', async () => {
        const isVerified = createMemberVerifiedLookup(() => records);
        assert.equal(isVerified('verified-1'), true);
        assert.equal(isVerified('unverified-1'), false);
        const kbWork = fakeKbWork();
        const kbInjection = createKbInjection({ kbWork, isMemberVerified: isVerified, log: () => {} });

        let dispatches = 0;
        for (const member of members) {
            for (const role of roles) {
                const before = kbWork.calls.length;
                const prompt = await dispatchPrompt(kbInjection, role, member);
                dispatches += 1;
                assert.equal(count(prompt, HEADER), 1, `${member} / ${role}: block header count`);
                assert.ok(prompt.includes('pushed fact'), `${member} / ${role}: block content present`);
                assert.equal(kbWork.calls.length - before, 1, `${member} / ${role}: knowledgeFor called once`);
                assert.equal(kbWork.calls[kbWork.calls.length - 1].member, member);
            }
        }
        assert.equal(kbWork.calls.length, dispatches);
    });

    test('the wrapper never adds a second copy for doer or reviewer', async () => {
        const kbWork = fakeKbWork();
        const kbInjection = createKbInjection({ kbWork, isMemberVerified: () => true, log: () => {} });
        for (const role of ['doer', 'reviewer']) {
            const out = await withWrapperKbBlock('builder prompt', { kbInjection, agentType: role, member: 'verified-1' });
            assert.equal(out, 'builder prompt', `${role}: wrapper leaves the builder prompt unchanged`);
        }
        assert.equal(kbWork.calls.length, 0, 'no KB read for a role the wrapper skips');
    });

    test('runner.js agent() runs withWrapperKbBlock on every dispatch prompt', () => {
        const src = fs.readFileSync(new URL('../fleet-sprint/runner.js', import.meta.url), 'utf8');
        assert.match(src, /const agent = async \(prompt, opts = \{\}\) => \{\s*(?:\/\/[^\n]*\n\s*)*const captureChannel = agentTypeAppliesKbCaptures\(opts\.agentType\);\s*const finalPrompt = await withWrapperKbBlock\(prompt, \{/);
        assert.match(src, /agentRaw\(finalPrompt,/);
    });
});
