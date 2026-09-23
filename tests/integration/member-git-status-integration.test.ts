/**
 * [test] apra-fleet-4qtu.3.3: end-to-end verification of member_git_status
 * (apra-fleet-4qtu.3.1/.3.2) against REAL git work trees on the LOCAL member.
 *
 * The unit-level builder/parser cases live in tests/member-git-status.test.ts;
 * this suite owns the live-execution half: temp repositories are built here
 * with real git commands, the REGISTERED tool closure
 * (src/services/tool-registry.ts's server.tool('member_git_status', ...)) is
 * driven over the local execute path, and the probe strings that actually
 * reached that path are recorded and inspected.
 *
 * Shared-registry constraint: tests/global-setup.ts computes ONE data dir per
 * vitest run and provides it to every worker, so registry.json is shared by
 * all test files within a run and is never reset per file -- fileParallelism:
 * false serializes files, it does not isolate them. Every assertion below is
 * therefore scoped to the member ids THIS suite created: members are looked
 * up (and acted on) by id, no assertion touches the whole member list or a
 * total count, and every member and temp directory is removed in cleanup.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { addAgent, getAgent, removeAgent } from '../../src/services/registry.js';
import { makeTestLocalAgent, decodePowerShellEncodedCommand } from '../test-helpers.js';

/** Every command the tool actually sent to the member's execute path, in order. */
const issuedCommands: string[] = [];

// The REAL local strategy still runs every probe; this wrapper only records
// the exact command string it was handed, so criterion (4) can inspect what
// was executed instead of re-deriving it from the builders.
vi.mock('../../src/services/strategy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/strategy.js')>();
  return {
    ...actual,
    getStrategy: (agent: Parameters<typeof actual.getStrategy>[0]) => {
      const real = actual.getStrategy(agent);
      return {
        ...real,
        execCommand: (command: string, ...rest: unknown[]) => {
          issuedCommands.push(command);
          return (real.execCommand as (...args: unknown[]) => unknown)(command, ...rest);
        },
      } as typeof real;
    },
  };
});

type ToolContentItem = { type: string; text: string };
type ToolResult = { content: ToolContentItem[]; structuredContent?: Record<string, unknown> };
type ToolHandler = (input: unknown, extra?: unknown) => Promise<ToolResult>;

/** Record what registerAllTools registered, so the REAL registered closure can be invoked. */
async function recordRegisteredTools(): Promise<Map<string, { schema: Record<string, unknown>; handler: ToolHandler }>> {
  const { registerAllTools } = await import('../../src/services/tool-registry.js');
  const registered = new Map<string, { schema: Record<string, unknown>; handler: ToolHandler }>();
  const fakeServer = {
    tool: (name: string, _description: string, schema: Record<string, unknown>, handler: ToolHandler) => {
      registered.set(name, { schema, handler });
    },
    server: { sendLoggingMessage: async () => {} },
  };
  await registerAllTools(fakeServer as never);
  return registered;
}

const sandboxes: string[] = [];
const createdMemberIds: string[] = [];

