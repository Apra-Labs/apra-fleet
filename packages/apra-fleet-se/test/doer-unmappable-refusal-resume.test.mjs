// (Despite the file name this now covers EVERY role: reverting any role row's
// retry.unmappableRefusalResume to false makes the policy tests below fail.)
// A dispatch refused ONLY tool calls that map to no permission grant
// (e.g. a chained or backgrounded shell command) is resumed ONCE in the same
// session (retry.unmappableRefusalResume on every role row), with a notice that
// names the refused call(s) and says no grant can ever allow them. The refused
// reply is never used; a clean reply from the resume is the ladder's result. A
// second such refusal fails with the existing unmappable remedy text, and a
// refusal that maps to a grant still goes through the progressive heal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';

import { dispatchRole, unmappableRefusalResumeNotice } from '../fleet-sprint/dispatch-role.mjs';
import { MemberPermissionDeniedError } from '../fleet-sprint/errors.mjs';
import { policyFor, ROLE_NAMES } from '../fleet-sprint/role-policies.mjs';
import { createRecordingCtx, ROLE_CALL_OPTS, BINDINGS } from './helpers/dispatch-role-harness.mjs';

const CHAINED = 'npm test > /tmp/t.log 2>&1 &';
const REFUSED_SESSION = 'doer-session-refused';

const UNMAPPABLE = Object.freeze({
    actions: ['Bash'],
    denials: [{ action: 'Bash', target: CHAINED, suggestedGrants: [] }],
    suggestedGrants: [],
    hint: `claude refused Bash "${CHAINED}".`,
    signals: ['result_json'],
});
const MAPPABLE = Object.freeze({
    actions: ['Bash'],
    denials: [{ action: 'Bash', target: 'bd show root-1' }],
    suggestedGrants: ['Bash(bd:*)'],
    hint: 'claude refused Bash "bd show root-1" for lack of a permission grant.',
    signals: ['result_json'],
});

const refused = (denial, sessionId = REFUSED_SESSION) => new AgentDispatchError(
    '[Workflow Error] Agent dispatch failed (permission_denied): [FAIL] execute_prompt on "dev": permission denied',
    { details: { reason: 'permission_denied', member: 'dev', permissionDenied: denial, ...(sessionId ? { sessionId } : {}) } },
);

const CLEAN = Object.freeze({ status: 'VERIFY', closedIds: ['bead-1'], notes: 'Finished with plain commands.' });

const doerOpts = () => ({
    ...ROLE_CALL_OPTS.doer,
    prompt: 'FULL DOER STREAK PROMPT',
    prepare: async ({ dispatch, freshSession, refusalNotice }) => {
        if (refusalNotice) return { prompt: `${refusalNotice}\n\nSCOPE RESTATED`, label: 'resume after refused calls' };
        return dispatch.kind === 'max-turns-resume' && !freshSession
            ? { prompt: 'CONTINUE FROM WHERE YOU LEFT OFF', label: 'resume' }
            : { prompt: 'FULL DOER STREAK PROMPT', label: 'main', resumeArg: false };
    },
});

const noProgressHeal = (ctx) => {
    const calls = [];
    ctx.onPermissionDenied = async (args) => {
        calls.push(args);
        return { healed: false, step: 'no_progress', composeRole: 'doer', grants: [], rejectedGrants: [], reason: 'no grant maps to the refused call' };
    };
    return calls;
};

// streak-assignment is a tool-less, schema-only JSON pass over a bead list
// handed to it in the prompt (agentType null, kbInjection 'none'): it issues no
// shell calls, so it can never be refused one, and its only secondary is a
// semantic-repair re-ask, not a same-session resume. The flag is set for
// uniformity (an unmappable refusal there still fails loudly, below); it is
// pinned here, with that reason, as the one role without a resume secondary.
const NO_RESUME_SECONDARY = Object.freeze({ 'streak-assignment': 'tool-less JSON pass; cannot issue shell calls' });

