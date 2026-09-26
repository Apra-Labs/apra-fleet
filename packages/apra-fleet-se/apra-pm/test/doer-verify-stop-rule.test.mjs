import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Verification for apra-fleet-gd0 (companion to the runtime defense tested by
// apra-fleet-33c.2). Transcript evidence (apra-fleet-k7b.4/k7b.6, sprint xuo,
// fleet-win-dev1, 2026-07-30): a doer closed both its assigned beads cleanly,
// then kept going ("let me do a final sanity check via advisor..."), burned
// its remaining turns on unrelated commands, and hit the max_turns ceiling
// WITHOUT ever emitting the VERIFY JSON -- turning a clean success into a
// falsely-reported FAILURE and a wasted resume dispatch. apra-fleet-gd0.1
// strengthened doer.md's Step 3 with an explicit STOP RULE. This test reads
// the live doer.md and asserts that rule is present in the VERIFY section
// specifically, so a future edit to this file cannot silently drop it again.
// Mirrors the markdown-guidance assertion pattern used elsewhere in this
// suite (e.g. doer-jit-close.test.mjs, pm-integ-scope.test.mjs) for pinning a
// prose directive against silent regression.

const __dir = dirname(fileURLToPath(import.meta.url));
const doerMd = readFileSync(join(__dir, '../agents/doer.md'), 'utf-8');

// Isolate the Step 3 / VERIFY checkpoint section (up to the next top-level
// heading) so these assertions can only pass if the directive lives where the
// bead requires -- inside Step 3 -- not just somewhere else in the file.
const step3Idx = doerMd.indexOf('## Step 3 -- VERIFY checkpoint');
assert.ok(step3Idx >= 0, 'doer.md must have a "## Step 3 -- VERIFY checkpoint" section');
const nextHeadingIdx = doerMd.indexOf('\n## ', step3Idx + 1);
const step3Section = nextHeadingIdx >= 0 ? doerMd.slice(step3Idx, nextHeadingIdx) : doerMd.slice(step3Idx);

test('doer.md Step 3 states the ONLY next action after the last bead closes is emitting the VERIFY JSON', () => {
  assert.match(
    step3Section,
    /ONLY next action[^.]*is emitting the VERIFY JSON/i,
    'Step 3 must state that the ONLY next action after the last close is emitting the VERIFY JSON'
  );
  // Anchored to the specific triggering event -- the last assigned bead being
  // closed (or its explicit-skip disposal) -- not a vaguer "when done" cue.
  assert.match(
    step3Section,
    /\bbd close\b[^.]*returns for your last assigned bead id/i,
    'Step 3 must tie the stop rule to the moment `bd close` returns for the last assigned bead id'
  );
});

test('doer.md Step 3 explicitly forbids advisor calls, sanity checks, and extra verification passes after the last close', () => {
  assert.match(
    step3Section,
    /no(t)? (call an )?advisor/i,
    'Step 3 must explicitly forbid calling an advisor/reviewer agent after the last close'
  );
  assert.match(
    step3Section,
    /sanity check/i,
    'Step 3 must explicitly forbid "one more sanity check" after the last close'
  );
  assert.match(
    step3Section,
    /(extra|further) verification pass|one more check/i,
    'Step 3 must explicitly forbid extra/further verification passes after the last close'
  );
});

test('doer.md Step 3 names the failure mode this rule prevents (burning turns past the last close into a false FAILURE)', () => {
  assert.match(
    step3Section,
    /burning turns after its last close/i,
    'Step 3 must name the failure mode: burning turns after the last close'
  );
  assert.match(
    step3Section,
    /recorded as a FAILURE|reported.*FAILURE|falsely[- ]reported FAILURE/i,
    'Step 3 must state that this failure mode converts a real success into a falsely-reported FAILURE'
  );
});
