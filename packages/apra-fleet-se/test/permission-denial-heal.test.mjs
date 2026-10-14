// Agent permission refusals (execute_prompt reason 'permission_denied') are a
// missing-permission dispatch failure: the dispatch engine heals them
// PROGRESSIVELY via the onPermissionDenied hook (grant the missing tool within
// the member's composed policy, retry without charging the ladder, repeat for
// the next tool), and fails the sprint with MemberPermissionDeniedError --
// never a degraded verdict -- once no progress is possible. Auto-mode
// refusals (safety classifier / deny rule) are never granted. Also pins the
// policy guard on grants and the real heal's compose calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';

import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import { isNoMutationDispatchFailure } from '../fleet-sprint/dispatch-failure.mjs';
import {
    MemberPermissionDeniedError, isPermissionDeniedDispatchError, permissionDeniedOf,
} from '../fleet-sprint/errors.mjs';
import {
    grantWithinPolicy, createPermissionDenialHeal, permissionLedgerFolder,
    PERMISSION_HEAL_MEMBER_CAP, PERMISSION_HEAL_LADDER_CAP,
} from '../fleet-sprint/member-provisioning.mjs';
import { createRecordingCtx, ROLE_CALL_OPTS, BINDINGS } from './helpers/dispatch-role-harness.mjs';

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

test('R1 regression guard: typed failures carrying incidental permissionDenied are NOT classified as permission_denied', () => {
    for (const reason of ['auth', 'server', 'overloaded', 'max_turns_exhausted', 'workspace_not_trusted']) {
        const err = new AgentDispatchError(`${reason} failure`, {
            details: {
                reason,
                permissionDenied: {
                    actions: ['command'],
                    denials: [{ action: 'command', target: 'git status' }],
                    suggestedGrants: ['Bash(git:*)'],
                    hint: 'permission check failed',
                },
            },
        });
        assert.equal(isPermissionDeniedDispatchError(err), false, `expected reason '${reason}' with carried denial not to be permission_denied`);
    }
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

test('every role dispatch asks execute_prompt for strict permission handling (fail_on_permission_denial)', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [APPROVED], members: { 'plan-reviewer': 'rev' } });
    await dispatchRole(ctx, 'plan-reviewer', planReviewOpts());
    assert.equal(rec.dispatches.length, 1);
    assert.equal(rec.dispatches[0].options.fail_on_permission_denial, true);
});

test('a max_turns failure that carries a permission denial is a max_turns failure: no heal, never MemberPermissionDeniedError', async () => {
    const maxTurns = new AgentDispatchError(
        '[Workflow Error] Agent dispatch failed (max_turns_exhausted): turn limit',
        { details: { reason: 'max_turns_exhausted', member: 'rev', permissionDenied: DENIAL } },
    );
    const { ctx } = createRecordingCtx({ responses: [maxTurns, APPROVED, APPROVED, APPROVED], members: { 'plan-reviewer': 'rev' } });
    const heals = withHeal(ctx, { healed: true, composeRole: 'reviewer', grants: ['Bash(bd:*)'], rejectedGrants: [] });
    const outcome = await dispatchRole(ctx, 'plan-reviewer', planReviewOpts()).catch((e) => e);
    assert.equal(heals.length, 0, 'a max_turns turn must never reach the permission heal');
    assert.ok(!(outcome instanceof MemberPermissionDeniedError), String(outcome && outcome.message));
});

