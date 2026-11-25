// =============================================================================
// Prompt contract: a cross-feature dependency targets the PRODUCING TASK, never
// the feature. A `blocks` edge onto a feature (or any bead with children)
// starves its dependents whenever the Integration Test phase cannot run, since
// only that phase closes an all-children-closed feature.
//
// Reads the shipped role prompts directly. Assertions key on short stable
// phrases inside the section that must carry them (planner Step 3 wiring rules,
// planner Step 4 checklist, plan-reviewer criterion 5), so wording polish does
// not break them but removing the rule does: reverting the planner.md /
// plan-reviewer.md edits fails every test below.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = path.resolve(__dirname, '..', 'apra-pm', 'agents');
const read = (name) => fs.readFileSync(path.join(AGENTS_DIR, name), 'utf8');
// Markdown wraps mid-sentence: match against whitespace-collapsed text.
const norm = (s) => s.replace(/\s+/g, ' ');

/** The text between the first `start` match and the next `end` match. */
const section = (text, start, end) => {
    const from = text.search(start);
    assert.ok(from >= 0, `section start ${start} not found`);
    const rest = text.slice(from);
    const to = rest.slice(1).search(end);
    return to >= 0 ? rest.slice(0, to + 1) : rest;
};

const planner = read('planner.md');
const plannerWiring = norm(section(planner, /^## Step 3 /m, /^## Step 4 /m));
const plannerChecklist = norm(section(planner, /^## Step 4 /m, /^## /m));
const reviewer = read('plan-reviewer.md');
const reviewerWiring = norm(section(reviewer, /^5\. \*\*Dependency wiring\*\*/m, /^6\. \*\*/m));

test('planner.md Step 3: a cross-feature dependency targets the producing task, not the feature', () => {
    assert.match(plannerWiring, /producing task/i, 'the wiring rules must name the producing task as the target');
    assert.match(plannerWiring, /never the feature/i, 'the wiring rules must forbid targeting the feature itself');
    assert.match(plannerWiring, /sibling feature/i, 'the rule must cover a blocks edge onto a sibling feature');
    assert.match(plannerWiring, /bead that has children|bead with children|childful/i,
        'the rule must cover any bead with children, not only features');
});

test('planner.md Step 3: the rule gives the generic reason (Integration Test closes the feature; a failed deploy starves dependents)', () => {
    assert.match(plannerWiring, /Integration Test phase/, 'the reason must name the Integration Test phase');
    assert.match(plannerWiring, /starves/i, 'the reason must say the edge starves its dependents');
    assert.match(plannerWiring, /failed deploy/i, 'the reason must give the failed-deploy example');
});

test('planner.md Step 4: the self-check list covers a blocks edge onto a feature/childful bead', () => {
    assert.match(plannerChecklist, /`blocks` edge whose target/i, 'the checklist must ask about a blocks edge target');
    assert.match(plannerChecklist, /bead with children|childful/i, 'the checklist must name a feature or bead with children');
    assert.match(plannerChecklist, /producing task/i, 'the checklist must give the retarget fix');
});

test('plan-reviewer.md criterion 5: a blocks edge onto a feature/childful bead is a finding with the retarget fix', () => {
    assert.match(reviewerWiring, /target \(the depends-on side\) is a feature/i,
        'criterion 5 must name a blocks edge whose target is a feature');
    assert.match(reviewerWiring, /bead with children|childful/i, 'criterion 5 must cover any bead with children');
    assert.match(reviewerWiring, /ALWAYS a finding[^.]*dependency_wiring|dependency_wiring[^.]*finding/i,
        'it must be raised as a dependency_wiring finding');
    assert.match(reviewerWiring, /retarget[^.]*producing task/i, 'the finding must carry the retarget-to-producing-task fix');
});
