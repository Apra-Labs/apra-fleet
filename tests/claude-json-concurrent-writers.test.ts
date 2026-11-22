/**
 * Concurrent writers of one claude.json keep each other's edits, and the
 * install/upgrade path prunes exactly the project keys older test runs leaked.
 *
 * Interleavings are deterministic: the second writer runs at the exact point
 * between the first writer's read and its replace. Every file lives in a
 * fresh temp dir; HOME/USERPROFILE point there and CLAUDE_CONFIG_DIR is unset.
 * The real ~/.claude.json is never touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeProvider } from '../src/providers/claude.js';
import { registerClaudeHttpMcp, pruneLeakedClaudeTestProjects } from '../src/cli/install.js';
import { refreshClaudeLocalScopeEntries } from '../src/services/claude-local-scope-mcp.js';
import type { SSHExecResult } from '../src/types.js';
import { parseLandingMove } from './helpers/landing-move.js';

let hasBash = true;
try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); } catch { hasBash = false; }

const HEADER = 'X-Apra-Fleet-Member-Secret';
const URL_ = 'http://localhost:7523/mcp';

let tmpHome: string;
let file: string;
let childEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-claude-race-'));
  vi.stubEnv('HOME', tmpHome);
  vi.stubEnv('USERPROFILE', tmpHome);
  delete process.env.CLAUDE_CONFIG_DIR;
  childEnv = { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome };
  delete childEnv.CLAUDE_CONFIG_DIR;
  file = path.join(tmpHome, '.claude.json');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const fwd = (p: string) => p.replace(/\\/g, '/');
const readJson = () => JSON.parse(fs.readFileSync(file, 'utf8'));

describe('two writers racing on one claude.json keep both deltas', () => {
  it.runIf(hasBash)('member-side MCP entry sync (real bash) vs the local install registration landing between its re-read and move', async () => {
    fs.writeFileSync(file, JSON.stringify({ projects: {} }, null, 2));
    const work = fwd(path.join(tmpHome, 'work'));
    let raced = 0;
    const exec = (cmd: string): Promise<SSHExecResult> => {
      if (parseLandingMove(cmd) && raced++ === 0) registerClaudeHttpMcp(URL_, { [HEADER]: 'install-secret' });
      return new Promise((resolve) => {
        execFile('bash', ['-c', cmd], { encoding: 'utf8', env: childEnv }, (err, stdout, stderr) => {
          resolve({ stdout, stderr, code: err ? (typeof (err as any).code === 'number' ? (err as any).code : 1) : 0 });
        });
      });
    };
    const memberUrl = 'http://127.0.0.1:1/mcp?member=m1';
    await new ClaudeProvider().syncMemberMcpEntry({
      agent: { id: 'm1', workFolder: work } as any,
      execCommand: exec,
      memberHomeDir: fwd(tmpHome),
      agentOs: 'linux',
      url: memberUrl,
      transport: { writeHomeFile: async (rel, content) => { fs.writeFileSync(path.join(tmpHome, rel), content); } },
    });

    expect(raced).toBe(2);
    const j = readJson();
    expect(j.mcpServers['apra-fleet']).toEqual({ type: 'http', url: URL_, headers: { [HEADER]: 'install-secret' } });
    expect(j.projects[work].mcpServers['apra-fleet']).toEqual({ type: 'http', url: memberUrl });
    expect(fs.readdirSync(tmpHome).filter(n => n !== '.claude.json')).toEqual([]);
  });

  it('two local writers: the local-scope refresh lands between the install registration read and its replace', () => {
    fs.writeFileSync(file, JSON.stringify({ projects: { '/w/p': { mcpServers: { 'apra-fleet': { type: 'http', url: URL_ } } } } }, null, 2));
    const real = fs.writeFileSync;
    let raced = 0;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, data: any, opts?: any) => {
      real(p, data, opts);
      if (typeof p === 'string' && path.basename(p).includes('.claude.json.') && p.endsWith('.tmp') && raced++ === 0) {
        expect(refreshClaudeLocalScopeEntries(file, URL_, { [HEADER]: 'refresh-secret' })).toEqual(['/w/p']);
      }
    }) as typeof fs.writeFileSync);
    registerClaudeHttpMcp(URL_, { [HEADER]: 'install-secret' });
    vi.restoreAllMocks();

    const j = readJson();
    expect(j.mcpServers['apra-fleet'].headers).toEqual({ [HEADER]: 'install-secret' });
    expect(j.projects['/w/p'].mcpServers['apra-fleet'].headers).toEqual({ [HEADER]: 'refresh-secret' });
    expect(fs.readdirSync(tmpHome)).toEqual(['.claude.json']);
  });
});

describe('install/upgrade prune of leaked test project keys', () => {
  it('removes exactly the N leaked keys from the claude config, reports the count, and removes 0 on a second run', () => {
    const tmp = os.tmpdir();
    const leaked = [
      path.join(tmp, 'apra-fleet-regmember-compose-Ab12Cd'),
      path.join(tmp, 'apra-fleet-regmember-compose-Ef34Gh').replace(/\\/g, '/'),
      path.join(tmp, 'apra-fleet-bootstrap-gate-Ij56Kl'),
      path.join(tmp, 'apra-fleet-bootstrap-gate-Mn78Op').replace(/\\/g, '/'),
    ];
    const real = {
      '/home/dev/src/apra-fleet': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] },
      'C:/Users/dev/src/apra-fleet-regmember-compose-tool': { history: ['x'] },
      [path.join(tmp, 'scratch-project')]: { hasTrustDialogAccepted: true },
    };
    const projects: Record<string, unknown> = { ...real };
    for (const k of leaked) projects[k] = { hasTrustDialogAccepted: true };
    fs.writeFileSync(file, JSON.stringify({ numStartups: 4, projects }, null, 2));

    const logs: string[] = [];
    expect(pruneLeakedClaudeTestProjects(m => logs.push(m))).toBe(leaked.length);
    expect(logs.join('\n')).toContain(`removed ${leaked.length} `);
    const j = readJson();
    expect(j.projects).toEqual(real);
    expect(j.numStartups).toBe(4);

    expect(pruneLeakedClaudeTestProjects(m => logs.push(m))).toBe(0);
    expect(readJson()).toEqual(j);
  });
});
