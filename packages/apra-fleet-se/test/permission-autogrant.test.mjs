import { test, describe } from 'node:test';
import assert from 'node:assert';
import {
  PLAYBOOK_ROLE_MAP,
  parsePermissionsSection,
  planMemberGrants,
  verifyGrantsPersisted,
  autoGrantRunbookPermissions,
} from '../fleet-sprint/permission-autogrant.mjs';

// apra-fleet-xuo.12.1 -- Auto-grant runbook-declared permissions via
// compose_permissions at Sprint Setup, with post-write read-back verification.

const DEPLOY_MD = `# Fleet Deploy Runbook

## Permissions

Commands below require these prefixes in \`.claude/settings.json\`:
- \`Bash(npm ci)\`
- \`Bash(npm run build)\`
- \`Bash(*apra-fleet-installer-* install *)\`

## Deploy

Build and install.
`;

const INTEG_MD = `# Integ Test Playbook

## Permissions

Commands below require the ability to run these command families:
- \`npm test ...\` (e.g. \`Bash(npm test*)\`)
- \`bd ...\` (e.g. \`Bash(bd *)\`)

## Inputs

Feature ids.
`;

describe('parsePermissionsSection', () => {
  test('extracts Bash(...) tokens from the ## Permissions section only', () => {
    const grants = parsePermissionsSection(DEPLOY_MD);
    assert.deepStrictEqual(grants, [
      'Bash(npm ci)',
      'Bash(npm run build)',
      'Bash(*apra-fleet-installer-* install *)',
    ]);
  });

  test('stops at the next heading -- tokens after ## Deploy are not collected', () => {
    const md = DEPLOY_MD + '\n## More\n- `Bash(should-not-appear)`\n';
    const grants = parsePermissionsSection(md);
    assert.ok(!grants.includes('Bash(should-not-appear)'));
  });

  test('captures inline "e.g." example prefixes as valid coverage', () => {
    const grants = parsePermissionsSection(INTEG_MD);
    assert.deepStrictEqual(grants, ['Bash(npm test*)', 'Bash(bd *)']);
  });

  test('de-duplicates repeated tokens, order preserved', () => {
    const md = '## Permissions\n- `Bash(npm ci)`\n- `Bash(npm ci)`\n- `Bash(bd *)`\n';
    assert.deepStrictEqual(parsePermissionsSection(md), ['Bash(npm ci)', 'Bash(bd *)']);
  });

  test('returns [] when there is no ## Permissions section', () => {
    assert.deepStrictEqual(parsePermissionsSection('# Title\n\nno perms here\n'), []);
  });

  test('handles empty / non-string input', () => {
    assert.deepStrictEqual(parsePermissionsSection(''), []);
    assert.deepStrictEqual(parsePermissionsSection(null), []);
    assert.deepStrictEqual(parsePermissionsSection(undefined), []);
  });
});

describe('planMemberGrants', () => {
  test('unions grants across playbooks per member (a member serving two roles gets both sets)', () => {
    const playbookGrants = {
      'deploy.md': ['Bash(npm ci)'],
      'integ-test-playbook.md': ['Bash(bd *)'],
    };
    const getMembersForRole = (role) => {
      if (role === 'deployer') return ['alice'];
      if (role === 'integ-test-runner') return ['alice', 'bob'];
      return [];
    };
    const plan = planMemberGrants({ playbookGrants, getMembersForRole });
    assert.deepStrictEqual(plan.get('alice'), ['Bash(bd *)', 'Bash(npm ci)']);
    assert.deepStrictEqual(plan.get('bob'), ['Bash(bd *)']);
  });

  test('skips playbooks with no grants and produces no members when none map', () => {
    const plan = planMemberGrants({
      playbookGrants: { 'deploy.md': [] },
      getMembersForRole: () => ['alice'],
    });
    assert.strictEqual(plan.size, 0);
  });

  test('PLAYBOOK_ROLE_MAP covers all three lifecycle playbooks', () => {
    assert.deepStrictEqual(Object.keys(PLAYBOOK_ROLE_MAP).sort(), [
      'deploy.md',
      'integ-test-playbook.md',
      'regression-test-playbook.md',
    ]);
  });
});

