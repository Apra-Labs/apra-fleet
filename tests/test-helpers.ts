/**
 * Shared test helpers for registry-backed tests.
 * Eliminates duplicated makeAgent/beforeEach/afterEach patterns.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Agent, SSHExecResult } from '../src/types.js';

/**
 * A strategy.execCommand implementation that simulates a real member filesystem
 * for the config files compose_permissions delivers.
 *
 * compose_permissions now reads every config file back after writing it and
 * fails loudly if the intended content did not land (apra-fleet-k4sc). Tests
 * that drive the REAL compose_permissions (e.g. via register_member) through a
 * generic `execCommand` stub used to pass only because the write was a silent
 * no-op; with verification in place they must serve a written file back on read.
 *
 * This handler records what a write persists (POSIX heredoc or Windows
 * WriteAllText) and returns it on the matching read (cat / Get-Content). Any
 * other command returns `defaultStdout` (default 'Linux', matching the OS-detect
 * stub these tests already relied on) with exit code 0.
 */
export function makeConfigAwareExec(defaultStdout = 'Linux'): (cmd: string, ...rest: unknown[]) => Promise<SSHExecResult> {
  const files = new Map<string, string>();
  return async (cmd: string): Promise<SSHExecResult> => {
    // POSIX write (heredoc)
    let m = cmd.match(/^cat > (.+?) << 'FLEET_PERMS_EOF'\n([\s\S]*)\nFLEET_PERMS_EOF$/);
    if (m) { files.set(m[1], m[2]); return { stdout: '', stderr: '', code: 0 }; }
    // Windows write (WriteAllText); PowerShell single-quote escaping doubles quotes
    m = cmd.match(/\[System\.IO\.File\]::WriteAllText\("(.+?)", '([\s\S]*)', \(New-Object System\.Text\.UTF8Encoding\(\$false\)\)\)/);
    if (m) { files.set(m[1], m[2].replace(/''/g, "'")); return { stdout: '', stderr: '', code: 0 }; }
    // POSIX read (cat <path> 2>/dev/null ...) -- merge-read and read-back
    m = cmd.match(/^cat (.+?) 2>\/dev\/null/);
    if (m) { return { stdout: files.get(m[1]) ?? '', stderr: '', code: 0 }; }
    // Windows read (Get-Content -Raw "<path>" ...)
    m = cmd.match(/Get-Content -Raw "(.+?)"/);
    if (m) { return { stdout: files.get(m[1]) ?? '', stderr: '', code: 0 }; }
    // OS detection, CLI checks, mkdir, ls, workspace-trust, everything else
    return { stdout: defaultStdout, stderr: '', code: 0 };
  };
}

export const FLEET_DIR = process.env.APRA_FLEET_DATA_DIR ?? path.join(os.tmpdir(), 'apra-fleet-test-data');
export const REGISTRY_PATH = path.join(FLEET_DIR, 'registry.json');

let backupContent: string | null = null;

/**
 * executeCommand() can return either a plain string or { text, structuredContent }
 * (see ExecuteCommandResult in src/tools/execute-command.ts). Tests that only care
 * about the human-readable display text should normalize through this helper
 * rather than asserting on the raw return value directly.
 */
export function resultText(result: string | { text: string; structuredContent?: unknown }): string {
  return typeof result === 'string' ? result : result.text;
}

/**
 * Create a test agent with sensible defaults and optional overrides.
 * Works for both remote and local agent tests.
 */
export function makeTestAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: `test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    friendlyName: 'test-agent',
    agentType: 'remote',
    host: '192.168.1.100',
    port: 22,
    username: 'testuser',
    authType: 'password',
    encryptedPassword: 'fake-encrypted',
    workFolder: '/home/testuser/project',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Create a local test agent with sensible defaults.
 */
export function makeTestLocalAgent(overrides: Partial<Agent> = {}): Agent {
  return makeTestAgent({
    agentType: 'local',
    host: undefined,
    port: undefined,
    username: undefined,
    authType: undefined,
    encryptedPassword: undefined,
    workFolder: path.join(os.tmpdir(), `fleet-test-${Date.now()}`),
    os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
    ...overrides,
  });
}

/**
 * Back up the existing registry and reset to empty.
 * Call in beforeEach.
 */
export function backupAndResetRegistry(): void {
  if (fs.existsSync(REGISTRY_PATH)) {
    backupContent = fs.readFileSync(REGISTRY_PATH, 'utf-8');
  }
  if (!fs.existsSync(FLEET_DIR)) {
    fs.mkdirSync(FLEET_DIR, { recursive: true });
  }
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ version: '1.0', agents: [] }, null, 2));
}

/**
 * Restore the registry from backup.
 * Call in afterEach.
 */
export function restoreRegistry(): void {
  if (backupContent !== null) {
    fs.writeFileSync(REGISTRY_PATH, backupContent);
    backupContent = null;
  } else if (fs.existsSync(REGISTRY_PATH)) {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ version: '1.0', agents: [] }, null, 2));
  }
}
