import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../../src/paths.js';
import { _autoCommitEnabledForTest } from '../../src/tools/kb-export.js';

/**
 * USER DIRECTIVE 2026-08-11: the default is ON.
 *
 * Phase 1 of docs/superpowers/specs/2026-08-03-kb-trust-pipeline-design.md had
 * flipped it OFF, reasoning that kb_import's exemption from the D1 confidence
 * clamp is justified by the bible being "a git-reviewed, human-merged artifact",
 * which a bot commit nobody was asked to look at does not make true.
 *
 * What the KB audit of 2026-08-11 showed is that the opposite failure was the
 * real one: with the default off and nothing in the pipeline calling kb_export
 * at all, 1 of 17 repositories had a bible. Knowledge that was never written
 * down cannot be reviewed either. An auto-commit is a diff on a feature branch
 * that a human reads in the sprint's PR -- which is review, just later in the
 * loop than Phase 1 wanted it. The commit stays pathspec-scoped to the bible
 * file, keeps its own pm-kb identity, and is still never pushed automatically.
 *
 * autoCommitEnabled() is module-private, so this asserts the observable
 * contract: the default with no config, and that an explicit opt-out still works.
 */

const KB_CONFIG_PATH = path.join(FLEET_DIR, 'knowledge', 'config.json');
let saved: string | null = null;

// autoCommitEnabled() reads the config file on every call, so no module reload
// is needed -- each case just writes the config it wants and asks.
function readAutoCommit(): boolean {
  return _autoCommitEnabledForTest();
}

beforeEach(() => {
  saved = fs.existsSync(KB_CONFIG_PATH) ? fs.readFileSync(KB_CONFIG_PATH, 'utf-8') : null;
});

afterEach(() => {
  if (saved === null) {
    if (fs.existsSync(KB_CONFIG_PATH)) fs.unlinkSync(KB_CONFIG_PATH);
  } else {
    fs.writeFileSync(KB_CONFIG_PATH, saved);
  }
});

describe('kb_export auto-commit defaults to on', () => {
  it('auto-commits when no KB config file exists', () => {
    if (fs.existsSync(KB_CONFIG_PATH)) fs.unlinkSync(KB_CONFIG_PATH);
    expect(readAutoCommit()).toBe(true);
  });

  it('auto-commits when the config has no bible section', () => {
    fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ provider: 'sqlite' }));
    expect(readAutoCommit()).toBe(true);
  });

  // A malformed config must NOT silently start committing on the team's behalf:
  // "I could not read your settings" is the one case where the safe answer is
  // the conservative one, regardless of which way the default points.
  it('does not auto-commit when the config is malformed', () => {
    fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, '{ not json');
    expect(readAutoCommit()).toBe(false);
  });

  it('honours an explicit opt-in', () => {
    fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ bible: { autoCommit: true } }));
    expect(readAutoCommit()).toBe(true);
  });

  it('honours an explicit opt-out', () => {
    fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ bible: { autoCommit: false } }));
    expect(readAutoCommit()).toBe(false);
  });
});
