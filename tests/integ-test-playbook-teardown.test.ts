import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

// apra-fleet-eft.21.2: regression guard for the integ-test-playbook.md Teardown
// tilde-resolution defect (apra-fleet-eft.21 / apra-fleet-eft.21.1).
//
// The original (buggy) Teardown block did:
//   export HOME=~/temp/.apra-fleet-tests
//   ...
//   rm -rf ~/temp/.apra-fleet-tests
//
// Because HOME was already reassigned to the sandbox path *before* the final
// rm -rf, the bare `~` in the rm -rf line resolves against the *new* HOME
// (the sandbox itself), so the target becomes
// <sandbox>/temp/.apra-fleet-tests -- a path that never existed -- and the
// rm -rf silently no-ops. The real sandbox directory is left behind.
//
// The fix (apra-fleet-eft.21.1) captures the absolute sandbox path into a
// SANDBOX variable *before* overriding HOME, then removes "$SANDBOX" instead
// of a bare tilde:
//   SANDBOX="$HOME/temp/.apra-fleet-tests"
//   export HOME="$SANDBOX"
//   ...
//   rm -rf "$SANDBOX"
//
// This test reproduces both forms entirely inside a mktemp-created scratch
// directory (never touching the real user HOME) and asserts:
//   - the corrected form actually removes the sandbox directory and marker
//   - the buggy bare-tilde form leaves the sandbox directory and marker intact

describe('integ-test-playbook.md Teardown tilde-resolution regression', () => {
  let scratchRoot: string;

  beforeEach(() => {
    // Stand in for the real $HOME the block starts from -- an isolated
    // mktemp sandbox, never the actual user home directory.
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-teardown-test-'));
  });

  afterEach(() => {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  });

  function makeMarkerSandbox(outerHome: string): { sandboxDir: string; markerFile: string } {
    const sandboxDir = path.join(outerHome, 'temp', '.apra-fleet-tests');
    fs.mkdirSync(sandboxDir, { recursive: true });
    const markerFile = path.join(sandboxDir, 'marker.txt');
    fs.writeFileSync(markerFile, 'sentinel');
    return { sandboxDir, markerFile };
  }

  it('corrected teardown (capture SANDBOX before HOME override) removes the sandbox directory', () => {
    const outerHome = path.join(scratchRoot, 'outer-home');
    fs.mkdirSync(outerHome, { recursive: true });
    const { sandboxDir, markerFile } = makeMarkerSandbox(outerHome);

    expect(fs.existsSync(sandboxDir)).toBe(true);
    expect(fs.existsSync(markerFile)).toBe(true);

    // The corrected Teardown sequence from integ-test-playbook.md, run with
    // HOME initially pointed at our scratch outer-home (standing in for the
    // real user HOME at the top of the block).
    execSync(
      [
        'SANDBOX="$HOME/temp/.apra-fleet-tests"',
        'export HOME="$SANDBOX"',
        'rm -rf "$SANDBOX"',
      ].join(' && '),
      {
        shell: '/bin/bash',
        env: { ...process.env, HOME: outerHome },
      },
    );

    expect(fs.existsSync(sandboxDir)).toBe(false);
    expect(fs.existsSync(markerFile)).toBe(false);
  });

  it('pre-fix bare-tilde teardown (rm -rf ~/temp/.apra-fleet-tests after HOME override) leaves the sandbox intact', () => {
    const outerHome = path.join(scratchRoot, 'outer-home-buggy');
    fs.mkdirSync(outerHome, { recursive: true });
    const { sandboxDir, markerFile } = makeMarkerSandbox(outerHome);

    expect(fs.existsSync(sandboxDir)).toBe(true);
    expect(fs.existsSync(markerFile)).toBe(true);

    // The pre-fix Teardown sequence: HOME is reassigned to the sandbox path
    // first, then a bare tilde is used in rm -rf, so `~` resolves against
    // the *new* HOME (the sandbox itself) rather than the original outer
    // home -- the resulting target path never existed, so rm -rf is a no-op.
    execSync(
      [
        'export HOME=~/temp/.apra-fleet-tests',
        'rm -rf ~/temp/.apra-fleet-tests',
      ].join(' && '),
      {
        shell: '/bin/bash',
        env: { ...process.env, HOME: outerHome },
      },
    );

    // Demonstrates the bug: the sandbox directory and its marker survive.
    expect(fs.existsSync(sandboxDir)).toBe(true);
    expect(fs.existsSync(markerFile)).toBe(true);
  });
});