test('policy: every role row resumes once after an unmappable refusal', () => {
    for (const role of ROLE_NAMES) {
        const p = policyFor(role);
        // 'doer-resume' is the doer's own secondary, not a ladder: it inherits the doer's retry block.
        if (p.kind !== 'main') { assert.equal(p.retry.unmappableRefusalResume, true, role); continue; }
        assert.equal(p.retry.unmappableRefusalResume, true, role);
        if (Object.prototype.hasOwnProperty.call(NO_RESUME_SECONDARY, role)) {
            assert.notEqual(p.secondary && p.secondary.kind, 'max-turns-resume', role);
        } else {
            assert.equal(p.secondary && p.secondary.kind, 'max-turns-resume', `${role} needs a same-session resume secondary`);
        }
    }
});

test('notice: names every refused call and says no grant can ever allow them', () => {
    const text = unmappableRefusalResumeNotice([`Bash "${CHAINED}"`, 'Bash "a && b"']);
    assert.ok(text.includes(`Bash "${CHAINED}"`) && text.includes('Bash "a && b"'), text);
    assert.match(text, /no permission grant\s+can ever allow them/);
    assert.match(text, /separate, plain command/);
    assert.doesNotMatch(text, /compose_permissions/);
});

test('an unmappable-only refusal is resumed once in the same session; the clean resumed reply is the result', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [refused(UNMAPPABLE), CLEAN] });
    const heals = noProgressHeal(ctx);
    const out = await dispatchRole(ctx, 'doer', doerOpts());
    assert.equal(out.ok, true);
    assert.deepEqual(out.value, CLEAN, 'the resumed reply, never the refused one, is the result');
    assert.equal(out.resumesIssued, 1);
    assert.equal(rec.dispatches.length, 2, 'main dispatch + exactly one resume');
    assert.equal(rec.dispatches[1].options.resume, REFUSED_SESSION, 'the resume targets the refused session by its explicit id');
    const prompt = rec.dispatches[1].prompt;
    assert.ok(prompt.includes(`Bash "${CHAINED}"`), `the resume prompt names the refused call: ${prompt}`);
    assert.match(prompt, /no permission grant\s+can ever allow them/);
    assert.ok(prompt.includes('SCOPE RESTATED'));
    assert.equal(heals.length, 1);
    assert.ok(rec.logs.some((l) => /its reply is NOT used; resuming session 'doer-session-refused' once/.test(l)), JSON.stringify(rec.logs));
});

test('the notice is delivered even when the caller prepare() does not place it', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [refused(UNMAPPABLE), CLEAN] });
    noProgressHeal(ctx);
    const opts = { ...doerOpts(), prepare: async () => ({ prompt: 'CALLER PROMPT', resumeArg: false }) };
    const out = await dispatchRole(ctx, 'doer', opts);
    assert.equal(out.ok, true);
    assert.ok(rec.dispatches[1].prompt.startsWith(unmappableRefusalResumeNotice([`Bash "${CHAINED}"`])), rec.dispatches[1].prompt);
    assert.ok(rec.dispatches[1].prompt.endsWith('CALLER PROMPT'));
});

test('a resume refused again fails with the unmappable remedy text, no compose_permissions or rerun advice', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [refused(UNMAPPABLE), refused(UNMAPPABLE, 'doer-session-2'), CLEAN] });
    noProgressHeal(ctx);
    await assert.rejects(dispatchRole(ctx, 'doer', doerOpts()), (err) => {
        assert.ok(err instanceof MemberPermissionDeniedError, String(err));
        assert.match(err.message, /no permission grant can allow/);
        assert.doesNotMatch(err.message, /compose_permissions/);
        assert.doesNotMatch(err.message, /rerun|re-run/i);
        assert.equal(err.details.unmappable, true);
        return true;
    });
    assert.equal(rec.dispatches.length, 2, 'exactly one resume, never a second');
});

test('an unmappable refusal with no session id to resume fails at once with the unmappable text', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [refused(UNMAPPABLE, null), CLEAN] });
    noProgressHeal(ctx);
    await assert.rejects(dispatchRole(ctx, 'doer', doerOpts()), (err) => (
        err instanceof MemberPermissionDeniedError && err.details.unmappable === true
    ));
    assert.equal(rec.dispatches.length, 1);
    assert.ok(rec.logs.some((l) => /cannot resume after the unmappable refusal -- the refused dispatch reported no session id/.test(l)), JSON.stringify(rec.logs));
});

