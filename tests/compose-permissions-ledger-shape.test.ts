/**
 * Tests for the Ledger granted-entry shape extension (apra-fleet-ivxi.1.2):
 * granted[] entries gain optional outOfBounds/requestedByRole fields. Both
 * are optional so ledgers written by older versions load unchanged.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadLedger, saveLedger } from '../src/tools/compose-permissions.js';

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('Ledger granted entry shape', () => {
  it('loads an old-shape permissions.json (no outOfBounds/requestedByRole) with no error and no spurious flags', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-ledger-'));
    const oldShape = {
      stacks: ['node'],
      granted: [
        { permission: 'Bash(docker:*)', reason: 'needed for build', date: '2026-01-01' },
      ],
    };
    fs.writeFileSync(path.join(tmpDir, 'permissions.json'), JSON.stringify(oldShape, null, 2));

    const ledger = loadLedger(tmpDir);

    expect(ledger.granted).toHaveLength(1);
    expect(ledger.granted[0].permission).toBe('Bash(docker:*)');
    expect(ledger.granted[0].reason).toBe('needed for build');
    expect(ledger.granted[0].date).toBe('2026-01-01');
    expect(ledger.granted[0].outOfBounds).toBeUndefined();
    expect(ledger.granted[0].requestedByRole).toBeUndefined();
  });

  it('round-trips a new-shape entry with outOfBounds and requestedByRole through save/load', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-ledger-'));
    const ledger = {
      stacks: ['node'],
      granted: [
        {
          permission: 'Bash(sudo:*)',
          reason: 'escalated by user',
          date: '2026-08-16',
          outOfBounds: true as const,
          requestedByRole: 'doer',
        },
      ],
    };

    saveLedger(tmpDir, ledger);
    const reloaded = loadLedger(tmpDir);

    expect(reloaded.granted).toHaveLength(1);
    expect(reloaded.granted[0].outOfBounds).toBe(true);
    expect(reloaded.granted[0].requestedByRole).toBe('doer');
  });
});
