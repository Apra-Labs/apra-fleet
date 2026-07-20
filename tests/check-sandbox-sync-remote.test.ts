import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  isSyncRemoteActive,
  checkSyncRemoteInert,
  checkNoOutboundCommits,
  parseLeftRightCount,
  checkDoltRemoteAbsent,
  parseDoltRemoteList,
  HAZARD_REMOTE,
} from '../scripts/check-sandbox-sync-remote.mjs';

// Tests for apra-fleet-eft.25.2: verify scripts/check-sandbox-sync-remote.mjs
// correctly detects both the eft.25 hazard (active sync.remote right after a
// bare 'bd bootstrap --yes') and the eft.25.1 remedy (sync.remote neutralized
// / commented out), plus the outbound-commit safety check.
//
// Sandbox-only: this suite never contacts the real fleet-e2e-toy Dolt
// remote. Git repos used here are local-only (no network), created fresh
// under os.tmpdir() and removed afterward.

describe('isSyncRemoteActive / checkSyncRemoteInert: sync.remote hazard detection', () => {
  it('FAILS (active) on the config.yaml shape bd bootstrap --yes produces (eft.25 repro)', () => {
    // Shape from apra-fleet-eft.25's repro: bd bootstrap --yes adds a new
    // ACTIVE block and leaves the old disabled line stale below it.
    const afterBootstrapOnly = [
      'sync:',
      '  remote: "git+https://github.com/Apra-Labs/fleet-e2e-toy"',
      '# sync.remote disabled -- no Dolt push for this toy project',
      '',
    ].join('\n');
    expect(isSyncRemoteActive(afterBootstrapOnly)).toBe(true);
  });

  it('PASSES (inert) once every fleet-e2e-toy reference is commented out (eft.25.1 remedy)', () => {
    const afterNeutralize = [
      '# sync:',
      '#   remote: "git+https://github.com/Apra-Labs/fleet-e2e-toy"',
      '# sync.remote disabled -- no Dolt push for this toy project',
      '',
    ].join('\n');
    expect(isSyncRemoteActive(afterNeutralize)).toBe(false);
  });

  it('PASSES on the pristine fresh-clone config (sync.remote shipped disabled)', () => {
    const pristine = '# sync.remote disabled -- no Dolt push for this toy project\n';
    expect(isSyncRemoteActive(pristine)).toBe(false);
  });

  it('references the real hazard remote identity', () => {
    expect(HAZARD_REMOTE).toBe('fleet-e2e-toy');
  });

  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-sync-remote-test-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('checkSyncRemoteInert: FAILS right after bd bootstrap --yes, before neutralize', () => {
    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(
      configPath,
      'sync:\n  remote: "git+https://github.com/Apra-Labs/fleet-e2e-toy"\n# sync.remote disabled -- no Dolt push for this toy project\n',
      'utf-8'
    );
    const result = checkSyncRemoteInert(configPath);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^FAIL/);
  });

  it('checkSyncRemoteInert: PASSES after the eft.25.1 neutralize step runs', () => {
    const configPath = path.join(tmpDir, 'config.yaml');
    fs.writeFileSync(
      configPath,
      'sync:\n  remote: "git+https://github.com/Apra-Labs/fleet-e2e-toy"\n# sync.remote disabled -- no Dolt push for this toy project\n',
      'utf-8'
    );
    // Apply the exact same sed transform the playbook's neutralize step uses.
    execFileSync('sed', ['-i.bak', '-E', '/fleet-e2e-toy/{/^[[:space:]]*#/!s/^/# /;}', configPath]);
    fs.rmSync(`${configPath}.bak`, { force: true });

    const result = checkSyncRemoteInert(configPath);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^OK/);
  });

  it('checkSyncRemoteInert: PASSES (vacuously) when config.yaml does not exist', () => {
    const result = checkSyncRemoteInert(path.join(tmpDir, 'does-not-exist.yaml'));
    expect(result.ok).toBe(true);
  });
});

describe('parseLeftRightCount', () => {
  it('parses tab-separated left/right counts', () => {
    expect(parseLeftRightCount('0\t0\n')).toEqual({ left: 0, right: 0 });
    expect(parseLeftRightCount('3\t1')).toEqual({ left: 3, right: 1 });
  });

  it('throws on unexpected output', () => {
    expect(() => parseLeftRightCount('garbage')).toThrow();
  });
});