test('a grant-mappable refusal is never resumed: the progressive heal re-runs the main dispatch', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [refused(MAPPABLE), CLEAN] });
    const heals = [];
    ctx.onPermissionDenied = async (args) => {
        heals.push(args);
        return { healed: true, grants: ['Bash(bd:*)'] };
    };
    const out = await dispatchRole(ctx, 'doer', doerOpts());
    assert.equal(out.ok, true);
    assert.equal(out.resumesIssued, 0);
    assert.equal(heals.length, 1);
    assert.equal(rec.dispatches.length, 2);
    assert.equal(rec.dispatches[1].prompt, 'FULL DOER STREAK PROMPT', 'the healed re-run is the main dispatch, not a resume');
    assert.notEqual(rec.dispatches[1].options.resume, REFUSED_SESSION);
});

const nonDoerCase = (role, member, extra = {}) => ({
    role,
    member,
    opts: { bindings: BINDINGS, ...ROLE_CALL_OPTS[role], ...extra },
});
const NON_DOER = [
    nonDoerCase('planner', 'planner', { resumeArg: false }),
    nonDoerCase('deployer', 'deployer'),
    nonDoerCase('scoped-replan-planner', 'planner'),
    nonDoerCase('scoped-replan-plan-reviewer', 'plan-reviewer'),
];

for (const { role, member, opts } of NON_DOER) {
    const clean = ROLE_CALL_OPTS[role] && (role.endsWith('reviewer') ? { verdict: 'APPROVED', notes: 'ok' } : (role === 'deployer' ? { deployed: true, summary: 'ok' } : 'plan text'));
    test(`${role}: an unmappable refusal resumes exactly once in the refused session; no grant is composed`, async () => {
        const { ctx, rec } = createRecordingCtx({ responses: [refused(UNMAPPABLE, 'sess-' + role), clean], members: { [role]: 'dev' } });
        const heals = noProgressHeal(ctx);
        const out = await dispatchRole(ctx, role, opts);
        assert.equal(out.ok, true);
        assert.equal(out.resumesIssued, 1);
        assert.equal(rec.dispatches.length, 2, 'main dispatch + exactly one resume');
        assert.equal(rec.dispatches[1].options.resume, 'sess-' + role, 'the explicit refused session id, never resume true');
        assert.ok(rec.dispatches[1].prompt.startsWith(unmappableRefusalResumeNotice([`Bash "${CHAINED}"`])), rec.dispatches[1].prompt);
        assert.equal(heals.length, 1, 'the hook is consulted once and grants nothing');
        assert.ok(heals.every((h) => !h.grants), 'no grant is requested from the resume path');
        void member;
    });

    test(`${role}: a second unmappable refusal throws MemberPermissionDeniedError naming the refused call`, async () => {
        const { ctx, rec } = createRecordingCtx({ responses: [refused(UNMAPPABLE, 'sess-a'), refused(UNMAPPABLE, 'sess-b'), clean], members: { [role]: 'dev' } });
        noProgressHeal(ctx);
        await assert.rejects(dispatchRole(ctx, role, opts), (err) => {
            assert.ok(err instanceof MemberPermissionDeniedError, String(err));
            assert.ok(err.message.includes(CHAINED), err.message);
            assert.equal(err.details.unmappable, true);
            return true;
        });
        assert.equal(rec.dispatches.length, 2, 'one resume, never a third call');
    });
}

test('streak-assignment (tool-less JSON pass, no resume secondary) still fails loudly on an unmappable refusal', async () => {
    const { ctx, rec } = createRecordingCtx({ responses: [refused(UNMAPPABLE), { streaks: [['bead-1']] }], members: { 'streak-assignment': 'dev' } });
    noProgressHeal(ctx);
    await assert.rejects(dispatchRole(ctx, 'streak-assignment', { bindings: BINDINGS, ...ROLE_CALL_OPTS['streak-assignment'] }), MemberPermissionDeniedError);
    assert.equal(rec.dispatches.length, 1);
});
