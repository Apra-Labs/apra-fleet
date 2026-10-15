// Engine prompt hygiene: no CI text reaches reviewers or the final review, the
// final review treats a CI-only leftover criterion as out of scope, plan-reviewer
// rejects CI-status criteria, and reviewer-output.json stays generic.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildReviewerPrompt, buildFinalVerdictPrompt } from '../fleet-sprint/prompts.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const norm = (s) => s.replace(/\s+/g, ' ');

const reviewerArgs = { beadIds: ['x-1'], acceptanceCriteriaJson: '[]', baseBranch: 'main', branch: 'feat/x', goal: 'P1/P2' };
const finalArgs = {
    targetIssues: ['x-1'], branch: 'feat/x', baseBranch: 'main', goal: 'P1/P2', cyclesRun: 1,
    closedCount: 1, openAtGoalCount: 0, deployFailures: [], integFailures: [],
};

describe('reviewer and final-review prompts carry no CI gate text', () => {
    test('buildReviewerPrompt takes no CI gate input: a passed ciGate changes nothing', () => {
        const base = buildReviewerPrompt(reviewerArgs);
        const withGate = buildReviewerPrompt({ ...reviewerArgs, ciGate: { outcome: 'PASS', workflow: 'ci.yml', branch: 'feat/x', headSha: 'abc' } });
        assert.equal(withGate, base);
        assert.doesNotMatch(base, /CI GATE|engine-verified|CI green/i);
    });
    test('the scope-wide reviewer prompt has no CI gate text either', () => {
        assert.doesNotMatch(buildReviewerPrompt({ ...reviewerArgs, beadIds: [] }), /CI GATE|engine-verified/i);
    });
});

describe('final-review prompt: CI-only leftover criterion is out of scope', () => {
    test('states a CI-status criterion is not a reason to FAIL (with and without unclosed verify beads)', () => {
        for (const extra of [{}, { unclosedVerifyIds: ['x-9'] }]) {
            const p = norm(buildFinalVerdictPrompt({ ...finalArgs, ...extra }));
            assert.match(p, /CI is out of scope for this verdict/);
            assert.match(p, /CI-status criterion[^.]*is NOT a reason to FAIL/);
        }
    });
});

describe('role prompts and schema', () => {
    test('plan-reviewer.md rejects a CI-status criterion on any bead', () => {
        const t = norm(fs.readFileSync(path.join(ROOT, 'apra-pm/agents/plan-reviewer.md'), 'utf8'));
        assert.match(t, /\*\*No CI-status criterion\*\*/);
        assert.match(t, /CI-status criterion on any bead is CHANGES_NEEDED/);
        assert.match(t, /all thirteen criteria/);
    });
    test('reviewer-output.json has no bead ids or target-specific names', () => {
        const t = fs.readFileSync(path.join(ROOT, 'apra-pm/agents/schemas/reviewer-output.json'), 'utf8');
        assert.doesNotMatch(t, /apra-fleet-[a-z0-9]+/i);
        assert.doesNotMatch(t, /Windows service registration|apra-fleet status|SqliteProvider|kbCaptureSchema/);
    });
    // The ci_gate sprint arg is wired (one CI run per sprint at Finalization,
    // awaited by Publish PR). The protection this test used to give -- CI
    // results never reach a doer/reviewer prompt -- is kept structurally: the
    // gate's record may flow ONLY into Publish PR's PR body, so ci-gate.mjs
    // may be imported only by runner.js (which starts the run) and
    // phases/publish-pr.mjs (which awaits and renders it), never by a prompt
    // builder or a dispatching phase.
    test('ci-gate.mjs is imported only by runner.js and phases/publish-pr.mjs -- never by a prompt builder', () => {
        const dir = path.join(ROOT, 'fleet-sprint');
        const importers = [];
        const walk = (d) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const f = path.join(d, e.name);
                if (e.isDirectory()) walk(f);
                else if (/\.(mjs|js)$/.test(e.name) && /from\s+['"](?:\.\.?\/)+ci-gate\.mjs['"]/.test(fs.readFileSync(f, 'utf8'))) {
                    importers.push(path.relative(dir, f).split(path.sep).join('/'));
                }
            }
        };
        walk(dir);
        assert.deepEqual(importers.sort(), ['phases/publish-pr.mjs', 'runner.js']);
    });
    test('no prompt builder or role prompt carries CI gate text', () => {
        const promptsSrc = fs.readFileSync(path.join(ROOT, 'fleet-sprint/prompts.mjs'), 'utf8');
        assert.doesNotMatch(promptsSrc, /ci_gate|ciGate|CI gate|formatCiGateReport/i);
        const agentsDir = path.join(ROOT, 'apra-pm/agents');
        const hits = [];
        const walk = (d) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const f = path.join(d, e.name);
                if (e.isDirectory()) walk(f);
                else if (/ci_gate|ciGate|CI gate/i.test(fs.readFileSync(f, 'utf8'))) hits.push(f);
            }
        };
        walk(agentsDir);
        assert.deepEqual(hits, []);
    });
});
