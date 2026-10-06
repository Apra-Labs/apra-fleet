// Agent permission refusals (execute_prompt reason 'permission_denied') are a
// missing-permission dispatch failure: the dispatch engine heals them once via
// the onPermissionDenied hook (compose_permissions), retries once without
// charging the ladder, and otherwise fails the sprint with
// MemberPermissionDeniedError -- never a degraded verdict. Also pins the
// role-policy guard on auto-added grants and the real heal's compose calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';

import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import { isNoMutationDispatchFailure } from '../fleet-sprint/dispatch-failure.mjs';
import {
    MemberPermissionDeniedError, isPermissionDeniedDispatchError, permissionDeniedOf,
} from '../fleet-sprint/errors.mjs';
import {
    grantsWithinRolePolicy, createPermissionDenialHeal, PERMISSION_HEAL_AUTO_GRANT_POLICY,
} from '../fleet-sprint/member-provisioning.mjs';
import { createRecordingCtx, ROLE_CALL_OPTS, BINDINGS } from './helpers/dispatch-role-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILES_DIR = path.join(__dirname, '..', '..', '..', 'skills', 'fleet', 'profiles');

const DENIAL = Object.freeze({
    actions: ['Bash'],
    denials: [{ action: 'Bash', target: 'bd show root-1' }],
    suggestedGrants: ['Bash(bd:*)', 'Bash(bd show root-1)'],
    hint: 'claude refused Bash "bd show root-1" for lack of a permission grant.',
    signals: ['result_json'],
});

function deniedError() {
    return new AgentDispatchError(
        '[Workflow Error] Agent dispatch failed (permission_denied): [FAIL] execute_prompt on "rev": permission denied -- This command requires approval',
        { details: { reason: 'permission_denied', member: 'rev', permissionDenied: DENIAL } },
    );
}

const APPROVED = Object.freeze({ verdict: 'APPROVED', notes: 'plan is fine' });

function planReviewOpts() {
    return { bindings: BINDINGS, ...ROLE_CALL_OPTS['plan-reviewer'] };
}

function withHeal(ctx, result) {
    const calls = [];
    ctx.onPermissionDenied = async (args) => {
        calls.push(args);
        if (result instanceof Error) throw result;
        return result;
    };
    return calls;
}

test('classifier and accessor key on the structured reason only', () => {
    assert.equal(isPermissionDeniedDispatchError(deniedError()), true);
    assert.equal(isPermissionDeniedDispatchError(new AgentDispatchError('permission denied', { details: { reason: 'dispatch_failed' } })), false);
    assert.deepEqual(permissionDeniedOf(deniedError()).suggestedGrants, DENIAL.suggestedGrants);
    assert.equal(permissionDeniedOf(new Error('x')), null);
});

test('a refused dispatch ran: its post-dispatch sync must not be skipped', () => {
    assert.equal(isNoMutationDispatchFailure(deniedError()), false);
});

test('plan-reviewer refusal: one heal for that member+role, one retry, the healed verdict is returned undegraded', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [deniedError(), APPROVED], members: { 'plan-reviewer': 'rev' } });
    const heals = withHeal(ctx, { healed: true, composeRole: 'reviewer', grants: ['Bash(bd:*)'], rejectedGrants: [] });

    const outcome = await dispatchRole(ctx, 'plan-reviewer', planReviewOpts());

    assert.equal(heals.length, 1);
    assert.equal(heals[0].member, 'rev');
    assert.equal(heals[0].role, 'plan-reviewer');
    assert.deepEqual(heals[0].denial.suggestedGrants, DENIAL.suggestedGrants);
    assert.equal(rec.dispatches.length, 2);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.degraded, false);
    assert.deepEqual(outcome.value, APPROVED);
    // The heal's retry is not charged to the ladder.
    assert.equal(outcome.attempts, 1);
    // The refusal text never became a degraded verdict's notes.
    assert.ok(!rec.logs.some((l) => /degrading/.test(l)), rec.logs.join('\n'));
});