test('a heal that cannot make progress fails the sprint with the hook\'s step, naming member, actions and fix -- no degraded verdict', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [deniedError(), APPROVED], members: { 'plan-reviewer': 'rev' } });
    const heals = withHeal(ctx, { healed: false, step: 'no_progress', composeRole: 'reviewer', grants: [], rejectedGrants: [], reason: 'Bash "bd show root-1" was refused again after Bash(bd:*) was granted' });

    await assert.rejects(dispatchRole(ctx, 'plan-reviewer', planReviewOpts()), (err) => {
        assert.ok(err instanceof MemberPermissionDeniedError, String(err));
        assert.equal(err.step, 'no_progress');
        assert.equal(err.member, 'rev');
        assert.match(err.message, /member 'rev'/);
        assert.match(err.message, /Bash "bd show root-1"/);
        assert.match(err.message, /no further progress/);
        assert.match(err.message, /To fix: run compose_permissions for member 'rev' with role reviewer/);
        assert.match(err.message, /not a Plan Reviewer result/);
        return true;
    });
    assert.equal(heals.length, 1);
    assert.equal(rec.dispatches.length, 1);
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
    const heals = withHeal(ctx, { healed: true, composeRole: 'doer', grants: ['Bash(bd:*)'], rejectedGrants: [] });
    const outcome = await dispatchRole(ctx, 'reviewer', { bindings: BINDINGS, prompt: 'REVIEW', roleLabel: 'Reviewer' }).catch((e) => e);
    // Whatever the reviewer's own post-result steps make of the value, the
    // refusal was healed and re-dispatched, never degraded.
    assert.equal(heals.length, 1);
    assert.equal(heals[0].role, 'reviewer');
    assert.equal(rec.dispatches.length, 2);
    assert.ok(!(outcome && outcome.degraded), 'refusal must not degrade');
});

// ---------------------------------------------------------------------------
// The real progressive heal (createPermissionDenialHeal)
// ---------------------------------------------------------------------------

// The member's composed allow list as compose_permissions dry_run returns it:
// the doer base profile plus a detected node stack (npm/node are NOT in any
// hand-kept copy -- the policy must come from the composed list).
const DOER_NODE_POLICY = [
    'Read', 'Write', 'Edit', 'Glob', 'Grep',
    'Bash(git:*)', 'Bash(bd:*)', 'Bash(bd *)', 'Bash(ls:*)', 'Bash(cat:*)', 'Bash(grep:*)', 'Bash(gh:*)',
    'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(npm test*)',
    'mcp__apra-fleet__kb_query',
];
const REVIEWER_POLICY = ['Read', 'Glob', 'Grep', 'Bash(git:*)', 'Bash(bd:*)', 'Bash(npm test:*)', 'mcp__apra-fleet__kb_query'];

/** A compose_permissions stand-in: dry_run answers with the policy for the
 *  role, a grant listed in `refuse` is refused as never auto-grantable, every
 *  other call succeeds. Records every call. */
function fakeFleet({ policy = { doer: DOER_NODE_POLICY, reviewer: REVIEWER_POLICY }, refuse = [], fail = null } = {}) {
    const calls = [];
    const callTool = async (name, args) => {
        calls.push({ name, args });
        if (fail) {
            if (fail instanceof Error) throw fail;
            return { content: [{ type: 'text', text: fail }] };
        }
        if (args.dry_run) return { content: [{ type: 'text', text: JSON.stringify({ dry_run: true, mode: args.role, stacks: ['node'], allow: policy[args.role] }) }] };
        if (args.grant && args.grant.some((g) => refuse.includes(g))) {
            return { content: [{ type: 'text', text: `\u274c Cannot auto-grant dangerous permissions: ${args.grant.join(', ')}. Escalate to user.` }] };
        }
        return { content: [{ type: 'text', text: args.grant ? `\u2705 Granted ${args.grant.length} permissions` : '\u2705 Permissions composed' }] };
    };
    const writes = () => calls.filter((c) => !c.args.dry_run);
    return { calls, writes, callTool };
}

