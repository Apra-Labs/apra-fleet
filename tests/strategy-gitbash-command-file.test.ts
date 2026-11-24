/**
 * Unit coverage (every host platform) for LocalStrategy.execCommand's
 * oversized-command delivery on a local Git Bash member: above
 * GITBASH_INLINE_COMMAND_MAX_BYTES the command travels as data in an
 * owner-only temp file that bash sources, never as one huge `bash -c` argv
 * element (which the MSYS runtime corrupts above ~8KB). Below the threshold,
 * and for every other member shell, the spawn is unchanged.
 *
 * node:child_process.spawn and getOsCommands are mocked, so no real process
 * runs. The fake child has no pid, so killLocalProcessTree is never reached
 * and no real taskkill/kill can hit an unrelated process on the test host.
 * os.tmpdir() is pointed at a per-test sandbox (TMPDIR/TEMP/TMP), so the
 * command files land there and the test can prove none is left behind.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { makeTestLocalAgent } from './test-helpers.js';

interface FakeChild extends EventEmitter {
  pid: number | undefined;
  stdout: PassThrough;
  stderr: PassThrough;
  stdin: { end: () => void };
  kill: (sig?: string) => boolean;
}

const h = vi.hoisted(() => ({
  spawnCalls: [] as { command: string; options: any; fileContentAtSpawn?: string; fileModeAtSpawn?: number }[],
  children: [] as any[],
  shell: '/fake/git/bin/bash.exe' as string | undefined,
}));

function sourcedPath(spawnCommand: string): string | undefined {
  const m = /^\. '(.+)'$/.exec(spawnCommand);
  return m ? m[1] : undefined;
}

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { EventEmitter: EE } = await import('node:events');
  const { PassThrough: PT } = await import('node:stream');
  const fsMod = await import('node:fs');
  return {
    ...actual,
    spawn: (command: string, options: any) => {
      const call: any = { command, options };
      const p = sourcedPath(command);
      if (p && fsMod.existsSync(p)) {
        call.fileContentAtSpawn = fsMod.readFileSync(p, 'utf-8');
        call.fileModeAtSpawn = fsMod.statSync(p).mode & 0o777;
      }
      h.spawnCalls.push(call);
      const child: any = new EE();
      child.pid = undefined;
      child.stdout = new PT();
      child.stderr = new PT();
      child.stdin = { end: () => {} };
      child.kill = () => true;
      h.children.push(child);
      return child;
    },
  };
});

vi.mock('../src/os/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/os/index.js')>();
  return {
    ...actual,
    getOsCommands: (agentOs: any, shell: any) => {
      const real = actual.getOsCommands(agentOs, shell);
      return new Proxy(real, {
        get(target, prop, receiver) {
          // cleanExec: pass the command through unchanged with a fixed shell
          // path (the real gitbash cleanExec resolves a real bash.exe).
          if (prop === 'cleanExec') return (command: string) => ({ command, env: {}, shell: h.shell });
          return Reflect.get(target, prop, receiver);
        },
      });
    },
  };
});

const { getStrategy, GITBASH_INLINE_COMMAND_MAX_BYTES } = await import('../src/services/strategy.js');

function lastChild(): FakeChild {
  return h.children[h.children.length - 1];
}

/** Wait until the strategy has spawned its (fake) child. */
async function waitForSpawn(count: number): Promise<void> {
  for (let i = 0; i < 200 && h.spawnCalls.length < count; i++) await new Promise((r) => setTimeout(r, 5));
  expect(h.spawnCalls.length).toBe(count);
}

const ENV_KEYS = ['TMPDIR', 'TEMP', 'TMP'] as const;