describe('checkNoOutboundCommits: outbound-commit safety check (local-only git, no network)', () => {
  let tmpDir: string;
  let originDir: string;
  let cloneDir: string;

  function git(cwd: string, args: string[]) {
    return execFileSync('git', args, { cwd, encoding: 'utf-8' });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-outbound-test-'));
    originDir = path.join(tmpDir, 'origin.git');
    cloneDir = path.join(tmpDir, 'clone');

    // Bare "remote" repo, entirely local -- never touches the real
    // fleet-e2e-toy remote or the network.
    fs.mkdirSync(originDir);
    git(originDir, ['init', '--bare', '-b', 'main']);

    const seedDir = path.join(tmpDir, 'seed');
    fs.mkdirSync(seedDir);
    git(seedDir, ['init', '-b', 'main']);
    git(seedDir, ['config', 'user.email', 'test@example.com']);
    git(seedDir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(seedDir, 'README.md'), 'seed\n', 'utf-8');
    git(seedDir, ['add', 'README.md']);
    git(seedDir, ['commit', '-m', 'seed commit']);
    git(seedDir, ['push', originDir, 'main']);

    git(tmpDir, ['clone', originDir, cloneDir]);
    git(cloneDir, ['config', 'user.email', 'test@example.com']);
    git(cloneDir, ['config', 'user.name', 'Test']);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('PASSES when the sandbox clone has 0 commits ahead of origin/main', () => {
    const result = checkNoOutboundCommits(cloneDir);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^OK/);
  });

  it('FAILS when the sandbox clone has an un-pushed local commit ahead of origin/main', () => {
    fs.writeFileSync(path.join(cloneDir, 'new-file.txt'), 'local only\n', 'utf-8');
    git(cloneDir, ['add', 'new-file.txt']);
    git(cloneDir, ['commit', '-m', 'local-only commit (never pushed to real remote)']);

    const result = checkNoOutboundCommits(cloneDir);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^FAIL/);
  });

  it('surfaces a FAIL result (not a throw) when git rev-list itself errors', () => {
    const result = checkNoOutboundCommits(cloneDir, {
      execFileSync: () => {
        throw new Error('boom');
      },
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^FAIL/);
  });
});

describe('parseDoltRemoteList', () => {
  it('parses a JSON array of {name, url} entries', () => {
    expect(parseDoltRemoteList('[{"name":"origin","url":"git+https://github.com/Apra-Labs/fleet-e2e-toy"}]')).toEqual([
      { name: 'origin', url: 'git+https://github.com/Apra-Labs/fleet-e2e-toy' },
    ]);
    expect(parseDoltRemoteList('[]')).toEqual([]);
  });

  it('throws on non-JSON output', () => {
    expect(() => parseDoltRemoteList('not json')).toThrow();
  });

  it('throws when the parsed JSON is not an array', () => {
    expect(() => parseDoltRemoteList('{"name":"origin"}')).toThrow();
  });
});

describe('checkDoltRemoteAbsent: Dolt-level remote hazard detection (apra-fleet-eft.30)', () => {
  // Regression coverage for apra-fleet-eft.30: 'bd bootstrap --yes' wires
  // Dolt's OWN internal remote independently of the bd-level sync.remote
  // YAML key that checkSyncRemoteInert (above) checks. The eft.25.1
  // neutralize step (YAML-only) does NOT touch this Dolt-level remote, so
  // this check must FAIL on a YAML-only-neutralized sandbox and only PASS
  // once the eft.30.1 Dolt-remote disarm step has actually removed it.
  // Hermetic: execFileSync is always injected here -- this suite never
  // shells out to a real 'bd' binary or contacts the network.

  it('FAILS when Dolt-level "bd dolt remote list --json" still carries the hazard remote (pre-eft.30.1 state, incl. after YAML-only neutralize)', () => {
    const result = checkDoltRemoteAbsent('/fake/repo', {
      execFileSync: () =>
        JSON.stringify([
          { name: 'origin', url: 'git+https://github.com/Apra-Labs/fleet-e2e-toy' },
        ]),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^FAIL/);
    expect(result.message).toMatch(/fleet-e2e-toy/);
  });

  it('PASSES once the eft.30.1 Dolt-remote disarm step has removed the hazard remote', () => {
    const result = checkDoltRemoteAbsent('/fake/repo', {
      execFileSync: () => JSON.stringify([]),
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^OK/);
  });

  it('FAILS when a hazard remote is identified by name rather than url', () => {
    const result = checkDoltRemoteAbsent('/fake/repo', {
      execFileSync: () => JSON.stringify([{ name: 'fleet-e2e-toy', url: '' }]),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^FAIL/);
  });

  it('is vacuously OK when "bd dolt remote list" is unavailable (no bd binary / no beads DB in this clone)', () => {
    const result = checkDoltRemoteAbsent('/fake/repo', {
      execFileSync: () => {
        throw new Error('command not found: bd');
      },
    });
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/^OK/);
  });

  it('surfaces a FAIL result (not a throw) when the command output cannot be parsed as JSON', () => {
    const result = checkDoltRemoteAbsent('/fake/repo', {
      execFileSync: () => 'not json',
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/^FAIL/);
  });
});
