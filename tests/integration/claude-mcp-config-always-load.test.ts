/**
 * Opt-in check against the INSTALLED claude CLI: the per-session member MCP
 * config execute_prompt writes (with `alwaysLoad: true`) is accepted by the
 * CLI's --mcp-config parser, and a malformed `alwaysLoad` is rejected -- so
 * the check can tell "accepted" from "silently skipped".
 *
 * No paid LLM call: the CLI runs with --bare (API-key auth only) and an
 * invalid ANTHROPIC_API_KEY, its MCP config is read from its --debug-file,
 * and the process tree is killed as soon as the config verdict is logged.
 * The server URL is pointed at an unused port, so no fleet server is touched.
 *
 * Runs only with APRA_CLAUDE_CLI_CHECK=1 AND claude on PATH; otherwise skipped.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sessionMcpConfigContent, parseCliVersion, cliVersionAtLeast } from '../../src/services/session-mcp-config.js';
import { getProvider } from '../../src/providers/index.js';

const OPT_IN = process.env.APRA_CLAUDE_CLI_CHECK === '1';
const IS_WIN = process.platform === 'win32';

function installedClaudeVersion(): string | undefined {
  if (!OPT_IN) return undefined;
  const r = spawnSync('claude', ['--version'], { shell: IS_WIN, encoding: 'utf8', timeout: 30_000 });
  return r.status === 0 ? parseCliVersion(`${r.stdout}\n${r.stderr}`) : undefined;
}

const VERSION = installedClaudeVersion();
const ID = '00000000-0000-4000-8000-0000000000a1';
const SERVER = 'apra-fleet';
const ACCEPTED = `MCP server "${SERVER}": Initializing`;
const SKIPPED = `invalid MCP server config for "${SERVER}"`;

function killTree(pid: number): void {
  try {
    if (IS_WIN) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
    else process.kill(-pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/** Starts the CLI with `configBody` as its only MCP config; returns its debug log
 *  once it records a verdict for the server (accepted or skipped), or at the deadline. */
async function parseWithCli(dir: string, name: string, configBody: string): Promise<string> {
  const cfg = path.join(dir, `${name}.json`);
  const dbg = path.join(dir, `${name}.debug.txt`);
  fs.writeFileSync(cfg, configBody, 'utf-8');
  const child = spawn('claude', [
    '--bare', '--strict-mcp-config', '--no-session-persistence',
    '--mcp-config', cfg, '--debug-file', dbg,
    '-p', 'parse check', '--max-turns', '1',
  ], {
    cwd: dir,
    shell: IS_WIN,
    detached: !IS_WIN,
    stdio: 'ignore',
    env: { ...process.env, ANTHROPIC_API_KEY: 'sk-ant-invalid-apra-fleet-parse-check' },
  });
  const deadline = Date.now() + 45_000;
  let log = '';
  try {
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250));
      log = fs.existsSync(dbg) ? fs.readFileSync(dbg, 'utf-8') : '';
      if (log.includes(ACCEPTED) || log.includes(SKIPPED) || child.exitCode !== null) break;
    }
  } finally {
    if (child.pid) killTree(child.pid);
  }
  return fs.existsSync(dbg) ? fs.readFileSync(dbg, 'utf-8') : log;
}

/** The real config body, with the URL moved to an unused port. */
function realBody(alwaysLoad: unknown): string {
  const parsed = JSON.parse(sessionMcpConfigContent({ id: ID, agentType: 'remote' }, { alwaysLoad: true }));
  const entry = parsed.mcpServers[SERVER];
  entry.url = `http://127.0.0.1:1/mcp?member=${ID}`;
  entry.alwaysLoad = alwaysLoad;
  return JSON.stringify(parsed);
}

describe.skipIf(!VERSION)('installed claude CLI accepts the per-session member MCP config', () => {
  let dir = '';
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-claude-mcp-parse-')); });
  afterAll(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  it('the installed CLI is at or above the always-load floor', () => {
    expect(cliVersionAtLeast(VERSION!, getProvider('claude').mcpAlwaysLoadMinVersion!())).toBe(true);
  });

  it('the config execute_prompt writes (alwaysLoad: true) is accepted, not skipped', async () => {
    const log = await parseWithCli(dir, 'real', realBody(true));
    expect(log).not.toContain(SKIPPED);
    expect(log).toContain(ACCEPTED);
  }, 60_000);

  it('control: a malformed alwaysLoad makes the CLI skip the server, so the check above is not vacuous', async () => {
    const log = await parseWithCli(dir, 'malformed', realBody('yes'));
    expect(log).toContain(SKIPPED);
    expect(log).toMatch(/alwaysLoad: expected boolean/);
    expect(log).not.toContain(ACCEPTED);
  }, 60_000);
});
