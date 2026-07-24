#!/usr/bin/env node
/**
 * dist-pm.mjs -- Copy local apra-pm files into dist/ for npm publish.
 *
 * This runs during prepublishOnly to embed skills/pm and agents into the
 * package before npm pack, so they are part of the distributed artifact.
 */

import { existsSync, mkdirSync, cpSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GRAPH_SEMANTICS_MARKER = '<!-- GRAPH-SEMANTICS -->';

// Injects the packages/apra-fleet-se/apra-pm/agents/_shared/GRAPH-SEMANTICS.md canonical fragment in
// place of a literal `<!-- GRAPH-SEMANTICS -->` marker line in each top-level role file
// under distAgentsDir, so all 8 agent contracts stay in sync on one shared source of
// truth without needing a runtime include mechanism (execute-prompt.ts hands each agent
// contract to a dispatch whole, as a self-contained file). The `_shared/` subdirectory
// itself is removed from the copied dist/agents tree afterward -- its content is inlined
// into the role files, so shipping the raw fragment as a separate file is just clutter,
// and (per install.ts's `if (entry.isDirectory()) continue`) it would never be installed
// as a standalone file for a manual/non-SEA install anyway.
function injectGraphSemantics(distAgentsDir) {
  const fragmentPath = join(distAgentsDir, '_shared', 'GRAPH-SEMANTICS.md');
  if (!existsSync(fragmentPath)) {
    console.log('No _shared/GRAPH-SEMANTICS.md found -- skipping graph-semantics injection');
    return;
  }
  const fragment = readFileSync(fragmentPath, 'utf-8').trimEnd();

  let injectedCount = 0;
  for (const entry of readdirSync(distAgentsDir, { withFileTypes: true })) {
    if (entry.isDirectory() || !entry.name.endsWith('.md')) continue;
    const filePath = join(distAgentsDir, entry.name);
    const content = readFileSync(filePath, 'utf-8');
    if (!content.includes(GRAPH_SEMANTICS_MARKER)) continue;
    writeFileSync(filePath, content.replace(GRAPH_SEMANTICS_MARKER, fragment), 'utf-8');
    injectedCount++;
  }
  console.log(`Injected GRAPH-SEMANTICS.md into ${injectedCount} agent contract(s)`);

  rmSync(join(distAgentsDir, '_shared'), { recursive: true, force: true });
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const distDir = join(root, 'dist');

const submoduleSkills = join(root, 'packages', 'apra-fleet-se', 'apra-pm', 'skills', 'pm');
const submoduleAgents = join(root, 'packages', 'apra-fleet-se', 'apra-pm', 'agents');
const submoduleWorkflows = join(root, 'packages', 'apra-fleet-se', 'apra-pm', '.claude', 'workflows');
const submoduleArgsSkill = join(root, 'packages', 'apra-fleet-se', 'apra-pm', '.claude', 'skills', 'auto-sprint-args');

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
  injectGraphSemantics(distAgents);

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
  console.log('apra-pm not found but dist/ already populated -- skipping copy');
} else {
  console.error('Error: packages/apra-fleet-se/apra-pm not found and dist/ not pre-populated.');
  process.exit(1);
}
