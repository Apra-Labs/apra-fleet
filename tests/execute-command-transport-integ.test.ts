import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';
import { addAgent } from '../src/services/registry.js';
import { executeCommand } from '../src/tools/execute-command.js';
import { findRealBash } from './helpers/real-bash.js';
// @ts-expect-error -- plain .mjs shared with .github/e2e/fleet-setup.mjs
import { runExecWrapperChecks } from '../.github/e2e/exec-wrapper-checks.mjs';

// Runs the SAME execute_command wrapper checks the self-hosted e2e suites run
// against remote members (.github/e2e/fleet-setup.mjs, T2-exec-wrapper), here
// against a LOCAL member through the real, unmocked LocalStrategy: local
// linux / local macOS on POSIX CI runners, local Git Bash on Windows.

const isWin = process.platform === 'win32';
const bash = findRealBash();
const skipReason = isWin && !bash.path ? bash.reason : undefined;
if (skipReason) console.warn(`[execute-command-transport-integ] skipping: ${skipReason}`);

describe.skipIf(!!skipReason)('execute_command wrapper checks on a real local member', () => {
  let workDir: string;
  const name = `exec-wrap-local-${process.pid}`;
  const memberOs = isWin ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

  beforeAll(() => {
    backupAndResetRegistry();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-ec-integ-'));
    addAgent(makeTestLocalAgent({
      friendlyName: name,
      workFolder: workDir,
      os: memberOs,
      ...(isWin ? { shell: 'gitbash' as const } : {}),
    }));
  });

  afterAll(() => {
    restoreRegistry();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('heredoc at end, `a & pwd`, exit 3 and timeout tree-kill', async () => {
    const fleetApi = {
      executeCommand: async (o: { member_name: string; command: string; timeout_s?: number }) => {
        const r = await executeCommand({ member_name: o.member_name, command: o.command, timeout_s: o.timeout_s ?? 60 } as any);
        return typeof r === 'string'
          ? { content: [{ type: 'text', text: r }] }
          : { content: [{ type: 'text', text: r.text }], structuredContent: r.structuredContent };
      },
    };
    const results: Array<{ id: string; status: string; notes: string }> = await runExecWrapperChecks(
      fleetApi, { name, os: memberOs, type: 'local' }, { timeoutS: 3, killWaitMs: 10000 },
    );
    for (const r of results) console.log(`[exec-wrapper ${memberOs}/local] ${r.id}: ${r.status} -- ${r.notes}`);
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    expect(byId['exit-3'].status).toBe('PASS');
    expect(byId['heredoc-at-end'].status, byId['heredoc-at-end'].notes).toBe('PASS');
    expect(byId['bg-then-pwd'].status, byId['bg-then-pwd'].notes).toBe('PASS');
    // Local Windows timeout kill is Node's taskkill of child.pid (unchanged);
    // it is allowed to report the known MSYS-exec gap, but must not FAIL.
    expect(['PASS', ...(isWin ? ['KNOWN_GAP'] : [])], byId['timeout-tree-kill'].notes).toContain(byId['timeout-tree-kill'].status);
  }, 120000);
});
