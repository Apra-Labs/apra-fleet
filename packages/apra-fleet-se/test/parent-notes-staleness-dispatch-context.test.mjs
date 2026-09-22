import { test, describe } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectParentNotesStalenessNotes } from '../fleet-sprint/parent-notes-staleness.mjs';
import { buildPlannerPrompt, buildPlanReviewerPrompt } from '../fleet-sprint/prompts.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');

// =============================================================================
// apra-fleet-bkax.2 -- end-to-end coverage for the parent-NOTES staleness
// signal actually reaching the planner/plan-reviewer DISPATCH CONTEXT (the
// built prompt strings), not just the pure decision core already pinned by
// parent-notes-staleness.test.mjs. This file drives the real production
// chain -- collectParentNotesStalenessNotes() (fleet-sprint/parent-notes-
// staleness.mjs) feeding buildPlannerPrompt()/buildPlanReviewerPrompt()
// (fleet-sprint/prompts.mjs) -- from a stubbed `bd list --parent` / `bd
// history` transport, exactly as fleet-sprint/phases/plan.mjs wires them at
// runtime. Reverting the apra-fleet-fsxg tooling change (the timestamp
// comparison in parent-notes-staleness.mjs, or the stalenessNotes threading
// in prompts.mjs) makes the positive-case assertions below fail.
// =============================================================================

// A `bd history <id> --json` snapshot: newest first, matching real `bd
// history` shape (see parent-notes-staleness.test.mjs's identical helper).
function hist(entries) {
    return entries.map(({ date, notes }) => ({
        CommitHash: `${date}-hash`,
        CommitDate: date,
        Issue: { id: 'x', notes },
    }));
}

// Minimal stub of the injected command() + parseBdJson() seam, dispatching by
// inspecting the bd command label -- same shape plan.mjs passes at runtime.
function makeStub({ childrenById, historyById }) {
    const command = async (label) => {
        if (label.startsWith('bd list --parent ')) {
            const id = label.split(' ')[3];
            return { value: childrenById[id] || [] };
        }
        if (label.startsWith('bd history ')) {
            const id = label.split(' ')[2];
            return { value: historyById[id] || [] };
        }
        throw new Error(`unexpected label: ${label}`);
    };
    const parseBdJson = (raw) => raw.value;
    return { command, parseBdJson };
}

const basePlannerOpts = {
    isDeltaCycle: false,
    targetIssues: ['stale', 'fresh', 'leaf'],
    goal: 'P1/P2',
    requirementsFile: undefined,
    requirementsContent: null,
    feedback: null,
};

const basePlanReviewerOpts = {
    targetIssues: ['stale', 'fresh', 'leaf'],
    goal: 'P1/P2',
};

