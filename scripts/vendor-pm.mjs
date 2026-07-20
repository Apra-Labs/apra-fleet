#!/usr/bin/env node
/**
 * vendor-pm.mjs -- Copy apra-pm submodule files into dist/ for npm publish.
 *
 * npm install -g does NOT clone submodules, so prepublishOnly runs this to
 * embed skills/pm and agents into the package before npm pack.
 */

import { existsSync, mkdirSync, cpSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const distDir = join(root, 'dist');

const submoduleSkills = join(root, 'vendor', 'apra-pm', 'skills', 'pm');
const submoduleAgents = join(root, 'vendor', 'apra-pm', 'agents');
const submoduleWorkflows = join(root, 'vendor', 'apra-pm', '.claude', 'workflows');
const submoduleArgsSkill = join(root, 'vendor', 'apra-pm', '.claude', 'skills', 'auto-sprint-args');

const distSkills = join(distDir, 'skills', 'pm');
const distAgents = join(distDir, 'agents');
const distWorkflows = join(distDir, 'workflows');
const distArgsSkill = join(distDir, 'skills', 'auto-sprint-args');

const isNonEmptyDir = (dir) => existsSync(dir) && readdirSync(dir).length > 0;

if (isNonEmptyDir(submoduleSkills) && isNonEmptyDir(submoduleAgents)) {
  mkdirSync(distSkills, { recursive: true });
  cpSync(submoduleSkills, distSkills, { recursive: true });
  console.log(`Vendored skills/pm -> dist/skills/pm`);

  mkdirSync(distAgents, { recursive: true });
  cpSync(submoduleAgents, distAgents, { recursive: true });
  console.log(`Vendored agents -> dist/agents`);

  if (existsSync(submoduleWorkflows)) {
    mkdirSync(distWorkflows, { recursive: true });
    cpSync(submoduleWorkflows, distWorkflows, { recursive: true });
    console.log(`Vendored .claude/workflows -> dist/workflows`);
  }

  if (existsSync(submoduleArgsSkill)) {
    mkdirSync(distArgsSkill, { recursive: true });
    cpSync(submoduleArgsSkill, distArgsSkill, { recursive: true });
    console.log(`Vendored .claude/skills/auto-sprint-args -> dist/skills/auto-sprint-args`);
  }
} else if (isNonEmptyDir(distSkills) && isNonEmptyDir(distAgents)) {
  console.log('Submodule not initialized but dist/ already populated -- skipping vendor copy');
} else {
  console.error('Error: vendor/apra-pm submodule not initialized (or empty) and dist/ not pre-populated.');
  console.error('Run: git submodule update --init');
  process.exit(1);
}
