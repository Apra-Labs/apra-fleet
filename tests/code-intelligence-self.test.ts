import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// code (self) resolution through the REAL registered code_* closures (a
// minimal fake McpServer records what registerAllTools registers): no code_*
// tool takes a repo argument, and the folder a call is about is the calling
// session's own --
//   MEMBER session -> that member's registered work folder
//   FULL session   -> the server working folder (process.cwd(), stubbed here)
// A fake provider records params.repo so "which index answered" is observable.
//
// Isolation: the registry is the isolated test registry; the global
// code-intel config read (~/.apra-fleet/data/code-intelligence/config.json)
// is intercepted so the FULL session also routes to the fake provider and the
// real home dir is never read for it; recordUsage is mocked so no telemetry
// is written. Temp repos live under one scratch dir removed in afterAll.

const recordUsageSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/tools/code-intelligence-telemetry.js', () => ({ recordUsage: recordUsageSpy }));
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const readFile = (async (p: unknown, ...rest: unknown[]) => {
    if (typeof p === 'string' && p.replace(/\\/g, '/').endsWith('code-intelligence/config.json')) {
      return JSON.stringify({ provider: 'fake-self-recorder' });
    }
    return (actual.readFile as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
  }) as typeof actual.readFile;
  return { ...actual, default: { ...actual, readFile }, readFile };
});