describe('parent-NOTES staleness signal reaches the planner/plan-reviewer dispatch context', () => {
    // Positive case: `stale`'s NOTES were last changed (12:00) strictly AFTER
    // its most recently created child (10:00).
    // Negative case A: `fresh`'s NOTES (09:00) predate its child (20:00) --
    // the common case, must NOT false-positive.
    // Negative case B: `leaf` has no children at all.
    const { command, parseBdJson } = makeStub({
        childrenById: {
            stale: [{ id: 'stale.1', created_at: '2026-09-15T10:00:00Z' }],
            fresh: [{ id: 'fresh.1', created_at: '2026-09-15T20:00:00Z' }],
            leaf: [],
        },
        historyById: {
            stale: hist([{ date: '2026-09-15T12:00:00Z', notes: 'CORRECTION: do X not Y' }]),
            fresh: hist([{ date: '2026-09-15T09:00:00Z', notes: 'early note' }]),
        },
    });

    test('positive case: dispatch context contains a visible, correctly-worded staleness note', async () => {
        const stalenessNotes = await collectParentNotesStalenessNotes({
            command,
            member: 'orchestrator',
            rootIds: ['stale', 'fresh', 'leaf'],
            parseBdJson,
        });
        assert.strictEqual(stalenessNotes.length, 1, 'only the stale bead should produce a note');

        const plannerPrompt = buildPlannerPrompt({ ...basePlannerOpts, stalenessNotes });
        const reviewerPrompt = buildPlanReviewerPrompt({ ...basePlanReviewerOpts, stalenessNotes });

        for (const prompt of [plannerPrompt, reviewerPrompt]) {
            assert.match(prompt, /TOOLING-COMPUTED STALENESS SIGNAL/);
            assert.match(prompt, /Bead stale/);
            assert.match(prompt, /2026-09-15T12:00:00Z/); // the notes-changed timestamp
            assert.match(prompt, /stale\.1, created 2026-09-15T10:00:00Z/); // most recent child named
            assert.match(prompt, /authoritative/i);
            // Must NOT name the beads that are not stale.
            assert.doesNotMatch(prompt, /Bead fresh/);
            assert.doesNotMatch(prompt, /Bead leaf/);
        }
    });

    test('negative case A: notes predating the most recent child produce no dispatch-context note', async () => {
        const stalenessNotes = await collectParentNotesStalenessNotes({
            command,
            member: 'orchestrator',
            rootIds: ['fresh'],
            parseBdJson,
        });
        assert.deepStrictEqual(stalenessNotes, []);

        const plannerPrompt = buildPlannerPrompt({ ...basePlannerOpts, targetIssues: ['fresh'], stalenessNotes });
        const reviewerPrompt = buildPlanReviewerPrompt({ ...basePlanReviewerOpts, targetIssues: ['fresh'], stalenessNotes });
        for (const prompt of [plannerPrompt, reviewerPrompt]) {
            assert.doesNotMatch(prompt, /TOOLING-COMPUTED STALENESS SIGNAL/);
        }
    });

    test('negative case B: a childless bead produces no dispatch-context note', async () => {
        const stalenessNotes = await collectParentNotesStalenessNotes({
            command,
            member: 'orchestrator',
            rootIds: ['leaf'],
            parseBdJson,
        });
        assert.deepStrictEqual(stalenessNotes, []);

        const plannerPrompt = buildPlannerPrompt({ ...basePlannerOpts, targetIssues: ['leaf'], stalenessNotes });
        const reviewerPrompt = buildPlanReviewerPrompt({ ...basePlanReviewerOpts, targetIssues: ['leaf'], stalenessNotes });
        for (const prompt of [plannerPrompt, reviewerPrompt]) {
            assert.doesNotMatch(prompt, /TOOLING-COMPUTED STALENESS SIGNAL/);
        }
    });

    test('the common case (no stalenessNotes arg at all) leaves both prompts unchanged', () => {
        const plannerPrompt = buildPlannerPrompt({ ...basePlannerOpts });
        const reviewerPrompt = buildPlanReviewerPrompt({ ...basePlanReviewerOpts });
        for (const prompt of [plannerPrompt, reviewerPrompt]) {
            assert.doesNotMatch(prompt, /TOOLING-COMPUTED STALENESS SIGNAL/);
        }
    });

    test('injected block is generic (no target-repo/bead-tracker literals baked into the wording) and advisory-only', async () => {
        const stalenessNotes = await collectParentNotesStalenessNotes({
            command,
            member: 'orchestrator',
            rootIds: ['stale'],
            parseBdJson,
        });
        const plannerPrompt = buildPlannerPrompt({ ...basePlannerOpts, targetIssues: ['stale'], stalenessNotes });

        // The block's own wording (everything up to the first interpolated
        // note) must never hardcode a target-repo/tracker-specific literal.
        const blockStart = plannerPrompt.indexOf('TOOLING-COMPUTED STALENESS SIGNAL');
        const headerOnly = plannerPrompt.slice(blockStart, plannerPrompt.indexOf('1. Bead stale'));
        assert.ok(!/apra-fleet/i.test(headerOnly), 'staleness block header must not name a specific target repo');

        // Advisory only: the block says so explicitly, and never uses
        // blocking/failing language toward the dispatch itself.
        assert.match(plannerPrompt, /ADVISORY ONLY/);
        assert.doesNotMatch(plannerPrompt, /must (block|fail|reject) (this|the) (dispatch|plan)/i);
    });
});

test('generic-boundary guard exits 0 after the staleness-signal wiring', () => {
    const scriptPath = path.join(PACKAGE_ROOT, 'scripts/check-generic-boundary.mjs');
    const out = execFileSync('node', [scriptPath], { cwd: PACKAGE_ROOT, encoding: 'utf8' });
    assert.match(out, /OK: no apra-fleet-specific assumptions/);
});
