/**
 * Drift guard: every `Bash(...)` permission declared under a playbook's
 * `## Permissions` section must be present in the root `permissions.json`
 * ledger's `granted` list (the shape `loadLedger`/`saveLedger` in
 * src/tools/compose-permissions.ts read/write). Without this, a playbook can
 * declare a new required permission that never makes it into the ledger
 * compose_permissions actually delivers to members, leaving it as dead-letter
 * documentation -- exactly the gap that burned a live fleet-sprint
 * (fleet-lin-dev1) mid-Deploy-phase. The ledger MAY be a superset of the
 * playbooks (mid-sprint `compose_permissions --grant` calls add entries no
 * playbook ever declared) -- this only fails in the direction "playbook
 * declares X, ledger doesn't have X".
 *
 * Pattern mirrors packages/apra-fleet-se/apra-pm/test/auto-sprint-schemas-drift.test.mjs
 * (generated-artifact-must-match-its-source) and the CI "Verify llms-full.txt
 * is up to date" step (.github/workflows/ci.yml).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dir, '..');

const PLAYBOOKS = [
  'deploy.md',
  'integ-test-playbook.md',
  'regression-test-playbook.md',
];

/** Extract every `Bash(...)` span declared in the top-level bullet-list
 *  items directly under a file's `## Permissions` heading, stopping at the
 *  next `##` heading. Only lines that themselves open a list item (`- ...`)
 *  are considered -- explanatory prose paragraphs after the list (which may
 *  cite an unrelated *broader* prefix purely as an example of what counts as
 *  coverage, e.g. "a broader prefix entry ... e.g. `Bash(npm:*)` covers
 *  ...") must NOT be picked up as declarations. Returns [] if the file has
 *  no `## Permissions` section. */
function extractDeclaredPermissions(filePath: string): string[] {
  const src = readFileSync(filePath, 'utf-8');
  const headingIdx = src.indexOf('## Permissions');
  if (headingIdx === -1) return [];
  const afterHeading = src.slice(headingIdx + '## Permissions'.length);
  const nextHeadingIdx = afterHeading.search(/\n## /);
  const section = nextHeadingIdx === -1 ? afterHeading : afterHeading.slice(0, nextHeadingIdx);
  const found = new Set<string>();
  for (const line of section.split('\n')) {
    if (!/^-\s/.test(line.trim())) continue;
    for (const m of line.match(/Bash\([^)]*\)/g) ?? []) found.add(m);
  }
  return [...found];
}

describe('permissions.json ledger matches playbook ## Permissions declarations', () => {
  const ledgerPath = join(repoRoot, 'permissions.json');
  const ledger = JSON.parse(readFileSync(ledgerPath, 'utf-8')) as {
    stacks: string[];
    granted: Array<{ permission: string; reason: string; date: string }>;
  };
  const grantedSet = new Set(ledger.granted.map(e => e.permission));

  for (const playbook of PLAYBOOKS) {
    it(`every Bash(...) permission declared in ${playbook}'s ## Permissions section is present in permissions.json`, () => {
      const declared = extractDeclaredPermissions(join(repoRoot, playbook));
      const missing = declared.filter(p => !grantedSet.has(p));
      expect(
        missing,
        missing.length
          ? `permissions.json is missing ${missing.length} permission(s) declared in ${playbook}'s ## Permissions section: ${missing.join(', ')}. ` +
            `Add a "granted" entry for each (permission, reason citing "declared in ${playbook} ## Permissions", today's date) to permissions.json and commit the result.`
          : ''
      ).toEqual([]);
    });
  }
});
