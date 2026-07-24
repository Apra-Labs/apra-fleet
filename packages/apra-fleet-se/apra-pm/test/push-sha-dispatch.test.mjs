import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// ---- merged push + head-sha dispatch (apra-pm-mhq) ---------------------------

test('push-sha dispatch uses dispatchShell with both git push and git rev-parse HEAD', () => {
  // Locate the push-sha dispatch by its label.
  const labelIdx = src.indexOf("label: `push-sha-c${cycleCount}`");
  assert.ok(labelIdx >= 0, 'push-sha dispatch must exist in source with label push-sha-c${cycleCount}');

  // Look back to find the command array passed to dispatchShell.
  const region = src.slice(Math.max(0, labelIdx - 500), labelIdx);
  assert.match(region, /git push origin/, 'push-sha dispatch must include "git push origin"');
  assert.match(region, /git rev-parse HEAD/, 'push-sha dispatch must include "git rev-parse HEAD"');
  assert.match(region, /dispatchShell\s*\(/, 'push-sha must use dispatchShell (not raw dispatch)');
});

test('push-sha dispatch commands are an array (both commands in one dispatchShell call)', () => {
  const labelIdx = src.indexOf("label: `push-sha-c${cycleCount}`");
  // Find the dispatchShell( call by scanning backward.
  const regionBefore = src.slice(Math.max(0, labelIdx - 500), labelIdx);
  const dispatchIdx = regionBefore.lastIndexOf('dispatchShell(');
  assert.ok(dispatchIdx >= 0, 'dispatchShell call must precede push-sha label');

  // Between dispatchShell( and the label, there should be an array literal [...].
  const between = regionBefore.slice(dispatchIdx);
  assert.match(between, /\[\s*[\n\r\s]*`git push/, 'commands must be passed as an array starting with git push');
  assert.match(between, /`git rev-parse HEAD`/, 'commands array must include git rev-parse HEAD');
});

test('headSha is parsed from pushShaResult.outputs[1] (index 1 = second command output)', () => {
  const pushShaResultIdx = src.indexOf('const pushShaResult = await dispatchShell(');
  assert.ok(pushShaResultIdx >= 0, 'pushShaResult assignment must exist');

  // Find headSha assignment after pushShaResult.
  const afterDispatch = src.slice(pushShaResultIdx, pushShaResultIdx + 400);
  assert.match(afterDispatch, /pushShaResult\.outputs\s*\[\s*1\s*\]/,
    'headSha must be parsed from pushShaResult.outputs[1]');
  assert.match(afterDispatch, /headSha\s*=\s*pushShaResult\.outputs\[1\]\.trim\(\)/,
    'headSha assignment must call .trim() on outputs[1]');
});

test('SHA_SCHEMA is not used anywhere in source (separate SHA dispatch removed)', () => {
  assert.doesNotMatch(src, /SHA_SCHEMA/,
    'SHA_SCHEMA must not exist in source -- it was replaced by the merged push-sha dispatchShell');
});

test('push-sha dispatch does not use a separate awaited dispatch with a schema for SHA only', () => {
  // Confirm there is no schema containing "sha" used in a standalone dispatch near the push code.
  // The only way to get headSha must be via pushShaResult from dispatchShell.
  const shaSchemaPattern = /schema:\s*\{[^}]*sha[^}]*\}/i;
  assert.doesNotMatch(src, shaSchemaPattern,
    'No separate SHA-extracting schema dispatch should exist');
});
