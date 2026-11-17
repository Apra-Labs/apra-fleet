import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WorkflowError } from '@apralabs/apra-fleet-workflow';
import { PreSprintValidationError, PRE_SPRINT_REFUSAL_REASONS } from '../fleet-sprint/errors.mjs';
import { isTypedAbortError } from '../fleet-sprint/abort.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RUNNER_PATH = path.join(__dirname, '../fleet-sprint/runner.js');
const RUNNER_SRC = fs.readFileSync(RUNNER_PATH, 'utf8');

// =============================================================================
// Every pre-sprint validation refusal is typed.
//
// Before this, runSprintCycle's pre-sprint block threw bare `Error`s whose
// only discriminator was their prose, so a caller could not tell "no ready
// work" from "the target beads are invisible to this clone" from "the scope is
// deadlocked" without substring-matching a sentence.
//
// The throw-site checks below read runner.js SOURCE rather than the loaded
// module, deliberately: runSprintCycle cannot be driven to these branches
// without a whole sprint fixture, and a source-level check is what can prove
// the NEGATIVE -- that no refusal site was left as a bare Error. Runtime
// coverage of the surrounding behaviour (the verify-only sprint, the stale-
// clone case, the cycle auto-repair) lives in the mock-sprint suites.
// =============================================================================

/**
 * Finds, for each occurrence of `needle` in `src`, the class name of the
 * nearest `throw new <Class>(` that precedes it -- i.e. the throw site the
 * message text belongs to.
 * @returns {Array<{className: string, index: number}>}
 */
