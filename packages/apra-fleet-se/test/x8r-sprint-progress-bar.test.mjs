import { test, describe } from 'node:test';
import assert from 'node:assert';

// apra-fleet-x8r.3: single consolidating test file for the beads-closed/
// required progress-bar widget end to end -- the shared helper's math, the
// fleet-sprint viewer's render path, and the supervisor dashboard's Sprint
// Stack render path -- so a regression in ANY one of those three surfaces
// (or a removal of the bar/M-N text itself) fails a test in one obvious
// place, rather than relying on scattered coverage across unrelated files.
import { computeSprintProgress } from '../fleet-sprint/sprint-progress.mjs';
import { renderProgressBarHtml } from '../fleet-sprint/viewer-extensions.mjs';
import { renderSprintStackHtml } from '../src/supervisor/dashboard.mjs';

describe('x8r: computeSprintProgress -- shared helper math', () => {
    const beads = [
        { id: 'a', status: 'closed' },
        { id: 'b', status: 'open' },
        { id: 'c', status: 'closed' },
        { id: 'd', status: 'in_progress' },
    ];

    test('closed/required/fraction over a synthetic scoped bead list', () => {
        assert.deepStrictEqual(computeSprintProgress(beads), { closed: 2, required: 4, fraction: 0.5 });
    });

    test('required=0 edge case: empty scope never divides by zero -- no throw, no NaN', () => {
        assert.doesNotThrow(() => computeSprintProgress([]));
        const result = computeSprintProgress([]);
        assert.deepStrictEqual(result, { closed: 0, required: 0, fraction: 0 });
        assert.ok(Number.isFinite(result.fraction), 'fraction must be finite, never NaN');
    });
});

describe('x8r: fleet-sprint viewer render path -- bar markup + M/N text', () => {
    const beads = [
        { id: 'a', status: 'closed' },
        { id: 'b', status: 'open' },
        { id: 'c', status: 'closed' },
    ];

    test('the viewer renders the progress-bar markup and the exact labeled M/N text for a sample sprint', () => {
        const progress = computeSprintProgress(beads);
        const html = renderProgressBarHtml(progress);
        assert.ok(html.includes('sprint-progress'), 'bar markup (sprint-progress container) must be present');
        // apra-fleet-vk0a.1: labeled 'Required: M/N' -- distinct from the
        // beads tree's OWN, differently-scoped 'All tasks (incl. backlog)'
        // count that sits directly below it in the Tasks tab.
        assert.ok(html.includes('>Required: 2/3<'), `expected the literal labeled M/N text 'Required: 2/3' in: ${html}`);
    });

    test('fails if the bar or the M/N text is removed', () => {
        const progress = computeSprintProgress(beads);
        const html = renderProgressBarHtml(progress);
        assert.ok(/class="sprint-progress"/.test(html), 'bar container class must be present');
        assert.match(html, /Required: \d+\/\d+/, 'labeled numeric M/N text must be present');
    });

    test('counts rendered come from the shared helper -- same numbers as calling it directly on the same fixture', () => {
        const progress = computeSprintProgress(beads);
        const html = renderProgressBarHtml(progress);
        assert.ok(html.includes(`>Required: ${progress.closed}/${progress.required}<`));
    });
});

describe('x8r: supervisor dashboard Sprint Stack render path -- one bar per row', () => {
    function sprintView(sprintId, progress) {
        return {
            sprintId,
            status: 'RUNNING_HEALTHY',
            branch: 'feat/x',
            goal: 'P1/P2',
            beadCount: progress ? progress.required : 0,
            issueRoots: ['root'],
            members: [],
            progress,
        };
    }

    test('renders one progress bar (and its M/N text) per active sprint row', () => {
        const views = [
            sprintView('sprint-a', { closed: 1, required: 2, fraction: 0.5 }),
            sprintView('sprint-b', { closed: 3, required: 3, fraction: 1 }),
        ];
        const html = renderSprintStackHtml(views);
        const barCount = (html.match(/class="sprint-progress"/g) || []).length;
        assert.equal(barCount, 2, 'expected exactly one progress bar per active sprint row');
        assert.ok(html.includes('>Required: 1/2<'));
        assert.ok(html.includes('>Required: 3/3<'));
    });

    test('a row with unavailable progress renders the neutral placeholder, not a bar, and never throws', () => {
        const views = [sprintView('sprint-c', null)];
        assert.doesNotThrow(() => renderSprintStackHtml(views));
        const html = renderSprintStackHtml(views);
        assert.ok(html.toLowerCase().includes('progress unavailable'));
        assert.ok(!html.includes('class="sprint-progress"'));
    });

    test('the dashboard counts rendered come from the shared helper directly (same numbers on the same fixture)', () => {
        const beads = [
            { id: 'a', status: 'closed' },
            { id: 'b', status: 'closed' },
            { id: 'c', status: 'open' },
        ];
        const progress = computeSprintProgress(beads);
        const views = [sprintView('sprint-d', progress)];
        const html = renderSprintStackHtml(views);
        assert.ok(html.includes(`>Required: ${progress.closed}/${progress.required}<`));
    });

    // apra-fleet-vk0a.4: the SAME row stacks the progress bar's 'Required:
    // M/N' (goal+decomposedParentIds-filtered) directly above the row's raw
    // 'Claimed scope' bead count (unfiltered live subtree size,
    // apra-fleet-vk0a.3) -- two different definitions of "how many beads"
    // that legitimately diverge (the raw scope count grows over a sprint's
    // life as planners/reviewers add tasks; the filtered Required count does
    // not). Both must carry their own explicit label in the SAME rendered
    // row so an operator reads them as two intentionally different numbers,
    // not a disagreement/bug.
    test('apra-fleet-vk0a.4: within one row, the progress-bar M/N and the Claimed-scope count are each labeled and can legitimately differ', () => {
        const view = {
            sprintId: 'sprint-e',
            status: 'RUNNING_HEALTHY',
            branch: 'feat/x',
            goal: 'P1',
            // Deliberately different from progress.required (3) -- the raw,
            // unfiltered scope has grown past what the goal-filtered
            // progress bar counts.
            beadCount: 9,
            issueRoots: ['root'],
            members: [],
            progress: { closed: 1, required: 3, fraction: 1 / 3 },
        };
        const html = renderSprintStackHtml([view]);
        assert.ok(html.includes('>Required: 1/3<'), `expected the labeled progress-bar text in: ${html}`);
        assert.ok(
            html.includes('9 bead(s) total in scope, unfiltered'),
            `expected the labeled claimed-scope text in: ${html}`,
        );
    });
});
