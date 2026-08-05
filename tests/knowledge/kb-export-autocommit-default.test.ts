import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FLEET_DIR } from '../../src/paths.js';
import { _autoCommitEnabledForTest } from '../../src/tools/kb-export.js';

/**
 * Phase 1 of docs/superpowers/specs/2026-08-03-kb-trust-pipeline-design.md.
 *
 * kb_export used to auto-commit the bible by default, as pm-kb <kb@pm.local>,
 * mid-sprint, on a feature branch. kb_import's sole exemption from the D1
 * confidence clamp is justified in-code by the bible being "a git-reviewed,
 * human-merged artifact" -- which a bot commit nobody was asked to look at does
 * not make true. The default must make that review possible, not pre-empt it.
 *
 * autoCommitEnabled() is module-private, so this asserts the observable
 * contract: the default with no config, and that an explicit opt-in still works.
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

describe('kb_export auto-commit defaults to off', () => {
  it('does not auto-commit when no KB config file exists', () => {
    if (fs.existsSync(KB_CONFIG_PATH)) fs.unlinkSync(KB_CONFIG_PATH);
    expect(readAutoCommit()).toBe(false);
  });

  it('does not auto-commit when the config has no bible section', () => {
    fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, JSON.stringify({ provider: 'sqlite' }));
    expect(readAutoCommit()).toBe(false);
  });

  it('does not auto-commit when the config is malformed', () => {
    fs.mkdirSync(path.dirname(KB_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(KB_CONFIG_PATH, '{ not json');
    expect(readAutoCommit()).toBe(false);
  });

  it('auto-commits only when explicitly opted in', () => {
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
