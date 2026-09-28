#!/usr/bin/env node
/**
 * dist-pm.mjs -- Copy local apra-pm files into dist/ for npm publish.
 *
 * This runs during prepublishOnly to embed skills/pm and agents into the
 * package before npm pack, so they are part of the distributed artifact.
 */

import { existsSync, mkdirSync, cpSync, readdirSync, readFileSync, writeFileSync, rmSync, renameSync, realpathSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
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
export function injectGraphSemantics(distAgentsDir) {
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

export const isNonEmptyDir = (dir) => existsSync(dir) && readdirSync(dir).length > 0;

// Vendors `src` into `dest`, replacing any pre-existing `dest` tree so a file
// that no longer has a package-local source (e.g. an orphan left behind by a
// prior checkout of a different branch, or a schema/agent file that was
// renamed/deleted upstream) does not survive the refresh. Plain cpSync with
// recursive:true only overlays -- it never deletes destination-only entries
// -- which is exactly what made the schema staleness guard's "run npm run
// dist-pm to fix it" remediation hint untruthful (apra-fleet-v6t7.4).
//
// The copy is staged into a temp sibling directory first and only swapped
// into place with a rename once it has fully succeeded. If `copyFn` throws
// partway through (a real I/O error, or an injected one in tests), the
// staged temp directory is discarded and the previous `dest` content is left
// untouched instead of being deleted first and possibly never repopulated
// (apra-fleet-v6t7.13).
//
// The swap itself uses a rename-the-old-one-aside-first sequence rather than
// "delete dest, then rename tmp into dest": a directory rename can itself
// fail (EPERM/EBUSY -- routine on Windows under an AV scanner or an open
// handle from a concurrent build/editor watch), and if dest were removed
// before that rename was attempted, that failure would still leave dest
// missing instead of intact. Renaming dest to a backup name first means a
// failed final rename can restore the backup and dest is never observed
// deleted-but-not-yet-replaced.
export function vendorDir(src, dest, label, { copyFn = cpSync } = {}) {
  const tmpDest = `${dest}.tmp-${process.pid}-${Date.now()}`;
  rmSync(tmpDest, { recursive: true, force: true });
  mkdirSync(tmpDest, { recursive: true });
  try {
    copyFn(src, tmpDest, { recursive: true });
  } catch (err) {
    rmSync(tmpDest, { recursive: true, force: true });
    throw err;
  }

  const backupDest = `${dest}.bak-${process.pid}-${Date.now()}`;
  rmSync(backupDest, { recursive: true, force: true });
  const hadPreviousDest = existsSync(dest);
  if (hadPreviousDest) {
    renameSync(dest, backupDest);
  }
  try {
    renameSync(tmpDest, dest);
  } catch (err) {
    // The final rename failed: restore the previous dest (if any) so callers
    // never observe dest missing, and surface the original error.
    if (hadPreviousDest) {
      renameSync(backupDest, dest);
    }
    rmSync(tmpDest, { recursive: true, force: true });
    throw err;
  }
  if (hadPreviousDest) {
    rmSync(backupDest, { recursive: true, force: true });
  }
  if (label) console.log(`Vendored ${label}`);
}

function runDistPm() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const root = join(__dirname, '..');

  // Destination root override for tests: defaults to <repo>/dist, exactly the
  // prior hardcoded behaviour, but a test can redirect vendoring output to a
  // throwaway temp directory via DIST_PM_DIST_DIR so `npm test` never mutates
  // the developer's real dist/ tree or races a concurrent build
  // (apra-fleet-v6t7.13). Source paths (the submodule under packages/) are
  // always resolved against the real repo root -- they are only ever read.
  const distDir = process.env.DIST_PM_DIST_DIR ? resolve(process.env.DIST_PM_DIST_DIR) : join(root, 'dist');

  const submoduleSkills = join(root, 'packages', 'apra-fleet-se', 'apra-pm', 'skills', 'pm');
  const submoduleAgents = join(root, 'packages', 'apra-fleet-se', 'apra-pm', 'agents');
  const submoduleWorkflows = join(root, 'packages', 'apra-fleet-se', 'apra-pm', '.claude', 'workflows');
  const submoduleArgsSkill = join(root, 'packages', 'apra-fleet-se', 'apra-pm', '.claude', 'skills', 'auto-sprint-args');

  const distSkills = join(distDir, 'skills', 'pm');
  const distAgents = join(distDir, 'agents');
  const distWorkflows = join(distDir, 'workflows');
  const distArgsSkill = join(distDir, 'skills', 'auto-sprint-args');

  // fleet-sprint-cli skill: sourced from the fleet-sprint package (NOT apra-pm),
  // vendored to dist/ so npm-global installs (no packages/ tree) still find it.
  // Provider-agnostic -- installed for every LLM provider.
  const fleetSprintCliSkill = join(root, 'packages', 'apra-fleet-se', 'fleet-sprint', 'skills', 'fleet-sprint-cli');
  const distCliSkill = join(distDir, 'skills', 'fleet-sprint-cli');

  if (isNonEmptyDir(submoduleSkills) && isNonEmptyDir(submoduleAgents)) {
    vendorDir(submoduleSkills, distSkills, 'skills/pm -> dist/skills/pm');

    vendorDir(submoduleAgents, distAgents, 'agents -> dist/agents');
    injectGraphSemantics(distAgents);

    if (existsSync(submoduleWorkflows)) {
      vendorDir(submoduleWorkflows, distWorkflows, '.claude/workflows -> dist/workflows');
    }

    if (existsSync(submoduleArgsSkill)) {
      vendorDir(submoduleArgsSkill, distArgsSkill, '.claude/skills/auto-sprint-args -> dist/skills/auto-sprint-args');
    }

    if (existsSync(fleetSprintCliSkill)) {
      vendorDir(fleetSprintCliSkill, distCliSkill, 'fleet-sprint/.claude/skills/fleet-sprint-cli -> dist/skills/fleet-sprint-cli');
    }
  } else if (isNonEmptyDir(distSkills) && isNonEmptyDir(distAgents)) {
    console.log('apra-pm not found but dist/ already populated -- skipping copy');
  } else {
    console.error('Error: packages/apra-fleet-se/apra-pm not found and dist/ not pre-populated.');
    process.exit(1);
  }
}

// Only run the vendoring pass when this file is executed directly (`node
// scripts/dist-pm.mjs`, including via the npm `dist-pm` script), not when a
// test imports it as a module to unit-test vendorDir()/injectGraphSemantics()
// in isolation. Compared via realpathSync (not just resolve()) so a drive
// letter case difference or a junction/symlink in either path (both routine
// on Windows) cannot make this comparison miss and silently no-op
// prepublishOnly's vendoring step; case-folded on win32 since NTFS paths are
// case-insensitive there.
function sameFile(a, b) {
  try {
    const ra = realpathSync(a);
    const rb = realpathSync(b);
    return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
  } catch {
    return false;
  }
}

const isMainModule = Boolean(process.argv[1]) && sameFile(process.argv[1], fileURLToPath(import.meta.url));
if (isMainModule) {
  runDistPm();
}