describe('verifyGrantsPersisted (read-back)', () => {
  test('ok when every expected grant is present in permissions.allow', () => {
    const text = JSON.stringify({ permissions: { allow: ['Bash(npm ci)', 'Bash(bd *)'] } });
    const { ok, missing } = verifyGrantsPersisted(text, ['Bash(npm ci)']);
    assert.strictEqual(ok, true);
    assert.deepStrictEqual(missing, []);
  });

  test('reports missing grants (the silent no-op write case)', () => {
    const text = JSON.stringify({ permissions: { allow: ['Bash(npm ci)'] } });
    const { ok, missing } = verifyGrantsPersisted(text, ['Bash(npm ci)', 'Bash(bd *)']);
    assert.strictEqual(ok, false);
    assert.deepStrictEqual(missing, ['Bash(bd *)']);
  });

  test('unparseable / empty content counts as nothing persisted', () => {
    for (const bad of ['', '{}', 'not json', null]) {
      const { ok, missing } = verifyGrantsPersisted(bad, ['Bash(bd *)']);
      assert.strictEqual(ok, false);
      assert.deepStrictEqual(missing, ['Bash(bd *)']);
    }
  });
});

describe('autoGrantRunbookPermissions (orchestration)', () => {
  function makeDeps({ settingsAfterGrant, existing = ['deploy.md'] } = {}) {
    const calls = { compose: [], settingsReads: [] };
    const deps = {
      probeFileExists: async (f) => existing.includes(f),
      readPlaybook: async (f) => (f === 'deploy.md' ? DEPLOY_MD : INTEG_MD),
      getMembersForRole: (role) => (role === 'deployer' ? ['alice'] : []),
      composePermissions: async (opts) => {
        calls.compose.push(opts);
        return { ok: true };
      },
      readMemberSettings: async (member) => {
        calls.settingsReads.push(member);
        return settingsAfterGrant;
      },
      log: () => {},
    };
    return { deps, calls };
  }

  test('grants each member the parsed union and verifies via read-back', async () => {
    const settings = JSON.stringify({
      permissions: { allow: ['Bash(npm ci)', 'Bash(npm run build)', 'Bash(*apra-fleet-installer-* install *)'] },
    });
    const { deps, calls } = makeDeps({ settingsAfterGrant: settings });
    const result = await autoGrantRunbookPermissions(deps);

    assert.strictEqual(result.skipped, false);
    assert.deepStrictEqual(Object.keys(result.grantedByMember), ['alice']);
    assert.strictEqual(calls.compose.length, 1);
    assert.strictEqual(calls.compose[0].member_name, 'alice');
    assert.ok(calls.compose[0].grant.includes('Bash(npm ci)'));
    assert.ok(typeof calls.compose[0].grant_reason === 'string');
    assert.deepStrictEqual(calls.settingsReads, ['alice']);
  });

  test('HARD-FAILS when read-back does not show the granted permissions', async () => {
    // compose_permissions "succeeds" but the write silently no-op'd -- allow is empty.
    const { deps } = makeDeps({ settingsAfterGrant: JSON.stringify({ permissions: { allow: [] } }) });
    await assert.rejects(
      () => autoGrantRunbookPermissions(deps),
      /read-back FAILED for member 'alice'/,
    );
  });

  test('passes project_folder through to compose_permissions when supplied', async () => {
    const settings = JSON.stringify({
      permissions: { allow: ['Bash(npm ci)', 'Bash(npm run build)', 'Bash(*apra-fleet-installer-* install *)'] },
    });
    const { deps, calls } = makeDeps({ settingsAfterGrant: settings });
    await autoGrantRunbookPermissions({ ...deps, projectFolder: '/srv/project' });
    assert.strictEqual(calls.compose[0].project_folder, '/srv/project');
  });

  test('skips cleanly when no playbook declares permissions', async () => {
    const { deps, calls } = makeDeps({ existing: [] });
    const result = await autoGrantRunbookPermissions(deps);
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(calls.compose.length, 0);
  });
});