function throwSitesFor(src, needle) {
    const throwRe = /throw new (\w+)\(/g;
    const throws = [];
    let m;
    while ((m = throwRe.exec(src)) !== null) {
        throws.push({ className: m[1], index: m.index });
    }

    const sites = [];
    let from = 0;
    for (;;) {
        const at = src.indexOf(needle, from);
        if (at === -1) break;
        from = at + needle.length;
        const preceding = throws.filter((t) => t.index < at);
        if (preceding.length === 0) continue;
        sites.push(preceding[preceding.length - 1]);
    }
    return sites;
}

test('every pre-sprint refusal in runner.js throws PreSprintValidationError, none a bare Error', () => {
    const sites = throwSitesFor(RUNNER_SRC, 'Pre-sprint validation failed:');

    assert.ok(sites.length > 0, 'expected at least one pre-sprint refusal throw site in runner.js');

    const offenders = sites.filter((s) => s.className !== 'PreSprintValidationError');
    assert.deepStrictEqual(
        offenders.map((s) => s.className),
        [],
        'every "Pre-sprint validation failed:" message must be raised by PreSprintValidationError -- ' +
        `found ${offenders.length} raised by: ${offenders.map((s) => s.className).join(', ')}`
    );
});

test('every refusal reason in the vocabulary is used by a runner.js throw site, and vice versa', () => {
    const reasons = Object.keys(PRE_SPRINT_REFUSAL_REASONS);
    assert.ok(reasons.length > 0, 'the refusal vocabulary must not be empty');

    // Discovered, never hardcoded: whatever the vocabulary declares must be
    // reachable, and whatever runner.js raises must be in the vocabulary.
    const usedRe = /PRE_SPRINT_REFUSAL_REASONS\.(\w+)/g;
    const used = new Set();
    let m;
    while ((m = usedRe.exec(RUNNER_SRC)) !== null) used.add(m[1]);

    for (const reason of reasons) {
        assert.ok(
            used.has(reason),
            `PRE_SPRINT_REFUSAL_REASONS.${reason} is declared but no runner.js refusal raises it -- ` +
            'either a refusal path lost its discriminator or the vocabulary carries a dead reason'
        );
    }
    for (const reason of used) {
        assert.ok(
            Object.prototype.hasOwnProperty.call(PRE_SPRINT_REFUSAL_REASONS, reason),
            `runner.js raises PRE_SPRINT_REFUSAL_REASONS.${reason}, which the vocabulary does not declare`
        );
    }

    // One distinct reason per refusal site: two refusals sharing a
    // discriminator would put the caller straight back to reading prose.
    const sites = throwSitesFor(RUNNER_SRC, 'Pre-sprint validation failed:');
    assert.equal(
        used.size,
        sites.length,
        `expected one distinct reason per refusal site -- ${sites.length} site(s), ${used.size} distinct reason(s)`
    );
});

test('the stale-in-progress reclaim still runs BEFORE any refusal is raised', () => {
    // An empty `--ready` set is not by itself "nothing left to do": a bead
    // stuck in_progress by an interrupted run must be reclaimed first. Anchor
    // by symbol, and require the reclaim call to precede every refusal site.
    const reclaimAt = RUNNER_SRC.indexOf('await reclaimStaleInProgress({');
    assert.ok(reclaimAt > -1, 'reclaimStaleInProgress call site not found -- re-locate by symbol');

    const firstRefusal = RUNNER_SRC.indexOf('Pre-sprint validation failed:');
    assert.ok(
        reclaimAt < firstRefusal,
        'the stale-in-progress reclaim must run before the first pre-sprint refusal'
    );
});

test('the verify-only sprint path is still outside the refusal block and cannot raise', () => {
    // No ready leaf beads BUT beads routed to verify => the sprint PROCEEDS.
    // The refusal block is guarded on preSprintVerifyIds being empty too, so a
    // verify-only sprint never reaches a throw site.
    assert.ok(
        RUNNER_SRC.includes('Proceeding as a verify-only sprint.'),
        'the verify-only log line must survive unchanged'
    );
    const guardAt = RUNNER_SRC.indexOf('if (initialBeads.length === 0 && preSprintVerifyIds.length === 0) {');
    assert.ok(
        guardAt > -1,
        'the refusal block must stay guarded on BOTH an empty ready set and an empty verify set'
    );
    for (const site of throwSitesFor(RUNNER_SRC, 'Pre-sprint validation failed:')) {
        assert.ok(
            site.index > guardAt,
            'every pre-sprint refusal must sit inside the "no ready AND no verify-routed beads" guard'
        );
    }
});

test('PreSprintValidationError carries its reason and the generic taxonomy still catches it', () => {
    const err = new PreSprintValidationError('Pre-sprint validation failed: nothing to do.', {
        reason: PRE_SPRINT_REFUSAL_REASONS.NOTHING_TO_DO,
        scope: 'apra-fleet-xyz',
    });

    assert.ok(err instanceof PreSprintValidationError);
    assert.ok(err instanceof WorkflowError, 'a caller that only knows the generic taxonomy must still catch it');
    assert.ok(err instanceof Error);
    assert.equal(err.reason, 'NOTHING_TO_DO');
    assert.equal(err.scope, 'apra-fleet-xyz');
    assert.equal(err.details.reason, 'NOTHING_TO_DO', 'the discriminator must also travel in details');
    assert.equal(err.code, 'PRE_SPRINT_VALIDATION');
});

test('a refusal with an unrecognized reason fails loudly at construction', () => {
    // The whole point of the type is the discriminator; an unlisted one would
    // be an untyped refusal wearing a typed name.
    assert.throws(
        () => new PreSprintValidationError('Pre-sprint validation failed: ...', { reason: 'SOMETHING_ELSE' }),
        (e) => e instanceof TypeError && /PRE_SPRINT_REFUSAL_REASONS/.test(e.message),
        'an out-of-vocabulary reason must throw'
    );
    assert.throws(
        () => new PreSprintValidationError('Pre-sprint validation failed: ...'),
        (e) => e instanceof TypeError,
        'an omitted reason must throw'
    );
});

test('a typed pre-sprint refusal still routes as a typed abort, for every reason', () => {
    // Behaviour preservation: abort.mjs classified these by their message
    // prefix while they were bare Errors. Typing them must not change which
    // terminal state the sprint reports.
    for (const reason of Object.values(PRE_SPRINT_REFUSAL_REASONS)) {
        const err = new PreSprintValidationError(
            `Pre-sprint validation failed: synthesized ${reason} case for scope 'x'.`,
            { reason, scope: 'x' }
        );
        assert.equal(isTypedAbortError(err), true, `${reason} must still classify as a typed abort`);
    }
});