import { registerAllTools } from '../src/services/tool-registry.js';
import { PROVIDERS, type CodeIntelligenceProvider } from '../src/tools/code-intelligence.js';
import { memberToolScope, type ToolScope } from '../src/services/tool-scope.js';
import { addAgent } from '../src/services/registry.js';
import { makeTestLocalAgent, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

type ToolHandler = (input: unknown, extra?: unknown) => Promise<{ content: { type: string; text: string }[] }>;

const seenRepos: string[] = [];
const fakeProvider: CodeIntelligenceProvider = Object.fromEntries(
  ['graph', 'impact', 'query', 'context', 'map', 'flow', 'tests'].map(m => [m, async (params: Record<string, unknown>) => {
    seenRepos.push(String(params.repo));
    return { content: [{ type: 'text', text: `index of ${String(params.repo)}` }] };
  }]),
) as unknown as CodeIntelligenceProvider;

async function codeTool(name: string, scope?: ToolScope): Promise<ToolHandler> {
  const registered = new Map<string, ToolHandler>();
  const fakeServer = {
    tool: (n: string, _d: string, _s: unknown, handler: ToolHandler) => { registered.set(n, handler); },
    server: { sendLoggingMessage: async () => {} },
  };
  await registerAllTools(fakeServer as never, scope);
  return registered.get(name)!;
}

let scratch: string;
const folders: Record<string, string> = {};
const members: Record<string, string> = {};

function gitRepo(name: string): string {
  const dir = path.join(scratch, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

function register(key: string, workFolder: string): void {
  const agent = makeTestLocalAgent({ friendlyName: `code-self-${key}`, workFolder, codeIntelProvider: 'fake-self-recorder' });
  addAgent(agent);
  members[key] = agent.id;
  folders[key] = workFolder;
}

beforeAll(() => {
  backupAndResetRegistry();
  PROVIDERS['fake-self-recorder'] = fakeProvider;
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-self-')));
  folders.server = gitRepo('server');
  register('alpha', gitRepo('alpha'));
  register('beta', gitRepo('beta'));
  register('missing', path.join(scratch, 'no-such-folder'));
  const plain = path.join(scratch, 'plain');
  fs.mkdirSync(plain);
  register('plain', plain);
});

afterAll(() => {
  delete PROVIDERS['fake-self-recorder'];
  restoreRegistry();
  fs.rmSync(scratch, { recursive: true, force: true });
});

beforeEach(() => {
  seenRepos.length = 0;
  recordUsageSpy.mockReset();
  vi.spyOn(process, 'cwd').mockReturnValue(folders.server);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('code (self): each session is answered from its own folder', () => {
  it('two MEMBER sessions on one server: code_query hits each member\'s own index', async () => {
    const alphaQuery = await codeTool('code_query', memberToolScope(members.alpha, false));
    const betaQuery = await codeTool('code_query', memberToolScope(members.beta, false));

    const a = await alphaQuery({ query: 'widget' });
    const b = await betaQuery({ query: 'widget' });

    expect(seenRepos).toEqual([folders.alpha, folders.beta]);
    // Parse the folder path through JSON stringification to handle escaped backslashes on Windows
    expect(a.content.at(-1)!.text).toContain(`index of ${JSON.stringify(folders.alpha).slice(1, -1)}`);
    expect(b.content.at(-1)!.text).toContain(`index of ${JSON.stringify(folders.beta).slice(1, -1)}`);
    expect(recordUsageSpy.mock.calls.map(c => c[2])).toEqual([folders.alpha, folders.beta]);
  });

  it('path assertions work correctly with Windows-style backslashes (JSON-escaped)', async () => {
    // Simulate a Windows-style path and verify our assertion method handles it correctly
    const windowsPath = 'C:\\Users\\test\\project';
    // Simulate what the tool returns: JSON.stringify of a structured result containing the path
    const toolResultJson = JSON.stringify({ content: [{ type: 'text', text: `index of ${windowsPath}` }] });
    // The MCP tool returns this JSON string as text, so consumers receive it stringified.
    // To verify the path is present, we must compare against the JSON-escaped version,
    // which is what JSON.stringify(windowsPath).slice(1,-1) produces.
    expect(toolResultJson).toContain(`index of ${JSON.stringify(windowsPath).slice(1, -1)}`);
    // Also verify that a bare raw-path assertion WOULD fail (proving the fix is necessary):
    // the raw path contains single backslashes, but the JSON string contains escaped ones.
    expect(toolResultJson).not.toContain(`index of ${windowsPath}`);
  });

  it('a FULL session\'s code_query resolves to the server working folder', async () => {
    const fullQuery = await codeTool('code_query');
    await fullQuery({ query: 'widget' });
    expect(seenRepos).toEqual([folders.server]);
  });

  it('a repo key smuggled onto the input is ignored -- the (self) folder wins', async () => {
    const alphaQuery = await codeTool('code_query', memberToolScope(members.alpha, false));
    await alphaQuery({ query: 'widget', repo: folders.beta });
    expect(seenRepos).toEqual([folders.alpha]);
  });
});

describe('code (self): typed E-SELF errors from the shared resolver', () => {
  it('E-SELF-NO-WORKFOLDER when the member work folder does not exist (no fallback to the server folder)', async () => {
    const q = await codeTool('code_query', memberToolScope(members.missing, false));
    await expect(q({ query: 'x' })).rejects.toThrow(/E-SELF-NO-WORKFOLDER: .*no-such-folder.* Remediation: Create the folder/);
    expect(seenRepos).toEqual([]);
  });

  it('E-SELF-NOT-A-REPO when the member work folder is not a git repository', async () => {
    const q = await codeTool('code_query', memberToolScope(members.plain, false));
    await expect(q({ query: 'x' })).rejects.toThrow(/E-SELF-NOT-A-REPO: .* Remediation: Run 'git init'/);
    expect(seenRepos).toEqual([]);
  });

  it('E-SELF-NO-WORKFOLDER for a MEMBER session whose member is not registered', async () => {
    const q = await codeTool('code_query', memberToolScope('00000000-0000-0000-0000-00000000dead', false));
    await expect(q({ query: 'x' })).rejects.toThrow(/E-SELF-NO-WORKFOLDER/);
    expect(seenRepos).toEqual([]);
  });

  it('no origin remote is required for code tools (unlike kb tools)', async () => {
    const q = await codeTool('code_query', memberToolScope(members.alpha, false));
    await expect(q({ query: 'x' })).resolves.toBeDefined();
  });
});
