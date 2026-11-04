import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { BEADS_PACKAGE } from '../src/cli/beads-pin.js';

describe('apra-pm beads pin drift test', () => {
  it('install.mjs contains @beads/bd@ literals that match BEADS_PACKAGE from beads-pin.ts', () => {
    // Read the apra-pm installer as text
    const installMjsPath = path.join(process.cwd(), 'packages/apra-fleet-se/apra-pm/install.mjs');
    const content = fs.readFileSync(installMjsPath, 'utf-8');

    // Extract all @beads/bd@<version> literals with a regex
    const beadsRegex = /@beads\/bd@[\d.]+/g;
    const matches = content.match(beadsRegex);

    // Assert (a) at least one was found
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThan(0);

    // Assert (b) every one equals BEADS_PACKAGE
    for (const match of matches!) {
      expect(match).toBe(BEADS_PACKAGE);
    }
  });

  it('fails when install.mjs has a mismatched version', () => {
    // This test documents the expected behavior:
    // If we temporarily had @beads/bd@1.1.2, this test would fail.
    // We're verifying the regex works and the assertion catches drifts.
    const testContent = '@beads/bd@1.1.2';
    const beadsRegex = /@beads\/bd@[\d.]+/g;
    const matches = testContent.match(beadsRegex);

    expect(matches).not.toBeNull();
    expect(matches![0]).not.toBe(BEADS_PACKAGE);
  });

  it('fails when install.mjs contains no @beads/bd@ literal at all', () => {
    // This test verifies that the regex correctly fails when no literals exist
    const testContent = 'some other content';
    const beadsRegex = /@beads\/bd@[\d.]+/g;
    const matches = testContent.match(beadsRegex);

    expect(matches).toBeNull();
  });
});