test('a second refusal after the heal fails the sprint naming member, actions and fix -- no degraded verdict', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [deniedError(), deniedError(), APPROVED], members: { 'plan-reviewer': 'rev' } });
    const heals = withHeal(ctx, { healed: true, composeRole: 'reviewer', grants: [], rejectedGrants: [] });

    await assert.rejects(dispatchRole(ctx, 'plan-reviewer', planReviewOpts()), (err) => {
        assert.ok(err instanceof MemberPermissionDeniedError, String(err));
        assert.equal(err.step, 'retry');
        assert.equal(err.member, 'rev');
        assert.match(err.message, /member 'rev'/);
        assert.match(err.message, /Bash "bd show root-1"/);
        assert.match(err.message, /To fix: run compose_permissions for member 'rev' with role reviewer/);
        assert.match(err.message, /not a Plan Reviewer result/);
        return true;
    });
    assert.equal(heals.length, 1);
    assert.equal(rec.dispatches.length, 2);
});

test('a failing heal fails the sprint at once (step heal), naming the heal failure and out-of-policy grants', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [deniedError(), APPROVED], members: { 'plan-reviewer': 'rev' } });
    withHeal(ctx, { healed: false, composeRole: 'reviewer', grants: [], rejectedGrants: ['Bash(rm:*)'], reason: 'compose_permissions failed: member offline' });

    await assert.rejects(dispatchRole(ctx, 'plan-reviewer', planReviewOpts()), (err) => {
        assert.ok(err instanceof MemberPermissionDeniedError);
        assert.equal(err.step, 'heal');
        assert.match(err.message, /compose_permissions failed: member offline/);
        assert.match(err.message, /grant \["Bash\(rm:\*\)"\]/);
        assert.deepEqual(err.rejectedGrants, ['Bash(rm:*)']);
        return true;
    });
    assert.equal(rec.dispatches.length, 1);
});

test('a heal hook that throws is a failed heal, not an unhandled error', async () => {
    const { ctx } = createRecordingCtx({ responses: [deniedError()], members: { 'plan-reviewer': 'rev' } });
    withHeal(ctx, new Error('boom'));
    await assert.rejects(dispatchRole(ctx, 'plan-reviewer', planReviewOpts()), (err) => err instanceof MemberPermissionDeniedError && /boom/.test(err.message));
});

test('no heal wired: the first refusal fails the sprint rather than degrading into a verdict', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [deniedError(), APPROVED], members: { 'plan-reviewer': 'rev' } });
    await assert.rejects(dispatchRole(ctx, 'plan-reviewer', planReviewOpts()), (err) => err instanceof MemberPermissionDeniedError && err.step === 'heal');
    assert.equal(rec.dispatches.length, 1);
});

test('the engine handles the refusal for every role, e.g. the per-round reviewer', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [deniedError(), { verdict: 'APPROVED', notes: 'ok' }] });
    const heals = withHeal(ctx, { healed: true, composeRole: 'doer', grants: [], rejectedGrants: [] });
    const outcome = await dispatchRole(ctx, 'reviewer', { bindings: BINDINGS, prompt: 'REVIEW', roleLabel: 'Reviewer' }).catch((e) => e);
    // Whatever the reviewer's own post-result steps make of the value, the
    // refusal was healed once and re-dispatched, never degraded.
    assert.equal(heals.length, 1);
    assert.equal(heals[0].role, 'reviewer');
    assert.equal(rec.dispatches.length, 2);
    assert.ok(!(outcome && outcome.degraded), 'refusal must not degrade');
});