const bashDenial = (cmd, extra = {}) => {
    const word = cmd.split(/\s+/)[0];
    const grants = /[|;&`<>]|\$\(/.test(cmd) ? [] : [`Bash(${word}:*)`, ...(cmd !== word ? [`Bash(${cmd})`] : [])];
    return {
        actions: ['Bash'],
        denials: [{ action: 'Bash', target: cmd, suggestedGrants: grants }],
        suggestedGrants: grants,
        hint: `claude refused Bash "${cmd}"`,
        signals: ['result_json'],
        permissionMode: 'acceptEdits',
        healable: true,
        ...extra,
    };
};

function deniedWith(denial) {
    return new AgentDispatchError('[Workflow Error] Agent dispatch failed (permission_denied): denied', { details: { reason: 'permission_denied', member: 'dev', permissionDenied: denial } });
}

test('progressive heal sequence: denial A -> grant -> denial B -> grant -> success, recompose only on the first heal', async () => {
    const fleet = fakeFleet();
    const { ctx, rec } = createRecordingCtx({
        responses: [deniedWith(bashDenial('npm test')), deniedWith(bashDenial('gh pr view 7')), APPROVED],
        members: { 'plan-reviewer': 'dev' },
    });
    ctx.onPermissionDenied = createPermissionDenialHeal({
        callTool: fleet.callTool, memberRoles: () => ['plan-reviewer', 'doer'], ledgerFolderFor: (m) => `/ledgers/${m}`,
    });

    const outcome = await dispatchRole(ctx, 'plan-reviewer', planReviewOpts());

    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.value, APPROVED);
    assert.equal(rec.dispatches.length, 3);
    // Neither heal retry is charged to the ladder.
    assert.equal(outcome.attempts, 1);
    // Policy read once (dry_run), one proactive re-compose (first heal only),
    // then one grant per heal. The second heal does NOT re-compose: that would
    // rewrite the allow list and wipe the first grant.
    assert.deepEqual(fleet.writes().map((c) => c.args), [
        { member_name: 'dev', role: 'doer', project_folder: '/ledgers/dev' },
        { member_name: 'dev', role: 'doer', grant: ['Bash(npm:*)'], grant_reason: 'sprint plan-reviewer dispatch was refused these tool calls', project_folder: '/ledgers/dev' },
        { member_name: 'dev', role: 'doer', grant: ['Bash(gh:*)'], grant_reason: 'sprint plan-reviewer dispatch was refused these tool calls', project_folder: '/ledgers/dev' },
    ]);
    assert.equal(fleet.calls.filter((c) => c.args.dry_run).length, 1);
});

test('auto-mode (classifier / deny rule) refusal is never healed: no compose call at all, the sprint stops not_healable', async () => {
    const fleet = fakeFleet();
    const heal = createPermissionDenialHeal({ callTool: fleet.callTool, memberRoles: () => ['doer'] });
    for (const denial of [
        bashDenial('curl https://example.com', { permissionMode: 'auto', healable: false }),
        bashDenial('curl https://example.com', { permissionMode: 'auto' }),
        bashDenial('curl https://example.com', { permissionMode: 'bypassPermissions', healable: false }),
    ]) {
        const res = await heal({ member: 'dev', role: 'doer', denial });
        assert.equal(res.healed, false);
        assert.equal(res.step, 'not_healable');
        assert.deepEqual(res.grants, []);
    }
    assert.equal(fleet.calls.length, 0, 'a classifier block must never reach compose_permissions');

    const { ctx, rec } = createRecordingCtx({ responses: [deniedWith(bashDenial('curl x', { permissionMode: 'auto', healable: false })), APPROVED], members: { 'plan-reviewer': 'dev' } });
    ctx.onPermissionDenied = heal;
    await assert.rejects(dispatchRole(ctx, 'plan-reviewer', planReviewOpts()), (err) => {
        assert.ok(err instanceof MemberPermissionDeniedError);
        assert.equal(err.step, 'not_healable');
        assert.match(err.message, /safety checks/);
        assert.match(err.message, /No grant is added for a classifier or deny-rule refusal/);
        return true;
    });
    assert.equal(rec.dispatches.length, 1);
});

test('a policy_deny refusal (a tool the member config denies on purpose) in acceptEdits mode is never healed', async () => {
    const fleet = fakeFleet();
    const heal = createPermissionDenialHeal({ callTool: fleet.callTool, memberRoles: () => ['doer'] });
    const denial = {
        actions: ['mcp__fleet__admin_tool', 'Bash'],
        denials: [{ action: 'mcp__fleet__admin_tool', suggestedGrants: [] }, { action: 'Bash', target: 'npm test', suggestedGrants: [] }],
        suggestedGrants: [],
        hint: 'policy',
        signals: ['result_json'],
        permissionMode: 'acceptEdits',
        healable: false,
        cause: 'policy_deny',
    };
    const res = await heal({ member: 'dev', role: 'doer', denial });
    assert.equal(res.healed, false);
    assert.equal(res.step, 'not_healable');
    assert.deepEqual(res.grants, []);
    assert.match(res.reason, /deny rule the member's own permission config carries on purpose/);
    assert.equal(fleet.calls.length, 0, 'a policy deny must never reach compose_permissions, not even a dry_run');
});

test('an agy member-policy refusal (policy_deny, healable false, no grants) stops not_healable with no compose_permissions call', async () => {
    const fleet = fakeFleet();
    const heal = createPermissionDenialHeal({ callTool: fleet.callTool, memberRoles: () => ['doer'] });
    const agyPolicy = {
        actions: ['mcp'],
        denials: [{ action: 'mcp', target: 'apra-fleet/execute_prompt', suggestedGrants: [] }],
        suggestedGrants: [],
        hint: 'agy refused mcp "apra-fleet/execute_prompt": outside the member tool allowlist',
        signals: ['result_json', 'transcript'],
        healable: false,
        cause: 'policy_deny',
    };
    const res = await heal({ member: 'agy1', role: 'doer', denial: agyPolicy });
    assert.equal(res.healed, false);
    assert.equal(res.step, 'not_healable');
    assert.deepEqual(res.grants, []);
    assert.equal(fleet.calls.length, 0, 'an agy policy deny must never reach compose_permissions (no no_progress abort)');
});

test('no progress: the same call refused again after its grant landed stops instead of looping', async () => {
    const fleet = fakeFleet();
    const heal = createPermissionDenialHeal({ callTool: fleet.callTool, memberRoles: () => ['doer'] });
    assert.equal((await heal({ member: 'dev', role: 'doer', denial: bashDenial('npm test') })).healed, true);
    const again = await heal({ member: 'dev', role: 'doer', denial: bashDenial('npm test') });
    assert.equal(again.healed, false);
    assert.equal(again.step, 'no_progress');
    assert.match(again.reason, /refused again after Bash\(npm:\*\) was granted/);
    // A DIFFERENT command the landed grant already covers is no progress too.
    const covered = await heal({ member: 'dev', role: 'doer', denial: bashDenial('npm run build') });
    assert.equal(covered.step, 'no_progress');
    assert.equal(fleet.writes().filter((c) => c.args.grant).length, 1);
});

test('no progress for agy too: its command/unsandboxed refusals match the Bash grant that landed', async () => {
    const fleet = fakeFleet();
    const heal = createPermissionDenialHeal({ callTool: fleet.callTool, memberRoles: () => ['doer'] });
    const agyDenial = { actions: ['unsandboxed'], denials: [{ action: 'unsandboxed', target: 'npm test', suggestedGrants: ['Bash(npm:*)', 'Bash(npm test)'] }], suggestedGrants: ['Bash(npm:*)', 'Bash(npm test)'], hint: 'agy', signals: ['stderr'] };
    assert.equal((await heal({ member: 'agy1', role: 'doer', denial: agyDenial })).healed, true);
    const again = await heal({ member: 'agy1', role: 'doer', denial: agyDenial });
    assert.equal(again.step, 'no_progress');
    assert.match(again.reason, /refused again after Bash\(npm:\*\) was granted/);
});

test('no progress: a grant outside the composed policy is never sent, and is named for the operator', async () => {
    const fleet = fakeFleet();
    const heal = createPermissionDenialHeal({ callTool: fleet.callTool, memberRoles: () => ['doer'] });
    const res = await heal({ member: 'dev', role: 'doer', denial: bashDenial('docker ps') });
    assert.equal(res.healed, false);
    assert.equal(res.step, 'no_progress');
    assert.deepEqual(res.rejectedGrants, ['Bash(docker:*)', 'Bash(docker ps)']);
    assert.equal(fleet.writes().length, 0);
});

test('no progress: a call that maps to no grant (a chained command) stops', async () => {
    const fleet = fakeFleet();
    const heal = createPermissionDenialHeal({ callTool: fleet.callTool, memberRoles: () => ['doer'] });
    const res = await heal({ member: 'dev', role: 'doer', denial: bashDenial('git log | sh') });
    assert.equal(res.step, 'no_progress');
    assert.match(res.reason, /no compose_permissions grant maps/);
    assert.equal(fleet.writes().length, 0);
});

test('compose_permissions refusing a grant (NEVER_AUTO_GRANT) stops, names the grant and lands nothing', async () => {
    const fleet = fakeFleet({ refuse: ['Bash(npm:*)'] });
    const heal = createPermissionDenialHeal({ callTool: fleet.callTool, memberRoles: () => ['doer'] });
    const res = await heal({ member: 'dev', role: 'doer', denial: bashDenial('npm test') });
    assert.equal(res.healed, false);
    assert.equal(res.step, 'heal');
    assert.match(res.reason, /Cannot auto-grant dangerous permissions: Bash\(npm:\*\)/);
    assert.deepEqual(res.rejectedGrants, ['Bash(npm:*)']);
    assert.deepEqual(res.grants, []);
});

test('cap: at most PERMISSION_HEAL_MEMBER_CAP heals per member per sprint', async () => {
    const fleet = fakeFleet();
    const heal = createPermissionDenialHeal({ callTool: fleet.callTool, memberRoles: () => ['doer'] });
    const cmds = ['npm test', 'gh pr view 1', 'git status', 'ls -la'];
    for (const cmd of cmds.slice(0, PERMISSION_HEAL_MEMBER_CAP)) {
        assert.equal((await heal({ member: 'dev', role: 'doer', denial: bashDenial(cmd) })).healed, true, cmd);
    }
    const over = await heal({ member: 'dev', role: 'doer', denial: bashDenial(cmds[PERMISSION_HEAL_MEMBER_CAP]) });
    assert.equal(over.healed, false);
    assert.equal(over.step, 'cap');
    // The cap is per member: another member still heals.
    assert.equal((await heal({ member: 'other', role: 'doer', denial: bashDenial('npm test') })).healed, true);
});

test('cap: at most PERMISSION_HEAL_LADDER_CAP heals within one dispatch ladder', async () => {
    assert.equal(PERMISSION_HEAL_LADDER_CAP, 2);
    const fleet = fakeFleet();
    const { ctx, rec } = createRecordingCtx({
        responses: [deniedWith(bashDenial('npm test')), deniedWith(bashDenial('gh pr view 1')), deniedWith(bashDenial('git status')), APPROVED],
        members: { 'plan-reviewer': 'dev' },
    });
    ctx.onPermissionDenied = createPermissionDenialHeal({ callTool: fleet.callTool, memberRoles: () => ['doer'] });
    await assert.rejects(dispatchRole(ctx, 'plan-reviewer', planReviewOpts()), (err) => err instanceof MemberPermissionDeniedError && err.step === 'cap');
    assert.equal(rec.dispatches.length, 3);
    assert.equal(fleet.writes().filter((c) => c.args.grant).length, 2);
});

test('healed is false when nothing was granted (every needed grant already in place)', async () => {
    const fleet = fakeFleet();
    const heal = createPermissionDenialHeal({ callTool: fleet.callTool, memberRoles: () => ['doer'] });
    // A denial whose only grant option is one this heal already landed, but
    // for a call it does not cover (a scoped grant suggested again).
    const scoped = { ...bashDenial('npm test'), denials: [{ action: 'Read', target: '/w/a', suggestedGrants: ['Read'] }], suggestedGrants: ['Read'] };
    assert.equal((await heal({ member: 'dev', role: 'doer', denial: scoped })).healed, true);
    const res = await heal({ member: 'dev', role: 'doer', denial: { ...scoped, denials: [{ action: 'Write', target: '/w/b', suggestedGrants: ['Read'] }] } });
    assert.equal(res.healed, false);
    assert.equal(res.step, 'no_progress');
});

test('the policy is the member\'s composed allow list (dry_run), cached per member: npm is grantable for a node doer', async () => {
    const fleet = fakeFleet();
    const heal = createPermissionDenialHeal({ callTool: fleet.callTool, memberRoles: (m) => (m === 'rev' ? ['plan-reviewer'] : ['doer']) });
    assert.equal((await heal({ member: 'dev', role: 'doer', denial: bashDenial('npx vitest run') })).healed, true);
    assert.equal((await heal({ member: 'dev', role: 'doer', denial: bashDenial('node -v') })).healed, true);
    assert.deepEqual(fleet.calls.filter((c) => c.args.dry_run).map((c) => c.args), [{ member_name: 'dev', role: 'doer', dry_run: true }]);
    // A reviewer-only member gets the reviewer list: `npm test` is narrow there.
    const res = await heal({ member: 'rev', role: 'plan-reviewer', denial: bashDenial('npm test') });
    assert.equal(res.composeRole, 'reviewer');
    assert.equal(res.healed, true);
    assert.deepEqual(res.grants, ['Bash(npm test)']);
});

test('a failing compose_permissions (thrown or [FAIL] text) is healed:false, step heal, with the reason', async () => {
    for (const failure of [new Error('member offline'), '[FAIL] Failed to provision the agy project']) {
        const fleet = fakeFleet({ fail: failure });
        const heal = createPermissionDenialHeal({ callTool: fleet.callTool, memberRoles: () => ['plan-reviewer'] });
        const res = await heal({ member: 'rev', role: 'plan-reviewer', denial: DENIAL });
        assert.equal(res.healed, false);
        assert.equal(res.step, 'heal');
        assert.match(res.reason, /compose_permissions failed/);
    }
});

test('grantWithinPolicy: wildcard coverage, bare tools, chained payloads', () => {
    assert.equal(grantWithinPolicy('Bash(npm:*)', DOER_NODE_POLICY), true);
    assert.equal(grantWithinPolicy('Bash(npm test)', REVIEWER_POLICY), true);
    assert.equal(grantWithinPolicy('Bash(npm:*)', REVIEWER_POLICY), false, 'npm test:* does not cover all of npm');
    assert.equal(grantWithinPolicy('Bash(gitk:*)', DOER_NODE_POLICY), false);
    assert.equal(grantWithinPolicy('Read(/w/a)', DOER_NODE_POLICY), true, 'bare Read covers a scoped Read');
    assert.equal(grantWithinPolicy('Write', REVIEWER_POLICY), false);
    assert.equal(grantWithinPolicy('Bash(git log | sh)', ['Bash(git:*)']), false);
    assert.equal(grantWithinPolicy('mcp__apra-fleet__kb_query', REVIEWER_POLICY), true);
});

test('permissionLedgerFolder: one folder per member, under a given base or the fleet data dir', () => {
    assert.match(permissionLedgerFolder('dev', '/base'), /^[\\/]base[\\/]dev-[0-9a-f]{12}$/);
    assert.match(permissionLedgerFolder('dev'), /permission-ledgers[\\/]dev-[0-9a-f]{12}$/);
    assert.equal(permissionLedgerFolder(''), undefined);
    // Distinct names that sanitize alike still get distinct folders.
    assert.notEqual(permissionLedgerFolder('a/b', '/base'), permissionLedgerFolder('a_b', '/base'));
});

test('permissionLedgerFolder: no member name can escape the ledger root (dot-only and traversal names)', () => {
    const root = path.resolve('/base/permission-ledgers');
    for (const name of ['..', '.', '...', '../..', '..\\..', '../etc', 'a/../../b', '/abs', 'C:\\x', '.hidden']) {
        const folder = path.resolve(permissionLedgerFolder(name, root));
        assert.equal(path.dirname(folder), root, `${JSON.stringify(name)} -> ${folder}`);
        assert.ok(!path.basename(folder).includes('.'), `${JSON.stringify(name)} -> ${folder}`);
    }
});