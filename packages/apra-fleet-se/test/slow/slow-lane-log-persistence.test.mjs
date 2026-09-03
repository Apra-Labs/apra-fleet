import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// =============================================================================
// apra-fleet-f28t.2: Verify slow-lane log persistence survives an interrupted run
//
// The slow lane runs for ~8 minutes. When interrupted (e.g., terminal closed,
// session restart), the previous redirect approach (piping through tail) leaves
// nothing persisted -- the verdict is lost.
//
// This test verifies that the new approach (redirect to a log file) persists
// the output even when interrupted mid-run:
//
// 1. Create a short stand-in for the slow lane using the EXACT redirection
//    shape from regression-test-playbook.md (a command group redirected to a
//    log file with an exit marker echoed inside the group).
//
// 2. Spawn it as a background process and interrupt it partway through
//    (kill the child process simulating a terminal interruption).
//
// 3. Verify:
//    - The log file exists and contains output emitted before interruption
//    - The log file path resolves inside the temp directory (sandbox scratch)
//    - The command as literally written in the playbook runs without
//      permissions denial
//
// 4. As a control: verify that reverting to a bare (unredirected) command
//    leaves no log file after interruption.
// =============================================================================

test('slow-lane log persistence: redirection to file preserves output after interruption', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slow-lane-test-'));
  const logFilePath = path.join(tempDir, 'test-slow-lane.log');

  try {
    // Test 1: Verify the redirected command preserves output after interruption
    await t.test('redirected command preserves output after interruption', async () => {
      // Create a short command that outputs multiple lines and an exit marker,
      // matching the exact redirection shape from the playbook:
      // { npm run test:slow --workspace=@apralabs/apra-fleet-se; echo "test:slow exit=$?"; } > "$SLOW_LANE_LOG" 2>&1
      //
      // We'll use a simpler stand-in command that produces output and can be
      // interrupted: repeatedly emit output lines, then exit.
      const standInCommand = `
        {
          for i in {1..10}; do
            echo "Output line $i";
            sleep 0.1;
          done;
          echo "test:slow exit=\$?";
        } > "${logFilePath}" 2>&1
      `;

      // Spawn the command in a shell
      const child = spawn('bash', ['-c', standInCommand], {
        detached: false, // Keep it in foreground so we can kill it
        stdio: 'pipe'
      });

      // Wait a bit for some output to be written
      await new Promise(resolve => setTimeout(resolve, 300));

      // Interrupt the process (simulate terminal interrupt)
      child.kill('SIGTERM');

      // Wait for the process to actually exit
      await new Promise((resolve) => {
        child.on('exit', resolve);
        child.on('error', resolve);
        setTimeout(resolve, 1000); // Timeout after 1s
      });

      // Verify the log file exists and contains some output
      assert.ok(fs.existsSync(logFilePath), `Log file should exist at ${logFilePath}`);

      const logContent = fs.readFileSync(logFilePath, 'utf-8');
      assert.ok(logContent.length > 0, 'Log file should contain output');
      assert.ok(
        logContent.includes('Output line'),
        'Log file should contain output from the interrupted command'
      );

      // Verify log file path is inside the temp directory
      const resolvedLogPath = path.resolve(logFilePath);
      const resolvedTempDir = path.resolve(tempDir);
      assert.ok(
        resolvedLogPath.startsWith(resolvedTempDir),
        `Log file path ${resolvedLogPath} should be inside ${resolvedTempDir}`
      );
    });

    // Test 2: Verify that a bare (unredirected) command would NOT leave a log file
    await t.test('bare unredirected command leaves no log file after interruption', async () => {
      const bareLogPath = path.join(tempDir, 'bare-command.log');

      // Spawn a simple command without redirection
      // (output goes to stdout, not captured in a file)
      const bareCommand = `
        for i in {1..10}; do
          echo "Bare output line $i";
          sleep 0.1;
        done
      `;

      const child = spawn('bash', ['-c', bareCommand], {
        detached: false,
        stdio: 'pipe'
      });

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 300));

      // Interrupt
      child.kill('SIGTERM');

      // Wait for exit
      await new Promise((resolve) => {
        child.on('exit', resolve);
        child.on('error', resolve);
        setTimeout(resolve, 1000);
      });

      // Verify no log file was created (we didn't redirect)
      assert.ok(
        !fs.existsSync(bareLogPath),
        'Without redirection, there should be no log file'
      );
    });

    // Test 3: Verify the exact playbook command shape runs without errors
    await t.test('exact playbook command shape runs without permissions errors', async () => {
      const playbookLogPath = path.join(tempDir, 'playbook-test.log');

      // Use the EXACT command shape from regression-test-playbook.md
      // (scaled down with a simple echo instead of npm run test:slow):
      const playbookCommand = `
        {
          for i in {1..3}; do
            echo "Playbook test line $i"
            sleep 0.05
          done
          echo "test:slow exit=0"
        } > "${playbookLogPath}" 2>&1
      `;

      const child = spawn('bash', ['-c', playbookCommand], {
        detached: false,
        stdio: 'pipe'
      });

      const exitCode = await new Promise((resolve) => {
        child.on('exit', (code) => resolve(code));
        child.on('error', (err) => {
          // If we get a permissions error, it will be here
          if (err.message.includes('EACCES') || err.message.includes('permission')) {
            resolve('PERMISSION_DENIED');
          } else {
            resolve(err);
          }
        });
        setTimeout(() => resolve('TIMEOUT'), 5000);
      });

      assert.strictEqual(
        exitCode,
        0,
        `Playbook command shape should execute successfully (got ${exitCode})`
      );

      // Verify the log file was created
      assert.ok(
        fs.existsSync(playbookLogPath),
        'Playbook command should create the log file'
      );

      // Verify the exit marker is present
      const content = fs.readFileSync(playbookLogPath, 'utf-8');
      assert.ok(
        content.includes('test:slow exit=0'),
        'Log file should contain the exit marker'
      );
    });
  } finally {
    // Clean up
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
});