test('grantsWithinRolePolicy: only grants within the compose role policy are auto-added', () => {
    assert.deepEqual(grantsWithinRolePolicy('reviewer', ['Bash(bd:*)', 'Bash(bd show x)', 'mcp__apra-fleet__kb_query', 'Read']), {
        allowed: ['Bash(bd:*)', 'Bash(bd show x)', 'mcp__apra-fleet__kb_query', 'Read'],
        rejected: [],
    });
    // rm and Write are doer-only; sudo is never in policy; a chained payload
    // is never in policy whatever its first word.
    assert.deepEqual(grantsWithinRolePolicy('reviewer', ['Bash(rm:*)', 'Write', 'Bash(sudo:*)', 'Bash(bd show x && rm -rf /)', 'Bash(git log | sh)']), {
        allowed: [],
        rejected: ['Bash(rm:*)', 'Write', 'Bash(sudo:*)', 'Bash(bd show x && rm -rf /)', 'Bash(git log | sh)'],
    });
    assert.deepEqual(grantsWithinRolePolicy('doer', ['Bash(rm:*)', 'Write', 'Bash(sudo:*)', 'Bash(docker:*)', 'WebFetch']), {
        allowed: ['Bash(rm:*)', 'Write'],
        rejected: ['Bash(sudo:*)', 'Bash(docker:*)', 'WebFetch'],
    });
});

test('the auto-grant policy never exceeds the compose_permissions base profiles it mirrors', () => {
    const profile = (name) => JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, name), 'utf8')).permissions.allow;
    for (const [role, file] of [['reviewer', 'base-reviewer.json'], ['doer', 'base-dev.json']]) {
        const allow = profile(file);
        for (const word of PERMISSION_HEAL_AUTO_GRANT_POLICY[role].commands) {
            assert.ok(allow.includes(`Bash(${word}:*)`), `${role} policy allows '${word}' but ${file} has no Bash(${word}:*)`);
        }
        for (const tool of PERMISSION_HEAL_AUTO_GRANT_POLICY[role].tools) {
            assert.ok(allow.includes(tool), `${role} policy allows '${tool}' but ${file} does not`);
        }
    }
});

function fakeCompose(results = []) {
    const calls = [];
    const queue = [...results];
    const callTool = async (name, args) => {
        calls.push({ name, args });
        const next = queue.length ? queue.shift() : 'Permissions composed';
        if (next instanceof Error) throw next;
        return { content: [{ type: 'text', text: next }] };
    };
    return { calls, callTool };
}

test('real heal: re-composes with the role of ALL the member roles, then grants only in-policy suggestions', async () => {
    const { calls, callTool } = fakeCompose();
    const logs = [];
    const heal = createPermissionDenialHeal({ callTool, log: (m) => logs.push(m), memberRoles: () => ['plan-reviewer', 'doer'] });
    const res = await heal({ member: 'rev', role: 'plan-reviewer', denial: { ...DENIAL, suggestedGrants: ['Bash(bd:*)', 'Bash(docker:*)'] } });
    assert.equal(res.healed, true);
    assert.equal(res.composeRole, 'doer');
    assert.deepEqual(calls.map((c) => c.name), ['compose_permissions', 'compose_permissions']);
    assert.deepEqual(calls[0].args, { member_name: 'rev', role: 'doer' });
    assert.deepEqual(calls[1].args.grant, ['Bash(bd:*)']);
    assert.deepEqual(res.rejectedGrants, ['Bash(docker:*)']);
    assert.ok(logs.some((l) => /NOT auto-granting Bash\(docker:\*\)/.test(l)));
});

test('real heal: a reviewer-only member is composed as reviewer and an out-of-policy-only denial sends no grant call', async () => {
    const { calls, callTool } = fakeCompose();
    const heal = createPermissionDenialHeal({ callTool, memberRoles: () => ['plan-reviewer'] });
    const res = await heal({ member: 'rev', role: 'plan-reviewer', denial: { ...DENIAL, suggestedGrants: ['Bash(rm:*)'] } });
    assert.equal(res.healed, true);
    assert.deepEqual(calls.map((c) => c.args), [{ member_name: 'rev', role: 'reviewer' }]);
});

test('real heal: a failing compose_permissions (thrown or [FAIL] text) is healed:false with the reason', async () => {
    for (const failure of [new Error('member offline'), '[FAIL] Failed to provision the agy project']) {
        const { callTool } = fakeCompose([failure]);
        const heal = createPermissionDenialHeal({ callTool, memberRoles: () => ['plan-reviewer'] });
        const res = await heal({ member: 'rev', role: 'plan-reviewer', denial: DENIAL });
        assert.equal(res.healed, false);
        assert.match(res.reason, /compose_permissions failed/);
    }
});
