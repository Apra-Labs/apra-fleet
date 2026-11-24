// Every dispatch logs its requested and resolved tier, tierReason and any
// escalation; a resolved tier that differs from the request (or is absent while
// a tier was requested) raises a WARN; the sprint summary counts per tier,
// escalations and mismatches. The agent() bridge below mirrors the runner's
// agent() wrapper (tier_context stripped, onResolvedTier captured, both fed to
// dispatchAccounting.around), and dispatchRole is the REAL engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dispatchRole } from '../fleet-sprint/dispatch-role.mjs';
import { createDispatchAccounting, tierCounts, formatTierSummary } from '../fleet-sprint/dispatch-accounting.mjs';
import { createRecordingCtx, ROLE_CALL_OPTS, BINDINGS } from './helpers/dispatch-role-harness.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const DOER_OK = Object.freeze({ status: 'VERIFY', closedIds: ['bead-1'], notes: 'done' });

/** A ctx whose agent() runs through dispatchAccounting like runner.js does. */
function bridgedCtx({ resolved }) {
    const { ctx, rec } = createRecordingCtx({ defaultResponse: DOER_OK });
    const lines = [];
    const store = [];
    const accounting = createDispatchAccounting({ log: (m) => lines.push(m), store });
    const inner = ctx.agent;
    ctx.agent = async (prompt, opts) => {
        const { tier_context: tierContext, ...agentOpts } = opts;
        let resolvedInfo = null;
        return accounting.around(
            {
                memberName: opts.member_name, role: opts.agentType, label: opts.label,
                requestedTier: opts.model, tierContext, resolved: () => resolvedInfo,
            },
            async () => {
                const out = await inner(prompt, agentOpts);
                // What execute_prompt's structuredContent would carry.
                resolvedInfo = resolved;
                return out;
            },
        );
    };
    return { ctx, rec, lines, store };
}

const doerOpts = (tierContext) => ({
    ...ROLE_CALL_OPTS.doer,
    tierContext,
    prepare: async () => ({ prompt: 'DOER PROMPT', label: 'main', resumeArg: false }),
});

const CONTEXT = () => ({
    beadIds: ['bead-1'],
    tierReasons: { 'bead-1': 'H2 cross-module contract change' },
    escalations: [],
});

test('a matching resolved tier logs the full tier line and no WARN', async () => {
    const { ctx, lines, store } = bridgedCtx({ resolved: { resolved_tier: 'premium', resolved_model: 'model-p-1' } });
    await dispatchRole(ctx, 'doer', doerOpts(CONTEXT()));
    const line = lines.find((l) => l.startsWith('[tier] dispatch'));
    assert.ok(line, `no tier line in ${JSON.stringify(lines)}`);
    assert.match(line, /role=doer/);
    assert.match(line, /member=member:doer-3/);
    assert.match(line, /beads=bead-1/);
    assert.match(line, /requested_tier=premium/);
    assert.match(line, /resolved_tier=premium/);
    assert.match(line, /resolved_model=model-p-1/);
    assert.match(line, /tierReason=bead-1:H2 cross-module contract change/);
    assert.equal(lines.filter((l) => l.includes('[tier] WARN')).length, 0);
    assert.equal(store[0].tier.mismatch, null);
});

test('a resolved tier that differs from the request logs a WARN naming member, requested and resolved', async () => {
    const { ctx, lines, store } = bridgedCtx({ resolved: { resolved_tier: 'standard', resolved_model: 'model-s-1' } });
    await dispatchRole(ctx, 'doer', doerOpts(CONTEXT()));
    const warns = lines.filter((l) => l.includes('[tier] WARN'));
    assert.equal(warns.length, 1, JSON.stringify(lines));
    assert.match(warns[0], /member:doer-3/);
    assert.match(warns[0], /requested tier 'premium'/);
    assert.match(warns[0], /resolved to 'standard'/);
    assert.equal(store[0].tier.mismatch, 'tier-differs');
});

test('a result with no resolved_tier for a tier request logs a WARN', async () => {
    const { ctx, lines, store } = bridgedCtx({ resolved: { resolved_tier: null, resolved_model: null } });
    await dispatchRole(ctx, 'doer', doerOpts(CONTEXT()));
    const warns = lines.filter((l) => l.includes('[tier] WARN'));
    assert.equal(warns.length, 1, JSON.stringify(lines));
    assert.match(warns[0], /requested tier 'premium'/);
    assert.match(warns[0], /no resolved_tier/);
    assert.equal(store[0].tier.mismatch, 'no-resolved-tier');
});

