import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KB_BIBLE_COMMIT_HTTP_SKIP_REASON } from '../src/tools/kb-bible-commit.js';

// The fleet-sprint engine test pins the http skip reason as a literal (the SE
// package must not import from src/). This guard fails when the two drift.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SE_TEST = path.join(HERE, '..', 'packages', 'apra-fleet-se', 'test', 'kb-bible-commit-round.test.mjs');

describe('kb_bible_commit http skip reason stays in sync with the fleet-sprint test', () => {
  it('HTTP_SKIP_REASON in the SE test equals KB_BIBLE_COMMIT_HTTP_SKIP_REASON', () => {
    const source = fs.readFileSync(SE_TEST, 'utf-8');
    const match = /const HTTP_SKIP_REASON = '([^']*)';/.exec(source);
    expect(match, 'HTTP_SKIP_REASON literal not found in the SE test').not.toBeNull();
    expect(match![1]).toBe(KB_BIBLE_COMMIT_HTTP_SKIP_REASON);
  });
});
