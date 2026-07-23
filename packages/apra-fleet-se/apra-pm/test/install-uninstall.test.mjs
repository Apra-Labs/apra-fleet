import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { uninstall, requiredPermissions, claudeOnlyPermissions } from '../install.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dir, '..');
const agentsSrc = path.join(REPO_ROOT, 'agents');

// Builds a synthetic <configDir> that looks like what install() would have
// produced, plus some content of the user's own that must survive uninstall.
// Using a plain { name, configDir, settingsFile } cfg object (rather than
// providerConfig()) keeps this test independent of the real home directory.
function seedInstalledConfigDir(cfg, { withCustomExtras = true } = {}) {
  fs.mkdirSync(path.join(cfg.configDir, 'skills', 'pm'), { recursive: true });
  fs.writeFileSync(path.join(cfg.configDir, 'skills', 'pm', 'SKILL.md'), 'skill body');
  fs.writeFileSync(path.join(cfg.configDir, 'skills', 'pm', 'cost.js'), '// cost fns');

  fs.mkdirSync(path.join(cfg.configDir, 'agents'), { recursive: true });
  for (const f of fs.readdirSync(agentsSrc).filter((f) => f.endsWith('.md'))) {
    fs.copyFileSync(path.join(agentsSrc, f), path.join(cfg.configDir, 'agents', f));
  }

  const schemasSrc = path.join(agentsSrc, 'schemas');
  if (fs.existsSync(schemasSrc)) {
    fs.mkdirSync(path.join(cfg.configDir, 'agents', 'schemas'), { recursive: true });
    for (const f of fs.readdirSync(schemasSrc).filter((f) => f.endsWith('.json'))) {
      fs.copyFileSync(path.join(schemasSrc, f), path.join(cfg.configDir, 'agents', 'schemas', f));
    }
  }

  const perms = [...requiredPermissions(cfg)];
  if (cfg.name === 'Claude') perms.push(...claudeOnlyPermissions());
  if (withCustomExtras) {
    fs.writeFileSync(path.join(cfg.configDir, 'agents', 'my-custom-agent.md'), 'a user agent, not ours');
    perms.push('Bash(npm:*)'); // a permission the user configured themselves
  }
  fs.writeFileSync(path.join(cfg.configDir, cfg.settingsFile), JSON.stringify({ permissions: { allow: perms } }, null, 2));

  if (cfg.name === 'Claude') {
    fs.mkdirSync(path.join(cfg.configDir, 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(cfg.configDir, 'workflows', 'auto-sprint.js'), '// auto-sprint');
    fs.mkdirSync(path.join(cfg.configDir, 'skills', 'auto-sprint-args'), { recursive: true });
    fs.writeFileSync(path.join(cfg.configDir, 'skills', 'auto-sprint-args', 'SKILL.md'), '---\nname: auto-sprint-args\n---\nbody');
    if (withCustomExtras) {
      fs.writeFileSync(path.join(cfg.configDir, 'workflows', 'my-other-workflow.js'), 'keep me');
    }
  }

  return perms;
}

function makeTmpCfg(name = 'Claude') {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-uninstall-test-'));
  return { name, configDir, settingsFile: 'settings.json' };
}

test('uninstall() removes the whole skills/pm directory', () => {
  const cfg = makeTmpCfg();
  seedInstalledConfigDir(cfg);
  const removed = uninstall(cfg, agentsSrc);
  assert.equal(removed.skill, true);
  assert.equal(fs.existsSync(path.join(cfg.configDir, 'skills', 'pm')), false);
  fs.rmSync(cfg.configDir, { recursive: true, force: true });
});

test('uninstall() removes only the agent files it installed, leaving the user\'s own agent', () => {
  const cfg = makeTmpCfg();
  seedInstalledConfigDir(cfg);
  const removed = uninstall(cfg, agentsSrc);
  const expected = fs.readdirSync(agentsSrc).filter((f) => f.endsWith('.md'));
  assert.deepEqual([...removed.agents].sort(), [...expected].sort());
  assert.equal(fs.existsSync(path.join(cfg.configDir, 'agents', 'my-custom-agent.md')), true, 'user agent must survive');
  for (const f of expected) {
    assert.equal(fs.existsSync(path.join(cfg.configDir, 'agents', f)), false, `${f} should be removed`);
  }
  fs.rmSync(cfg.configDir, { recursive: true, force: true });
});

test('uninstall() removes agents/schemas (apra-fleet-unw.21)', () => {
  const cfg = makeTmpCfg();
  seedInstalledConfigDir(cfg);
  assert.equal(fs.existsSync(path.join(cfg.configDir, 'agents', 'schemas')), true, 'test setup: schemas should have been seeded');
  const removed = uninstall(cfg, agentsSrc);
  assert.equal(removed.schemas, true);
  assert.equal(fs.existsSync(path.join(cfg.configDir, 'agents', 'schemas')), false);
  fs.rmSync(cfg.configDir, { recursive: true, force: true });
});

test('uninstall() removes only the permissions it added, leaving user-added permissions', () => {
  const cfg = makeTmpCfg();
  const perms = seedInstalledConfigDir(cfg);
  uninstall(cfg, agentsSrc);
  const settings = JSON.parse(fs.readFileSync(path.join(cfg.configDir, 'settings.json'), 'utf-8'));
  assert.ok(settings.permissions.allow.includes('Bash(npm:*)'), 'user permission must survive');
  const installedPerms = new Set([...requiredPermissions(cfg), ...claudeOnlyPermissions()]);
  for (const p of settings.permissions.allow) {
    assert.equal(installedPerms.has(p), false, `installed permission "${p}" should have been removed`);
  }
  fs.rmSync(cfg.configDir, { recursive: true, force: true });
});

test('uninstall() removes the claude auto-sprint workflow but leaves other workflow files', () => {
  const cfg = makeTmpCfg('Claude');
  seedInstalledConfigDir(cfg);
  const removed = uninstall(cfg, agentsSrc);
  assert.equal(removed.workflow, true);
  assert.equal(fs.existsSync(path.join(cfg.configDir, 'workflows', 'auto-sprint.js')), false);
  assert.equal(fs.existsSync(path.join(cfg.configDir, 'workflows', 'my-other-workflow.js')), true);
  fs.rmSync(cfg.configDir, { recursive: true, force: true });
});

test('uninstall() removes the auto-sprint-args skill for Claude', () => {
  const cfg = makeTmpCfg('Claude');
  seedInstalledConfigDir(cfg);
  const removed = uninstall(cfg, agentsSrc);
  assert.equal(removed.argsSkill, true);
  assert.equal(fs.existsSync(path.join(cfg.configDir, 'skills', 'auto-sprint-args')), false);
  // the pm skill and the user's custom agent must still have been handled as before
  assert.equal(fs.existsSync(path.join(cfg.configDir, 'skills', 'pm')), false);
  fs.rmSync(cfg.configDir, { recursive: true, force: true });
});

test('uninstall() does not touch workflows for non-claude providers', () => {
  const cfg = makeTmpCfg('Gemini');
  seedInstalledConfigDir(cfg);
  const removed = uninstall(cfg, agentsSrc);
  assert.equal(removed.workflow, false);
  fs.rmSync(cfg.configDir, { recursive: true, force: true });
});

test('uninstall() is a safe no-op when nothing was ever installed', () => {
  const cfg = makeTmpCfg();
  fs.mkdirSync(cfg.configDir, { recursive: true });
  const removed = uninstall(cfg, agentsSrc);
  assert.deepEqual(removed, { skill: false, agents: [], schemas: false, shared: false, permsRemoved: 0, workflow: false, argsSkill: false });
  fs.rmSync(cfg.configDir, { recursive: true, force: true });
});