test('an escalated redo logs the escalation from -> to', async () => {
    const { ctx, lines } = bridgedCtx({ resolved: { resolved_tier: 'premium', resolved_model: 'model-p-1' } });
    await dispatchRole(ctx, 'doer', doerOpts({
        beadIds: ['bead-1'],
        tierReasons: {},
        escalations: [{ id: 'bead-1', from: 'standard', to: 'premium' }],
    }));
    const line = lines.find((l) => l.startsWith('[tier] dispatch'));
    assert.match(line, /escalation=bead-1 standard->premium/);
});

test('a non-doer dispatch with no tier context still emits the line', async () => {
    const { ctx, rec } = createRecordingCtx({ defaultResponse: { verdict: 'APPROVED', notes: 'ok' } });
    const lines = [];
    const accounting = createDispatchAccounting({ log: (m) => lines.push(m) });
    const inner = ctx.agent;
    ctx.agent = (prompt, opts) => accounting.around(
        { memberName: opts.member_name, role: opts.agentType, requestedTier: opts.model, tierContext: opts.tier_context, resolved: () => ({ resolved_tier: 'standard', resolved_model: 'm' }) },
        () => inner(prompt, opts),
    );
    await dispatchRole(ctx, 'streak-assignment', { ...ROLE_CALL_OPTS['streak-assignment'], bindings: BINDINGS }).catch(() => {});
    assert.ok(rec.dispatches.length >= 1);
    assert.ok(lines.some((l) => /^\[tier\] dispatch \d+: role=/.test(l)), JSON.stringify(lines));
});

test('the sprint summary counts per requested tier, escalations and mismatches', () => {
    const rec = (requested, resolved, escalations = []) => ({
        tier: {
            requested, resolved, escalations,
            mismatch: requested && resolved !== requested ? (resolved ? 'tier-differs' : 'no-resolved-tier') : null,
        },
    });
    const records = [
        rec('premium', 'premium'),
        rec('premium', 'standard'),
        rec('standard', null),
        rec('cheap', 'cheap'),
        rec('premium', 'premium', [{ id: 'b', from: 'standard', to: 'premium' }]),
    ];
    const c = tierCounts(records);
    assert.deepEqual(c.perTier, { cheap: 1, standard: 1, premium: 3, other: 0, none: 0 });
    assert.equal(c.escalations, 1);
    assert.equal(c.mismatches, 2);
    const text = formatTierSummary(records).join('\n');
    assert.match(text, /cheap 1, standard 1, premium 3/);
    assert.match(text, /Escalations: 1/);
    assert.match(text, /mismatches[^:]*: 2/);
});

test('runner.js strips tier_context and wires onResolvedTier into the accounting wrapper', () => {
    const src = readFileSync(join(REPO_ROOT, 'packages/apra-fleet-se/fleet-sprint/runner.js'), 'utf8');
    assert.match(src, /tier_context: tierContext, \.\.\.opts/);
    assert.match(src, /opts\.onResolvedTier = /);
    assert.match(src, /requestedTier: opts\.model/);
});

test('tier-policy doc names balanced as default and tierPolicy quality as rollback; CHANGELOG.md untouched', () => {
    const doc = readFileSync(join(REPO_ROOT, 'docs/fleet-sprint-tier-policy.md'), 'utf8');
    assert.match(doc, /default preset is `balanced`/);
    assert.match(doc, /launch with tierPolicy:\s+quality to restore the previous behaviour/);
    assert.equal(/[^\x00-\x7F]/.test(doc), false, 'doc must be ASCII only');
    assert.ok(existsSync(join(REPO_ROOT, 'CHANGELOG.md')));
    // Unchanged versus HEAD: neither modified nor staged by this change. (A
    // local `main` ref can lag the sprint branch's real base, so a merge-base
    // comparison would report unrelated history as a CHANGELOG edit.) Throws
    // (non-zero exit) when CHANGELOG.md differs.
    execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'CHANGELOG.md'], { cwd: REPO_ROOT });
});
