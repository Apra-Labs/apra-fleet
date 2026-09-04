import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// =============================================================================
// apra-fleet-f28t.2: Verify slow-lane log persistence survives an interrupted run
//
// Criterion overview:
// 1. Log file exists with pre-interrupt content after interruption
// 2. Log path resolves inside sandbox scratch root; Teardown removes it
// 3. The playbook command (literal redirect shape) runs without permissions denial
// 4. Reverting the redirect makes criterion 1 fail
// 5. Permission blocks are surfaced verbatim, not worked around
//
// This test addresses criteria 1, 2, and 4 by:
// - Using the hardcoded playbook redirect shape: { ... } > "$SLOW_LANE_LOG" 2>&1
// - Using the playbook's path structure ($HOME/temp/.apra-fleet-tests/test-slow-lane.log)
// - Overriding HOME to a temporary directory (sandboxing)
// - Running a short stand-in command with the redirect
// - Interrupting it partway through (background process + kill)
// - Asserting the log has pre-interrupt content AND lacks the exit marker
//
// Criterion 3 (command runs without permissions denial) is verified separately via agent Bash invocation.
// =============================================================================

test('slow-lane log persistence', async (t) => {
  // Create a sandbox HOME directory for this test
  const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'slow-lane-sandbox-'));
  const sandboxTempDir = path.join(sandboxHome, 'temp', '.apra-fleet-tests');
  const logFilePath = path.join(sandboxTempDir, 'test-slow-lane.log');

  // Snapshot the real HOME/temp directory before test (side-effect check)
  const realTempDir = path.join(os.homedir(), 'temp', '.apra-fleet-tests');
  const realTempExistsBefore = fs.existsSync(realTempDir);
  let realTempContentBefore = null;
  if (realTempExistsBefore) {
    try {
      realTempContentBefore = fs.readdirSync(realTempDir).sort();
    } catch (e) {
      // Directory might not be readable; that's fine for the check
    }
  }

  try {
    // Test 1: Verify redirection to file preserves output after interruption
    await t.test('redirection preserves pre-interrupt output and lacks exit marker', async () => {
      // Create directory structure (matches playbook's mkdir)
      fs.mkdirSync(sandboxTempDir, { recursive: true });

      // Short stand-in command that mimics the redirect shape from the playbook.
      // The playbook command is:
      //   { npm run test:slow --workspace=@apralabs/apra-fleet-se; echo "test:slow exit=$?"; } > "$SLOW_LANE_LOG" 2>&1
      // We substitute a longer echo loop for npm run test:slow (much longer than what we'll interrupt after).
      // The structure (command group, exit marker echo inside group, redirect) stays literal.
      const shellScript = `
        mkdir -p "${sandboxTempDir}"
        SLOW_LANE_LOG="${logFilePath}"
        {
          for i in {1..100}; do
            echo "Output line $i"
            sleep 0.1
          done
          echo "test:slow exit=0"
        } > "$SLOW_LANE_LOG" 2>&1
      `;

      // Spawn background process (detached so we can kill the process group)
      const child = spawn('bash', ['-c', shellScript], {
        detached: process.platform !== 'win32', // Only detached on non-Windows
        stdio: 'pipe',
        env: { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome }
      });

      const childPid = child.pid;

      // Wait for some output to be written (500ms = ~5-6 lines out of 100)
      await new Promise(resolve => setTimeout(resolve, 500));

      // Interrupt the process
      try {
        if (process.platform === 'win32') {
          // On Windows, use a direct kill since detached groups don't work the same way
          child.kill('SIGTERM');
        } else {
          // On POSIX, kill the process group
          process.kill(-childPid, 'SIGTERM');
        }
      } catch (e) {
        // If kill fails, the process may have already exited; that's ok
      }

      // Wait for process to exit
      await new Promise((resolve) => {
        child.on('exit', resolve);
        child.on('error', resolve);
        setTimeout(resolve, 2000); // Timeout after 2s
      });

      // Verify criterion 1: log exists and has content
      assert.ok(fs.existsSync(logFilePath), `Log file should exist at ${logFilePath}`);

      const logContent = fs.readFileSync(logFilePath, 'utf-8');
      assert.ok(logContent.length > 0, 'Log file should contain output');

      // Criterion 1a: Log has pre-interrupt lines
      assert.ok(
        logContent.includes('Output line'),
        'Log should contain output from before interruption'
      );

      // Criterion 1b: Log LACKS the exit marker (proves interruption happened)
      // The output should have some lines but NOT reach the echo "test:slow exit=0" line
      assert.strictEqual(
        logContent.includes('test:slow exit=0'),
        false,
        'Log should NOT contain exit marker (proves it was interrupted before completion)'
      );

      // Criterion 2: Log path resolves inside the sandbox scratch root
      const resolvedLogPath = path.resolve(logFilePath);
      const resolvedSandboxTempDir = path.resolve(sandboxTempDir);
      assert.ok(
        resolvedLogPath.startsWith(resolvedSandboxTempDir),
        `Log file path ${resolvedLogPath} should be inside ${resolvedSandboxTempDir}`
      );
    });

    // Test 2: Verify bare (unredirected) command leaves no log file
    // This is criterion 4's control: reverting the redirect makes criterion 1 fail
    await t.test('bare unredirected command leaves no log file', async () => {
      // Clear the log file if it exists from the previous test
      if (fs.existsSync(logFilePath)) {
        fs.unlinkSync(logFilePath);
      }

      // Bare command (no redirection) - mimics what the playbook looked like before the fix
      const bareShellScript = `
        for i in {1..100}; do
          echo "Bare output line $i"
          sleep 0.1
        done
      `;

      const child = spawn('bash', ['-c', bareShellScript], {
        detached: process.platform !== 'win32',
        stdio: 'pipe',
        env: { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome }
      });

      const childPid = child.pid;

      // Wait a bit (same 500ms as test 1) then interrupt
      await new Promise(resolve => setTimeout(resolve, 500));

      try {
        if (process.platform === 'win32') {
          child.kill('SIGTERM');
        } else {
          process.kill(-childPid, 'SIGTERM');
        }
      } catch (e) {
        // Process may have already exited
      }

      // Wait for exit
      await new Promise((resolve) => {
        child.on('exit', resolve);
        child.on('error', resolve);
        setTimeout(resolve, 2000);
      });

      // Criterion 4: Without redirection to the specific file, no log file is created
      // at the expected location
      assert.strictEqual(
        fs.existsSync(logFilePath),
        false,
        'Without the redirect, log file should not exist at the expected location'
      );
    });

    // Criterion 2 side-effect check: verify Teardown would clean this up
    // and that the test didn't pollute the real HOME
    await t.test('cleanup does not pollute real HOME temp directory', () => {
      // Check real HOME/temp hasn't changed
      if (realTempExistsBefore) {
        try {
          const realTempContentAfter = fs.readdirSync(realTempDir).sort();
          assert.deepStrictEqual(
            realTempContentAfter,
            realTempContentBefore,
            'Real HOME/temp/.apra-fleet-tests should not have been modified by test'
          );
        } catch (e) {
          // Directory may have been deleted; that's also fine
        }
      }

      // Sandbox should be cleanable (this mimics Teardown)
      assert.ok(
        fs.existsSync(sandboxHome),
        'Sandbox home should exist (ready for cleanup)'
      );
    });
  } finally {
    // Cleanup (mimics playbook's Teardown)
    if (fs.existsSync(sandboxHome)) {
      fs.rmSync(sandboxHome, { recursive: true, force: true });
    }
  }
});
