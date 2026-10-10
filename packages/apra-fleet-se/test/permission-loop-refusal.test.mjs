// Shell-loop permission refusal, end to end through the dispatch engine
// (dispatch-role.mjs) and the real progressive heal (member-provisioning.mjs
// createPermissionDenialHeal), driven by a Claude result-event fixture shaped
// like the incident it guards: a planner whose reply was COMPLETE (beads
// created, DAG verified) had one verification for-loop refused, and the
// sprint failed in planning.
//
// Which code each assertion guards:
//   (1) complete schema-valid reply continues with a warning
//         -> IMPACT JUDGMENT: dispatch-role.mjs judgeRefusalByImpact. Revert it
//            and the refusal goes to the heal, which can grant nothing for a
//            loop, so the dispatch throws MemberPermissionDeniedError.
//   (2) empty/invalid reply -> resume of the SAME session with the nudge
//         -> NUDGE: member-provisioning.mjs's compound-call split (nudge
//            outcome) plus dispatch-role.mjs runPermissionNudge. Revert it and
//            the heal stops no_progress: no second dispatch, no resume.
//   (3) a third refusal after 2 nudges -> MemberPermissionDeniedError (cap)
//   (4) an out-of-policy inner command -> no nudge, named as outside policy
//   (5) no Bash(for|while|until|do ...) grant ever reaches compose_permissions
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentDispatchError } from '@apralabs/apra-fleet-workflow';

