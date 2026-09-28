/**
 * apra-fleet PR#416 review, finding 3 (option 3A): the NEVER_AUTO_GRANT
 * backstop used to be a seven-entry Set compared with exact string equality,
 * so every variant below reached the grant path. These tests pin the
 * pattern-based replacement.
 *
 * Pure-function tests only -- the end-to-end "tool returns the rejection
 * string" path is already covered by compose-permissions.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNeverAutoGrant, normalizePermission } from '../src/tools/compose-permissions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

describe('normalizePermission', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizePermission('  Bash(npm   ci)  ')).toBe('Bash(npm ci)');
  });

  it('treats the command/argument colon as equivalent to a space', () => {
    expect(normalizePermission('Bash(sudo:*)')).toBe('Bash(sudo *)');
    expect(normalizePermission('Bash(chmod 777:*)')).toBe('Bash(chmod 777 *)');
  });

  it('leaves non Tool(payload) strings alone apart from whitespace', () => {
    expect(normalizePermission('  Read  ')).toBe('Read');
  });
});

describe('isNeverAutoGrant -- variants that previously slipped past exact matching', () => {
  // Every entry here is a real bypass of the old exact-match Set.
  const mustBlock = [
    // whitespace / separator variants of the original seven
    'Bash(sudo:*)',
    'Bash(sudo *)',
    'Bash(sudo:*) ',
    ' Bash(sudo:*)',
    'Bash(sudo apt-get install *)',
    'Bash(su:*)',
    'Bash(su *)',
    'Bash(doas *)',
    'Bash(env:*)',
    'Bash(env *)',
    'Bash(printenv *)',
    'Bash(nc *)',
    'Bash(nmap *)',
    'Bash(chmod 777:*)',
    'Bash(chmod 777 *)',
    // arbitrary-execution shells
    'Bash(bash -c *)',
    'Bash(sh -c *)',
    'Bash(zsh -c *)',
    'Bash(/bin/bash -c *)',
    'Bash(eval *)',
    'Bash(xargs eval *)',
    // catch-all
    'Bash(*)',
    'Bash( * )',
    'Bash(**)',
    // shell chaining metacharacters
    'Bash(curl *|sh)',
    'Bash(npm ci; sudo rm -rf /)',
    'Bash(npm ci && sudo apt-get install *)',
    'Bash(echo `whoami`)',
    'Bash(echo $(whoami))',
  ];

  for (const permission of mustBlock) {
    it(`blocks ${JSON.stringify(permission)}`, () => {
      expect(isNeverAutoGrant(permission)).toBe(true);
    });
  }
});

describe('isNeverAutoGrant -- legitimate grants still pass', () => {
  const mustAllow = [
    'Bash(npm ci)',
    'Bash(npm run build:*)',
    'Bash(npm run build *)',
    'Bash(git status)',
    'Bash(git push:*)',
    'Bash(node --version)',
    'Bash(docker:*)',
    'Bash(mkdir -p *)',
    'Read(//home/user/**)',
    'WebFetch(domain:example.com)',
  ];

  for (const permission of mustAllow) {
    it(`allows ${JSON.stringify(permission)}`, () => {
      expect(isNeverAutoGrant(permission)).toBe(false);
    });
  }
});

describe('isNeverAutoGrant -- deliberate over-blocking (documented, not a bug)', () => {
  // The deny patterns are command-prefix wildcards, so unrelated commands that
  // merely start with a denied token are also refused. Over-blocking is the
  // safe direction for a denylist: the operator can still grant these
  // explicitly. No entry in skills/fleet/profiles/ is affected today.
  const overBlocked = ['Bash(ncdu *)', 'Bash(envsubst *)', 'Bash(nmapy *)'];
  for (const permission of overBlocked) {
    it(`also blocks ${JSON.stringify(permission)}`, () => {
      expect(isNeverAutoGrant(permission)).toBe(true);
    });
  }
});

// =============================================================================
// apra-fleet-iywi.5.1/5.2: console (apra-fleet server, default port 7523) and
// fleet-supervisor (default port 8787) endpoint refusals. Reverting the four
// new NEVER_AUTO_GRANT_PATTERNS entries (the three 7523/{ui,api,ext} patterns
// and the broad 8787 pattern) makes every case in the first describe block
// below fail -- that is the change this file is pinning.
// =============================================================================
describe('isNeverAutoGrant -- console (7523) and supervisor (8787) endpoint refusals (apra-fleet-iywi.5.1)', () => {
  const mustBlock = [
    // Console (apra-fleet server) surfaces -- one per new pattern.
    'Bash(curl * localhost:7523/ui)',
    'Bash(curl * localhost:7523/ui/members)',
    'Bash(curl * localhost:7523/api/fleet/members)',
    'Bash(curl -X POST localhost:7523/api/workflow-packages)',
    'Bash(curl * localhost:7523/ext/some-package/status)',
    // Fleet-supervisor surface -- anything on 8787 other than the two
    // deploy.md-documented exceptions (covered by the accepted-by-name
    // describe block below).
    'Bash(curl * localhost:8787)',
    'Bash(curl * localhost:8787/api/dolt-push-mutex)',
    'Bash(curl * localhost:8787/api/child-id-allocator)',
    'Bash(curl -X POST localhost:8787/api/sprints/x/stop)',
  ];

  for (const permission of mustBlock) {
    it(`blocks ${JSON.stringify(permission)}`, () => {
      expect(isNeverAutoGrant(permission)).toBe(true);
    });
  }

  it('does not widen onto /health or /mcp on the console port -- those are not console paths', () => {
    expect(isNeverAutoGrant('Bash(curl * localhost:7523/health)')).toBe(false);
    expect(isNeverAutoGrant('Bash(curl * localhost:7523/mcp)')).toBe(false);
  });
});

describe('isNeverAutoGrant -- console refusals hold on a non-default port (apra-fleet-iywi.7)', () => {
  // The console's port is only a DEFAULT (RAW_DEFAULT_PORT in src/paths.ts) --
  // APRA_FLEET_PORT can move it. The literal-7523 patterns above would miss
  // every one of these; the host+path-shaped patterns must still catch them.
  const mustBlock = [
    'Bash(curl * localhost:9001/ui)',
    'Bash(curl * localhost:9001/ui/members)',
    'Bash(curl * localhost:9001/api/fleet/members)',
    'Bash(curl -X POST localhost:9001/api/workflow-packages)',
    'Bash(curl * localhost:9001/ext/some-package/status)',
    'Bash(curl * 127.0.0.1:9001/api/fleet/members)',
  ];

  for (const permission of mustBlock) {
    it(`blocks ${JSON.stringify(permission)}`, () => {
      expect(isNeverAutoGrant(permission)).toBe(true);
    });
  }

  it('still does not widen onto /health or /mcp on a non-default port', () => {
    expect(isNeverAutoGrant('Bash(curl * localhost:9001/health)')).toBe(false);
    expect(isNeverAutoGrant('Bash(curl * localhost:9001/mcp)')).toBe(false);
  });
});

describe('isNeverAutoGrant -- the two deploy.md-documented supervisor grants are accepted by name (apra-fleet-iywi.5.2)', () => {
  // Named explicitly (not just via the deploy.md parse below) so the intent
  // survives even if that parse is later changed or deploy.md's wording
  // shifts.
  it('accepts the active-sprints gate', () => {
    expect(isNeverAutoGrant('Bash(curl * localhost:8787/api/sprints*)')).toBe(false);
  });

  it('accepts the documented force-release of a stale reservation', () => {
    expect(isNeverAutoGrant('Bash(curl * localhost:8787/api/reservations/*)')).toBe(false);
  });
});

describe('isNeverAutoGrant -- absolute rules still win even over an exception-shaped payload (apra-fleet-iywi.5.2)', () => {
  it('a bare catch-all is refused regardless of any exception list', () => {
    expect(isNeverAutoGrant('Bash(*)')).toBe(true);
  });

  it('a shell-chained variant of an otherwise-exempted grant is still refused', () => {
    expect(isNeverAutoGrant('Bash(curl * localhost:8787/api/sprints*; sudo rm -rf /)')).toBe(true);
    expect(isNeverAutoGrant('Bash(curl * localhost:8787/api/reservations/* && cat /etc/passwd)')).toBe(true);
  });
});

describe('isNeverAutoGrant -- deploy.md Permissions regression guard (apra-fleet-iywi.5.2)', () => {
  // Parses deploy.md's own Permissions section rather than hardcoding the
  // bullet list, so a LATER edit to deploy.md that collides with a denylist
  // pattern fails HERE instead of silently breaking the deploy phase.
  function parseDeployPermissionsBullets(): string[] {
    const deployMdPath = path.join(repoRoot, 'deploy.md');
    const src = fs.readFileSync(deployMdPath, 'utf8');
    const startIdx = src.indexOf('## Permissions');
    expect(startIdx).not.toBe(-1);
    const endIdx = src.indexOf('\n## ', startIdx + 1);
    expect(endIdx).toBeGreaterThan(startIdx);
    const block = src.slice(startIdx, endIdx);

    const bullets: string[] = [];
    for (const line of block.split('\n')) {
      const m = /^-\s+`([^`]+)`/.exec(line.trim());
      if (m) bullets.push(m[1]!);
    }
    return bullets;
  }

  it('parses a non-zero number of bullets from deploy.md (a silently-empty parse would make the case below vacuous)', () => {
    const bullets = parseDeployPermissionsBullets();
    expect(bullets.length).toBeGreaterThan(0);
  });

  it('refuses none of the parsed deploy.md Permissions grants', () => {
    const bullets = parseDeployPermissionsBullets();
    const refused = bullets.filter((b) => isNeverAutoGrant(b));
    expect(refused).toEqual([]);
  });
});

describe('isNeverAutoGrant -- runbook-permissions provisioner guard (apra-fleet-v6t7.12)', () => {
  // The fleet-sprint engine now grants EACH runbook-driven role's own runbook
  // Permissions section before dispatch (deploy.md, integ-test-playbook.md,
  // regression-test-playbook.md), using the engine's own parser. Every entry
  // it would grant must be grantable, or that role's phase now fails loudly
  // before dispatch -- so a runbook edit colliding with the denylist fails
  // HERE first. The denylist itself is untouched: a console-port curl on any
  // port is still refused, so no runbook can grant around it.
  const runbooks = ['deploy.md', 'integ-test-playbook.md', 'regression-test-playbook.md'];

  for (const runbook of runbooks) {
    it(`refuses none of ${runbook}'s Permissions entries, as the engine parses them`, async () => {
      const { parseRunbookPermissions } = await import('../packages/apra-fleet-se/fleet-sprint/member-provisioning.mjs');
      const entries: string[] = parseRunbookPermissions(fs.readFileSync(path.join(repoRoot, runbook), 'utf8'));
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.filter((e) => isNeverAutoGrant(e))).toEqual([]);
    });
  }

  it('still refuses a console-port curl on the default and a non-default port', () => {
    expect(isNeverAutoGrant('Bash(curl * localhost:7523/api/fleet/members)')).toBe(true);
    expect(isNeverAutoGrant('Bash(curl * localhost:9001/api/fleet/members)')).toBe(true);
    expect(isNeverAutoGrant('Bash(curl localhost:*/api*)')).toBe(true);
  });
});