describe('LocalStrategy: oversized Git Bash commands travel as a temp file, not argv', () => {
  let sandbox: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    h.spawnCalls.length = 0;
    h.children.length = 0;
    h.shell = '/fake/git/bin/bash.exe';
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-cmdfile-test-'));
    for (const k of ENV_KEYS) { savedEnv[k] = process.env[k]; process.env[k] = sandbox; }
    expect(os.tmpdir()).toBe(sandbox);
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  /** Every fleet-cmd-*.sh command file currently in the sandbox. */
  function commandFiles(): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(sandbox)) {
      const dir = path.join(sandbox, entry);
      if (!fs.statSync(dir).isDirectory()) continue;
      for (const f of fs.readdirSync(dir)) if (/^fleet-cmd-.*\.sh$/.test(f)) out.push(path.join(dir, f));
    }
    return out;
  }

  const big = (n: number) => `echo '${'x'.repeat(n)}'`;
  const gitbashAgent = () => makeTestLocalAgent({ os: 'windows', shell: 'gitbash', workFolder: sandbox } as any);

  it('above the threshold: spawns a source of an owner-only file holding the exact command; the file is gone after a normal exit', async () => {
    const command = big(GITBASH_INLINE_COMMAND_MAX_BYTES + 100);
    const run = getStrategy(gitbashAgent()).execCommand(command, 5000);
    await waitForSpawn(1);

    const call = h.spawnCalls[0];
    const file = sourcedPath(call.command);
    expect(file, `spawn received the inline command instead of a file reference: ${call.command.slice(0, 80)}`).toBeDefined();
    expect(call.command.length).toBeLessThan(500);
    expect(call.options.shell).toBe('/fake/git/bin/bash.exe');
    expect(call.fileContentAtSpawn).toBe(command);
    if (process.platform !== 'win32') expect(call.fileModeAtSpawn).toBe(0o600);
    expect(path.basename(file!)).toMatch(/^fleet-cmd-[0-9a-f-]{36}\.sh$/);
    expect(commandFiles()).toHaveLength(1);

    lastChild().stdout.write('out\n');
    lastChild().emit('close', 0);
    const result = await run;
    expect(result).toEqual({ stdout: 'out\n', stderr: '', code: 0 });
    expect(commandFiles()).toEqual([]);
  });

  it('below the threshold: the spawn is unchanged (inline command, no file)', async () => {
    const command = big(100);
    const run = getStrategy(gitbashAgent()).execCommand(command, 5000);
    await waitForSpawn(1);
    expect(h.spawnCalls[0].command).toBe(command);
    expect(commandFiles()).toEqual([]);
    lastChild().emit('close', 0);
    await run;
  });

  it.each([
    ['windows', 'powershell5'],
    ['windows', 'pwsh7'],
    ['windows', undefined],
    ['linux', undefined],
    ['macos', undefined],
  ])('non-gitbash member (os=%s shell=%s): an oversized command still spawns inline, exactly as before', async (agentOs, shell) => {
    const command = big(GITBASH_INLINE_COMMAND_MAX_BYTES * 4);
    const agent = makeTestLocalAgent({ os: agentOs as any, shell: shell as any, workFolder: sandbox });
    const run = getStrategy(agent).execCommand(command, 5000);
    await waitForSpawn(1);
    expect(h.spawnCalls[0].command).toBe(command);
    expect(commandFiles()).toEqual([]);
    lastChild().emit('close', 0);
    await run;
  });

  it('nonzero exit: the exit code and output pass through and the file is deleted', async () => {
    const run = getStrategy(gitbashAgent()).execCommand(big(GITBASH_INLINE_COMMAND_MAX_BYTES * 2), 5000);
    await waitForSpawn(1);
    expect(commandFiles()).toHaveLength(1);
    lastChild().stderr.write('boom\n');
    lastChild().emit('close', 3);
    await expect(run).resolves.toEqual({ stdout: '', stderr: 'boom\n', code: 3 });
    expect(commandFiles()).toEqual([]);
  });

  it('inactivity timeout: rejects and deletes the file', async () => {
    const run = getStrategy(gitbashAgent()).execCommand(big(GITBASH_INLINE_COMMAND_MAX_BYTES * 2), 100);
    await waitForSpawn(1);
    expect(commandFiles()).toHaveLength(1);
    await expect(run).rejects.toThrow(/timed out after 100ms of inactivity/);
    expect(commandFiles()).toEqual([]);
  });

  it('max-total timeout: rejects and deletes the file', async () => {
    const run = getStrategy(gitbashAgent()).execCommand(big(GITBASH_INLINE_COMMAND_MAX_BYTES * 2), 5000, 100);
    await waitForSpawn(1);
    await expect(run).rejects.toThrow(/max total time of 100ms/);
    expect(commandFiles()).toEqual([]);
  });

  it('abort: rejects and deletes the file', async () => {
    const ac = new AbortController();
    const run = getStrategy(gitbashAgent()).execCommand(big(GITBASH_INLINE_COMMAND_MAX_BYTES * 2), 5000, undefined, undefined, ac.signal);
    await waitForSpawn(1);
    expect(commandFiles()).toHaveLength(1);
    ac.abort();
    await expect(run).rejects.toThrow(/aborted/);
    expect(commandFiles()).toEqual([]);
  });

  it('spawn error: rejects and deletes the file', async () => {
    const run = getStrategy(gitbashAgent()).execCommand(big(GITBASH_INLINE_COMMAND_MAX_BYTES * 2), 5000);
    await waitForSpawn(1);
    lastChild().emit('error', new Error('spawn ENOENT'));
    await expect(run).rejects.toThrow(/ENOENT/);
    expect(commandFiles()).toEqual([]);
  });

  it('FLEET_PID marker on stdout is still captured and stripped for a file-delivered command', async () => {
    const pids: number[] = [];
    const run = getStrategy(gitbashAgent()).execCommand(big(GITBASH_INLINE_COMMAND_MAX_BYTES * 2), 5000, undefined, (p) => pids.push(p));
    await waitForSpawn(1);
    lastChild().stdout.write('FLEET_PID:4321\nhello\n');
    lastChild().emit('close', 0);
    const result = await run;
    expect(pids).toEqual([4321]);
    expect(result.stdout).toBe('hello\n');
  });
});
