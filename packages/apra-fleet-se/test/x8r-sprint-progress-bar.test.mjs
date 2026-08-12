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

    test('the viewer renders the progress-bar markup and the exact M/N text for a sample sprint', () => {
        const progress = computeSprintProgress(beads);
        const html = renderProgressBarHtml(progress);
        assert.ok(html.includes('sprint-progress'), 'bar markup (sprint-progress container) must be present');
        assert.ok(html.includes('>2/3<'), `expected the literal M/N text '2/3' in: ${html}`);
    });

    test('fails if the bar or the M/N text is removed', () => {
        const progress = computeSprintProgress(beads);
        const html = renderProgressBarHtml(progress);
        assert.ok(/class="sprint-progress"/.test(html), 'bar container class must be present');
        assert.match(html, /\d+\/\d+/, 'numeric M/N text must be present');
    });

    test('counts rendered come from the shared helper -- same numbers as calling it directly on the same fixture', () => {
        const progress = computeSprintProgress(beads);
        const html = renderProgressBarHtml(progress);
        assert.ok(html.includes(`>${progress.closed}/${progress.required}<`));
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
        assert.ok(html.includes('>1/2<'));
        assert.ok(html.includes('>3/3<'));
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
        assert.ok(html.includes(`>${progress.closed}/${progress.required}<`));
    });
});