import { dispatchRole, PERMISSION_NUDGE_CAP } from '../fleet-sprint/dispatch-role.mjs';
import { MemberPermissionDeniedError } from '../fleet-sprint/errors.mjs';
import { createPermissionDenialHeal } from '../fleet-sprint/member-provisioning.mjs';
import { createRecordingCtx, ROLE_CALL_OPTS, BINDINGS } from './helpers/dispatch-role-harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULT = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-loop-refusal', 'result.json'), 'utf-8'));
const LOOP = RESULT.permission_denials[0].tool_input.command;
const SESSION = RESULT.session_id;
const LOOP_KEYWORD_GRANT_RE = /^Bash\((for|while|until|do)\b/;

// The permissionDenied block execute_prompt derives from the result event's
// permission_denials (src/providers/claude-permission-denial.ts): one denial
// per refused call; a chained command (';') gets no suggested grant.
function denialFrom(result) {
    const denials = result.permission_denials.map((d) => ({
        action: d.tool_name, target: d.tool_input.command, suggestedGrants: [],
    }));
    return {
        actions: [...new Set(denials.map((d) => d.action))],
        denials,
        suggestedGrants: [],
        hint: `claude refused ${denials.map((d) => `${d.action} "${d.target}"`).join(', ')} for lack of a permission grant.`,
        signals: ['result_json'],
        permissionMode: 'acceptEdits',
        healable: true,
    };
}

// What agent() throws for that result under fail_on_permission_denial: the
// workflow layer forwards the reply, the server's completeness verdict and
// the session id (packages/apra-fleet-workflow refusedReplyDetails).
// `reply: null` = the refused turn left no reply at all.
function refusedDispatch({ reply = RESULT.result, replyComplete = true, result = RESULT } = {}) {
    return new AgentDispatchError('[Workflow Error] Agent dispatch failed (permission_denied): permission denied', {
        details: {
            reason: 'permission_denied',
            member: 'planner-m',
            permissionDenied: denialFrom(result),
            sessionId: result.session_id,
            ...(reply === null ? {} : { response: reply, replyComplete }),
        },
    });
}

const PLANNER_POLICY = ['Read', 'Glob', 'Grep', 'Bash(git:*)', 'Bash(bd:*)', 'mcp__apra-fleet__kb_query'];

function fakeFleet() {
    const calls = [];
    const callTool = async (name, args) => {
        calls.push({ name, args });
        if (args.dry_run) return { content: [{ type: 'text', text: JSON.stringify({ dry_run: true, mode: args.role, stacks: [], allow: PLANNER_POLICY }) }] };
        return { content: [{ type: 'text', text: args.grant ? `✅ Granted ${args.grant.length} permissions` : '✅ Permissions composed' }] };
    };
    return { calls, callTool, grants: () => calls.filter((c) => !c.args.dry_run).flatMap((c) => c.args.grant || []) };
}

function plannerCtx(responses) {
    const fleet = fakeFleet();
    const { ctx, rec } = createRecordingCtx({ responses, members: { planner: 'planner-m' } });
    ctx.onPermissionDenied = createPermissionDenialHeal({ callTool: fleet.callTool, memberRoles: () => ['planner'] });
    return { ctx, rec, fleet };
}

const plannerOpts = () => ({ bindings: BINDINGS, ...ROLE_CALL_OPTS.planner });

test('(1) complete reply with a refused loop: the dispatch resolves with the reply, a warning names the loop, no error', async () => {
    const { ctx, rec, fleet } = plannerCtx([refusedDispatch()]);
    const outcome = await dispatchRole(ctx, 'planner', plannerOpts());
    assert.equal(outcome.ok, true);
    assert.equal(outcome.value, RESULT.result);
    assert.equal(rec.dispatches.length, 1, 'no heal re-dispatch');
    const warning = rec.logs.find((l) => /WARNING/.test(l) && l.includes(LOOP));
    assert.ok(warning, rec.logs.join('\n'));
    assert.deepEqual(outcome.permissionWarnings, [{ member: 'planner-m', role: 'planner', actions: [`Bash "${LOOP}"`] }]);
    assert.deepEqual(fleet.grants(), []);
});

test('(2) empty reply with the same refusal: resume of the SAME session with the separate-commands nudge, no grant', async () => {
    for (const refused of [refusedDispatch({ reply: null }), refusedDispatch({ replyComplete: false })]) {
        const { ctx, rec, fleet } = plannerCtx([refused, RESULT.result]);
        const outcome = await dispatchRole(ctx, 'planner', plannerOpts());
        assert.equal(outcome.ok, true);
        assert.equal(rec.dispatches.length, 2);
        assert.equal(rec.dispatches[1].options.resume, SESSION);
        assert.match(rec.dispatches[1].prompt, /Run each command as its own separate tool call/);
        assert.match(rec.dispatches[1].prompt, /no loops, no loop variables/);
        assert.deepEqual(fleet.grants(), [], 'no compose_permissions grant call');
    }
});

test(`(3) a third consecutive refusal after ${PERMISSION_NUDGE_CAP} nudges fails with MemberPermissionDeniedError`, async () => {
    const empty = () => refusedDispatch({ reply: null });
    const { ctx, rec, fleet } = plannerCtx([empty(), empty(), empty(), RESULT.result]);
    await assert.rejects(dispatchRole(ctx, 'planner', plannerOpts()), (err) => {
        assert.ok(err instanceof MemberPermissionDeniedError, String(err));
        assert.equal(err.step, 'cap');
        assert.ok(err.message.includes(LOOP), err.message);
        return true;
    });
    assert.equal(rec.dispatches.length, 1 + PERMISSION_NUDGE_CAP);
    assert.deepEqual(fleet.grants(), []);
});

test('(4) an out-of-policy inner command: no nudge, the error names it as outside policy', async () => {
    const result = {
        ...RESULT,
        permission_denials: [{ ...RESULT.permission_denials[0], tool_input: { command: 'for r in a b; do curl -s "https://x/$r"; done' } }],
    };
    const { ctx, rec, fleet } = plannerCtx([refusedDispatch({ reply: null, result }), RESULT.result]);
    await assert.rejects(dispatchRole(ctx, 'planner', plannerOpts()), (err) => {
        assert.ok(err instanceof MemberPermissionDeniedError, String(err));
        assert.equal(err.step, 'no_progress');
        assert.match(err.message, /curl -s/);
        // A planner-only member composes with the doer profile.
        assert.match(err.message, /outside the 'doer' composed policy/);
        return true;
    });
    assert.equal(rec.dispatches.length, 1, 'never nudged');
    assert.deepEqual(fleet.grants(), []);
});

test('(5) no grant beginning Bash(for, Bash(while, Bash(until or Bash(do is ever sent, in any scenario', async () => {
    const loops = [
        LOOP,
        'for r in a b\ndo\n  bd graph "$r"\ndone',
        'while bd ready --json; do bd show x; done',
        'until git fetch; do git status; done',
        'for r in a b; do curl "$r"; done',
    ];
    const sent = [];
    for (const command of loops) {
        const result = { ...RESULT, permission_denials: [{ ...RESULT.permission_denials[0], tool_input: { command } }] };
        // The provider's suggestion for a newline-separated loop starts with
        // the loop keyword; the heal must never pass it on.
        const err = refusedDispatch({ reply: null, result });
        err.details.permissionDenied.denials[0].suggestedGrants = /[;|&]/.test(command) ? [] : ['Bash(for:*)', `Bash(${command})`];
        const { ctx, fleet } = plannerCtx([err, err, err, RESULT.result]);
        await dispatchRole(ctx, 'planner', plannerOpts()).catch(() => {});
        sent.push(...fleet.grants());
    }
    assert.deepEqual(sent.filter((g) => LOOP_KEYWORD_GRANT_RE.test(g)), [], JSON.stringify(sent));
    assert.deepEqual(sent, []);
});
