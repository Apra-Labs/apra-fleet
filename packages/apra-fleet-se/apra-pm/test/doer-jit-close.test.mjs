import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));

const doerMd = readFileSync(join(__dir, '../agents/doer.md'), 'utf-8');
const src = readFileSync(join(__dir, '../.claude/workflows/auto-sprint.js'), 'utf-8');

// ---- agents/doer.md assertions -----------------------------------------------

test('doer.md instructs closing each task with bd close before the next task', () => {
  // Must mention "bd close" in the context of closing before the next task.
  assert.match(doerMd, /bd close/,
    'doer.md must contain a "bd close" instruction');

  // Must contain wording about closing before claiming/moving to the next task.
  assert.match(doerMd, /BEFORE claiming the next|close.*before.*next|Close.*immediately/i,
    'doer.md must instruct closing each task before moving to the next one');
});

test('doer.md has JIT-close rule in the Rules section', () => {
  // The rules section should reinforce the close-before-next pattern.
  const rulesIdx = doerMd.indexOf('## Rules');
  assert.ok(rulesIdx >= 0, '"## Rules" section must exist in doer.md');

  const rulesSection = doerMd.slice(rulesIdx);
  assert.match(rulesSection, /[Cc]lose.*task.*before|BEFORE claiming/,
    '"## Rules" section must include the close-before-next instruction');
});

// ---- auto-sprint.js doer dispatch prompt assertions --------------------------

test('doer dispatch prompt (doer-c label) contains "bd close <id>" instruction', () => {
  // Find the doer dispatch block by locating the doerLabel assignment near 'doer-c'.
  const doerLabelIdx = src.indexOf("'doer-c");
  assert.ok(doerLabelIdx >= 0, 'doer label template string must exist in auto-sprint.js');

  // Find the dispatch call that follows the doerLabel assignment.
  const dispatchIdx = src.indexOf('doerResult = await dispatch(', doerLabelIdx);
  assert.ok(dispatchIdx >= 0, 'doerResult dispatch call must follow the doerLabel assignment');

  // Extract the prompt region (from dispatch call to its closing paren region).
  const promptRegion = src.slice(dispatchIdx, dispatchIdx + 1500);

  assert.match(promptRegion, /bd close <id>/,
    'doer dispatch prompt must contain "bd close <id>" instruction');
});

test('doer dispatch prompt orders bd close before claiming the next task', () => {
  const dispatchIdx = src.indexOf('doerResult = await dispatch(');
  assert.ok(dispatchIdx >= 0, 'doerResult dispatch call must exist in auto-sprint.js');

  const promptRegion = src.slice(dispatchIdx, dispatchIdx + 1500);

  // The close instruction must appear and must reference ordering before next task.
  assert.match(promptRegion, /bd close.*BEFORE claiming the next|bd close.*before.*next/i,
    'doer dispatch prompt must instruct closing before claiming the next task');
});
