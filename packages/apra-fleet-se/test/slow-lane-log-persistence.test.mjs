import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { buildIsolatedHomeEnv } from '../../../tests/helpers/isolated-home.mjs';

// On Windows, `child.kill('SIGTERM')` (Node emulates it via TerminateProcess)
// only terminates the top-level bash.exe handle -- it does not propagate to
// bash's own children (the subshell running the loop, sleep.exe, etc), so
// they keep running and racing with the test's log-file assertions. Killing
// the whole process tree via `taskkill /t` is the Windows equivalent of the
// POSIX `process.kill(-pid, 'SIGTERM')` process-group kill below.
function killProcessTree(child) {
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${child.pid} /t /f`, { stdio: 'ignore' });
    } catch (e) {
      // Process (or its tree) may have already exited; that's ok.
    }
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch (e) {
    // If kill fails, the process may have already exited; that's ok
  }
}

// apra-fleet-j918.8.13: polls `check()` until it returns truthy or
// `timeoutMs` elapses, instead of a fixed-duration sleep. Used before
// interrupting the child below so the wait is driven by the actual
// condition we care about (has the child produced output yet?) rather than
// a guessed duration that can flake when the machine is under load (too
// little accumulated output by the time we kill) or waste wall time when
// it isn't (the guessed duration was longer than necessary).
function waitForCondition(check, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    function poll() {
      let result;
      try { result = check(); } catch { result = false; }
      if (result) { resolve(true); return; }
      if (Date.now() >= deadline) { resolve(false); return; }
      setTimeout(poll, intervalMs);
    }
    poll();
  });
}

// apra-fleet-j918.8.13: waits for the child to settle (exit or error),
// falling back to `timeoutMs` only if neither ever fires -- matching the
// `waitForExit()` pattern already used in installed-supervisor.test.mjs.
// Unlike a bare `Promise.race([exitEvent, sleep(timeoutMs)])`, the losing
// timer is cleared the instant the winning event fires, so a child that
// exits quickly (the expected case here, right after killProcessTree())
// does not leave a dangling timer keeping the event loop alive for the
// full fallback duration.
function waitForChildSettled(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    const timer = setTimeout(() => {
      child.removeListener('exit', onDone);
      child.removeListener('error', onDone);
      resolve();
    }, timeoutMs);
    function onDone() {
      clearTimeout(timer);
      resolve();
    }
    child.once('exit', onDone);
    child.once('error', onDone);
  });
}

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
//
// apra-fleet-5co8.46: the redirect shape asserted against below (via the
// standalone shellScript/bareShellScript strings) was previously a hardcoded
// copy of regression-test-playbook.md's fenced slow-lane command, with no
// link back to the playbook text itself. That meant reverting the playbook
// to the bare, unredirected `npm run test:slow --workspace=@apralabs/apra-fleet-se`
// would not fail this file. The 'playbook redirect shape guards against
// regression' test below reads the playbook's own fenced block and asserts
// its actual current text still has the SLOW_LANE_LOG assignment, the
// grouped exit-marker echo INSIDE the braces, and the file redirect (not a
// pipe through tail), so a playbook regression is caught directly.
// =============================================================================

const PLAYBOOK_PATH = path.join(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..', '..', '..', 'regression-test-playbook.md'
);

// Extract the fenced ```bash ... ``` block that contains the SLOW_LANE_LOG
// assignment -- the playbook has several fenced bash blocks, so anchor on
// content, not position (positions shift as the playbook is edited).
function extractSlowLaneBlock(playbookText) {
  const fenceRe = /```bash\n([\s\S]*?)\n```/g;
  let match;
  while ((match = fenceRe.exec(playbookText)) !== null) {
    if (match[1].includes('SLOW_LANE_LOG=')) {
      return match[1];
    }
  }
  return null;
}

test('playbook redirect shape guards against regression', () => {
  const playbookText = fs.readFileSync(PLAYBOOK_PATH, 'utf-8');
  const block = extractSlowLaneBlock(playbookText);

  assert.ok(
    block,
    'regression-test-playbook.md should have a fenced bash block containing the SLOW_LANE_LOG assignment'
  );

  // The SLOW_LANE_LOG path assignment must still be present.
  assert.match(
    block,
    /SLOW_LANE_LOG=/,
    'playbook slow-lane block should assign SLOW_LANE_LOG'
  );

  // The exit-marker echo must be INSIDE the same command group as
  // `npm run test:slow`, not appended after a redirect that only wraps the
  // npm run call (see the "Reopen fix note" in the playbook: an echo outside
  // the group is never reached on interruption).
  assert.match(
    block,
    /\{\s*npm run test:slow[^}]*echo "test:slow exit=\$\?"[^}]*\}/,
    'exit-marker echo must be grouped with npm run test:slow inside the same { ... } braces'
  );

  // The group must be redirected to the log file with both stdout and
  // stderr captured, not piped through `tail` (a bare pipe loses everything
  // if the background shell is interrupted).
  assert.match(
    block,
    /\}\s*>\s*"\$SLOW_LANE_LOG"\s*2>&1/,
    'command group must redirect to "$SLOW_LANE_LOG" with 2>&1, not a bare stdout redirect'
  );

  assert.doesNotMatch(
    block,
    /\|\s*tail/,
    'command group must not pipe through tail as its primary invocation (that discards output on interruption)'
  );
});

test('slow-lane log persistence', async (t) => {
  // Create a sandbox HOME directory for this test
  const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'slow-lane-sandbox-'));
  const sandboxTempDir = path.join(sandboxHome, 'temp', '.apra-fleet-tests');
  const logFilePath = path.join(sandboxTempDir, 'test-slow-lane.log');

  // Snapshot the real HOME/temp directory before test (side-effect check)
  const realTempDir = path.join(os.homedir(), 'temp', '.apra-fleet-tests');
  let realTempContentBefore = null;
  try {
    realTempContentBefore = fs.readdirSync(realTempDir).sort();
  } catch (e) {
    // Directory doesn't exist or is unreadable; record as null for comparison
    if (e.code !== 'ENOENT') {
      throw e; // Re-throw if it's not ENOENT (e.g., permission error)
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
        env: buildIsolatedHomeEnv(sandboxHome, process.env)
      });

      // Wait for the log to actually gain output before interrupting,
      // rather than guessing a fixed duration is enough (apra-fleet-
      // j918.8.13) -- driven by the real condition, bounded so a genuinely
      // stuck process still fails within a reasonable ceiling.
      await waitForCondition(() => {
        try { return fs.readFileSync(logFilePath, 'utf-8').includes('Output line'); }
        catch { return false; }
      });

      // Interrupt the process (and its whole tree -- see killProcessTree)
      killProcessTree(child);

      // Wait for process to exit, event-driven with a bounded fallback
      // (apra-fleet-j918.8.13).
      await waitForChildSettled(child, 2000);

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
        env: buildIsolatedHomeEnv(sandboxHome, process.env)
      });

      // Unlike test 1 (where the script's own `>` redirect sends everything
      // straight to the log file, bypassing Node's piped stdio), this bare
      // script is NOT redirected, so its output actually arrives on
      // `child.stdout`. Wait for that real signal that the process has
      // started producing output before interrupting it, instead of
      // guessing a fixed duration (apra-fleet-j918.8.13).
      let sawOutput = false;
      child.stdout.on('data', () => { sawOutput = true; });
      await waitForCondition(() => sawOutput);

      killProcessTree(child);

      // Wait for exit, event-driven with a bounded fallback (apra-fleet-j918.8.13).
      await waitForChildSettled(child, 2000);

      // Criterion 4: Without redirection to the specific file, no log file is created
      // at the expected location
      assert.strictEqual(
        fs.existsSync(logFilePath),
        false,
        'Without the redirect, log file should not exist at the expected location'
      );
    });

    // Criterion 2 side-effect check: verify test didn't pollute the real HOME
    await t.test('cleanup does not pollute real HOME temp directory', () => {
      // Check real HOME/temp hasn't changed
      let realTempContentAfter = null;
      try {
        realTempContentAfter = fs.readdirSync(realTempDir).sort();
      } catch (e) {
        // Directory doesn't exist or is unreadable; record as null for comparison
        if (e.code !== 'ENOENT') {
          throw e; // Re-throw if it's not ENOENT (e.g., permission error)
        }
      }

      // Assert unconditionally: null === null (dir didn't exist before or after),
      // or arrays match (dir existed and unchanged)
      assert.deepStrictEqual(
        realTempContentAfter,
        realTempContentBefore,
        'Real HOME/temp/.apra-fleet-tests should not have been modified by test'
      );
    });
  } finally {
    // Cleanup (mimics playbook's Teardown)
    // force: true tolerates absence, so no guard needed
    fs.rmSync(sandboxHome, { recursive: true, force: true });
  }

  // Criterion 2 final check: sandbox should be completely removed after Teardown
  assert.strictEqual(
    fs.existsSync(sandboxHome),
    false,
    'Sandbox home should be completely removed after Teardown rmSync'
  );
});