/** A fresh temp directory unique to this run, tracked for cleanup. */
function makeSandbox(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fleet-gitstatus-${label}-${process.pid}-${crypto.randomBytes(4).toString('hex')}-`));
  sandboxes.push(dir);
  return fs.realpathSync(dir);
}

function git(dir: string, args: string[]): string {
  return execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
  });
}

/** A committed repo on branch `main`, optionally with an origin remote. */
function makeRepo(label: string, originUrl?: string): string {
  const dir = makeSandbox(label);
  git(dir, ['init', '--quiet']);
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(dir, ['add', 'README.md']);
  git(dir, [
    '-c', 'user.email=fleet-test@example.invalid',
    '-c', 'user.name=Fleet Test',
    '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '-m', 'initial',
  ]);
  if (originUrl) git(dir, ['remote', 'add', 'origin', originUrl]);
  return dir;
}

/** Register a local member on `folder` under an id unique to this suite. */
function registerLocalMember(folder: string): string {
  const member = makeTestLocalAgent({
    id: `gitstatus-integ-${process.pid}-${crypto.randomBytes(4).toString('hex')}`,
    friendlyName: `gitstatus-integ-${crypto.randomBytes(3).toString('hex')}`,
    workFolder: folder,
  });
  addAgent(member);
  createdMemberIds.push(member.id);
  return member.id;
}

/** The core message text -- the one content item NOT wrapped in the onboarding tag. */
function coreText(result: ToolResult): string {
  const item = result.content.find((c) => !c.text.startsWith('<apra-fleet-display>'));
  expect(item, `no core (non-onboarding) text item in content: ${JSON.stringify(result.content)}`).toBeTruthy();
  return item!.text;
}

interface Checkout {
  path: string;
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: boolean;
  dirtyFiles: Array<{ code: string; path: string }>;
  worktrees: Array<Record<string, unknown>>;
  originUrl: string | null;
  originSlug: string | null;
  playbooks: string[];
  bibleCommit: string | null;
}

describe('member_git_status live integration (apra-fleet-4qtu.3.3)', () => {
  let handler: ToolHandler;
  let schema: Record<string, unknown>;

  beforeAll(async () => {
    const registered = await recordRegisteredTools();
    const entry = registered.get('member_git_status');
    expect(entry, 'member_git_status was not registered by registerAllTools').toBeTruthy();
    handler = entry!.handler;
    schema = entry!.schema;
  });

  afterAll(() => {
    for (const id of createdMemberIds) {
      try { removeAgent(id); } catch { /* best-effort */ }
    }
    createdMemberIds.length = 0;
    for (const dir of sandboxes) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
    sandboxes.length = 0;
  });

  it('reports the real branch, dirty paths and origin slug of a live checkout', async () => {
    const repo = makeRepo('checkout', 'https://example.invalid/Acme/Widgets.git');
    fs.appendFileSync(path.join(repo, 'README.md'), 'edited\n');
    fs.writeFileSync(path.join(repo, 'scratch.txt'), 'untracked\n');
    fs.writeFileSync(path.join(repo, 'deploy.md'), '## Deploy\n');
    const memberId = registerLocalMember(repo);

    const result = await handler({ member_id: memberId });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(structured.outcome).toBe('checkout');
    expect(structured.ok).toBe(true);
    expect(structured.error).toBeNull();
    expect(structured.memberId).toBe(memberId);

    const checkout = structured.checkout as Checkout;
    expect(checkout).toBeTruthy();
    expect(checkout.branch).toBe('main');
    expect(checkout.detached).toBe(false);
    expect(checkout.head).toBe(git(repo, ['rev-parse', 'HEAD']).trim());
    // No upstream was ever configured on this temp repo.
    expect(checkout.upstream).toBeNull();
    expect(checkout.ahead).toBeNull();
    expect(checkout.behind).toBeNull();
    expect(checkout.dirty).toBe(true);
    const dirtyPaths = checkout.dirtyFiles.map((f) => f.path).sort();
    expect(dirtyPaths).toEqual(['README.md', 'deploy.md', 'scratch.txt']);
    expect(checkout.dirtyFiles.find((f) => f.path === 'scratch.txt')?.code).toBe('??');
    expect(checkout.originUrl).toBe('https://example.invalid/Acme/Widgets.git');
    expect(checkout.originSlug).toBe('example.invalid/acme/widgets');
    expect(checkout.playbooks).toEqual(['deploy.md']);
    // Nothing in this repo ever touched the knowledge-bank export.
    expect(checkout.bibleCommit).toBeNull();
    expect(checkout.worktrees.map((w) => w.branch)).toEqual(['main']);
    expect(coreText(result)).toContain('main');
  }, 120_000);

  it('returns checkout null without erroring for a folder that is not a git work tree (DQ-27)', async () => {
    const plain = makeSandbox('plain');
    fs.writeFileSync(path.join(plain, 'notes.txt'), 'not a repo\n');
    const memberId = registerLocalMember(plain);

    const result = await handler({ member_id: memberId });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(structured.outcome).toBe('no_checkout');
    expect(structured.ok).toBe(true);
    expect(structured.checkout).toBeNull();
    expect(structured.error).toBeNull();
    expect((result as { isError?: boolean }).isError).toBeFalsy();
    expect(coreText(result)).toContain('not a git work tree');
  }, 120_000);

  it('reports a checkout with no origin remote as originSlug null rather than throwing', async () => {
    const repo = makeRepo('no-origin');
    const memberId = registerLocalMember(repo);

    const result = await handler({ member_id: memberId });
    const structured = result.structuredContent as Record<string, unknown>;

    expect(structured.outcome).toBe('checkout');
    expect(structured.error).toBeNull();
    const checkout = structured.checkout as Checkout;
    expect(checkout.originUrl).toBeNull();
    expect(checkout.originSlug).toBeNull();
    expect(checkout.branch).toBe('main');
    expect(checkout.dirty).toBe(false);
  }, 120_000);

  it('executes probe strings that carry no unexpanded shell variable or tilde path', async () => {
    const repo = makeRepo('probes');
    const memberId = registerLocalMember(repo);
    issuedCommands.length = 0;

    await handler({ member_id: memberId });

    expect(issuedCommands.length).toBe(6);
    const windowsMember = getAgent(memberId)?.os === 'windows';
    for (const command of issuedCommands) {
      if (windowsMember) {
        // Criterion (4) applies to a Windows member: every probe must be a
        // wrapPowerShellEncoded invocation, never a raw PowerShell one-liner.
        expect(command.startsWith('powershell -EncodedCommand ')).toBe(true);
      }
      const script = decodePowerShellEncodedCommand(command);
      const payload = script
        .replace(/^\$ErrorActionPreference = 'Stop'; try \{ /, '')
        .replace(/; if \(\$LASTEXITCODE[\s\S]*$/, '');
      expect(payload).not.toContain('$env:');
      expect(payload).not.toContain('%USERPROFILE%');
      // Reject '~' only when used as home-dir shorthand (a tilde starting a
      // path token, followed by a path separator, quote, whitespace, or end
      // of string). A literal resolved path can legitimately contain '~' as
      // part of a Windows 8.3 short name -- e.g. GitHub windows-latest
      // runners report os.tmpdir() as C:\Users\RUNNER~1\AppData\..., and
      // fs.realpathSync does not expand 8.3 short names, so that '~1' can
      // survive into the fully resolved folder embedded in the probe.
      expect(payload).not.toMatch(/(^|[\s'"=])~(?=[\\/'"\s]|$)/);
      expect(payload).not.toMatch(/\$[A-Za-z_{]/);
      // The folder is embedded as a resolved literal, not left to the shell.
      expect(payload).toContain(repo);
    }
  }, 120_000);

  it('the home-dir-tilde pattern accepts 8.3 short names and rejects shorthand tildes', () => {
    const homeDirTilde = /(^|[\s'"=])~(?=[\\/'"\s]|$)/;
    expect(homeDirTilde.test('C:\\Users\\RUNNER~1\\AppData')).toBe(false);
    expect(homeDirTilde.test('~/repo')).toBe(true);
    expect(homeDirTilde.test("'~\\repo'")).toBe(true);
  });

  it('reaches the tool through the client memberGitStatus wrapper with the server-declared option names', async () => {
    const repo = makeRepo('client');
    const memberId = registerLocalMember(repo);

    for (const option of ['member_id', 'member_name', 'folder']) {
      expect(Object.keys(schema)).toContain(option);
    }

    const { ApraFleet } = await import('@apralabs/apra-fleet-client');
    let calledName: string | undefined;
    let calledArgs: Record<string, unknown> | undefined;
    const fleet = new ApraFleet({
      async callTool(name: string, args: Record<string, unknown>) {
        calledName = name;
        calledArgs = args;
        return handler(args);
      },
    });

    const result = await fleet.memberGitStatus({ member_id: memberId, folder: repo }) as unknown as ToolResult;

    expect(calledName).toBe('member_git_status');
    expect(Object.keys(calledArgs ?? {}).every((key) => Object.keys(schema).includes(key))).toBe(true);
    const structured = result.structuredContent as Record<string, unknown>;
    expect(structured.outcome).toBe('checkout');
    expect(structured.memberId).toBe(memberId);
    expect((structured.checkout as Checkout).branch).toBe('main');
  }, 120_000);
});
