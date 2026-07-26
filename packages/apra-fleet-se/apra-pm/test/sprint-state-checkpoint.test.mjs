import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../.claude/workflows/auto-sprint.js'),
  'utf-8'
);

// Regression guard for the s10 failure: writeSprintState originally base64-encoded the
// state with Buffer.from(...) in the WORKFLOW BODY, but the Workflow sandbox exposes only
// standard JS built-ins -- Buffer/process/require are undefined there (like the Date.now
// ban). That threw "Buffer is not defined" at the first checkpoint and aborted the sprint.
// The body must encode with charCodeAt->hex and let the node subprocess decode.

test('auto-sprint.js does not call Buffer (unavailable in the workflow sandbox)', () => {
  // Matches executable use (Buffer.from / Buffer(...)) but not the word in a comment.
  assert.ok(!/Buffer\s*[.(]/.test(src),
    'the workflow must not call Buffer -- encode via charCodeAt/hex + String.fromCharCode instead');
});

test('writeSprintState encodes via hex + fromCharCode (sandbox-safe), not Buffer', () => {
  const start = src.indexOf('async function writeSprintState');
  const end = src.indexOf('async function clearSprintState');
  assert.ok(start >= 0 && end > start, 'writeSprintState must exist before clearSprintState');
  const fnSrc = src.slice(start, end);
  assert.ok(!/Buffer/.test(fnSrc), 'writeSprintState must not reference Buffer');
  assert.match(fnSrc, /charCodeAt\(/, 'writeSprintState must hex-encode in the body via charCodeAt');
  assert.match(fnSrc, /String\.fromCharCode\(/, 'the node subprocess must decode via String.fromCharCode');
});

test('the concurrency-lock + checkpoint helpers all exist', () => {
  for (const fn of ['sprintStateFileFor', 'readSprintState', 'writeSprintState', 'clearSprintState']) {
    assert.match(src, new RegExp(`function ${fn}\\b`), `${fn} must be defined`);
  }
  assert.match(src, /SPRINT_STATE_TTL_S\s*=\s*\d+/, 'a lock TTL constant must be defined');
});

test('sprintStateFileFor is branch-keyed and filename-safe', () => {
  // Extract just this pure helper and exercise it.
  const m = src.match(/function sprintStateFileFor\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert.ok(m, 'sprintStateFileFor source must be extractable');
  // eslint-disable-next-line no-new-func
  const fn = new Function(`${m[0]}; return sprintStateFileFor;`)();
  assert.equal(fn('feat/auth'), 'sprint-logs/.state/feat-auth.state.json');
  assert.equal(fn('pmlite-e2e/s10-123'), 'sprint-logs/.state/pmlite-e2e-s10-123.state.json');
  assert.match(fn('a/b\\c*d'), /^sprint-logs\/\.state\/[a-zA-Z0-9._-]+\.state\.json$/);
});
