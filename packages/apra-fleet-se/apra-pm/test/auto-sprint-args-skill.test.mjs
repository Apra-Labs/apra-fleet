import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  claudeOnlyPermissions, uninstall, argsSkillSrc, argsSkillDest, ARGS_SKILL_NAME,
} from '../install.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dir, '..');
const agentsSrc = path.join(REPO_ROOT, 'agents');

// The installer must know how to install the auto-sprint-args helper skill: the
// permission is granted (claude-only), the source ships in the repo, and uninstall
// removes exactly the installed skill dir (and only for Claude).

test('claude permissions include Skill(auto-sprint-args)', () => {
  assert.ok(claudeOnlyPermissions().includes('Skill(auto-sprint-args)'),
    'installer must grant Skill(auto-sprint-args) so the skill invocation is not prompted');
});

test('auto-sprint-args skill source ships in the repo with valid frontmatter', () => {
  const src = argsSkillSrc(REPO_ROOT);
  assert.equal(ARGS_SKILL_NAME, 'auto-sprint-args');
  const skillMd = path.join(src, 'SKILL.md');
  assert.ok(fs.existsSync(skillMd), `${skillMd} must exist so the installer can copy it`);
  const body = fs.readFileSync(skillMd, 'utf-8');
  const fm = body.match(/^---\s*\n([\s\S]*?)\n---/);
  assert.ok(fm, 'SKILL.md must start with YAML frontmatter');
  assert.match(fm[1], /name:\s*auto-sprint-args/, 'frontmatter name must be auto-sprint-args');
  assert.match(fm[1], /description:\s*\S/, 'frontmatter must have a non-empty description for discovery');
});

test('uninstall removes the installed auto-sprint-args skill dir for Claude', () => {
  const cfg = { name: 'Claude', configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pm-argsskill-')), settingsFile: 'settings.json' };
  const dest = argsSkillDest(cfg);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'SKILL.md'), '---\nname: auto-sprint-args\n---\nbody');
  const removed = uninstall(cfg, agentsSrc);
  assert.equal(removed.argsSkill, true);
  assert.equal(fs.existsSync(dest), false);
  fs.rmSync(cfg.configDir, { recursive: true, force: true });
});

test('uninstall does NOT touch an auto-sprint-args dir for non-Claude providers', () => {
  const cfg = { name: 'Gemini', configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'pm-argsskill-g-')), settingsFile: 'settings.json' };
  const dest = argsSkillDest(cfg);
  fs.mkdirSync(dest, { recursive: true });
  fs.writeFileSync(path.join(dest, 'SKILL.md'), 'stray');
  const removed = uninstall(cfg, agentsSrc);
  assert.equal(removed.argsSkill, false, 'non-claude uninstall must not report an args-skill removal');
  assert.equal(fs.existsSync(dest), true, 'non-claude uninstall must leave the dir untouched');
  fs.rmSync(cfg.configDir, { recursive: true, force: true });
});
