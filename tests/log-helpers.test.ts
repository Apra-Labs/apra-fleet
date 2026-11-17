import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

type LogHelpers = typeof import('../src/utils/log-helpers.js');

describe('log-helpers', () => {
  const originalDataDir = process.env.APRA_FLEET_DATA_DIR;
  let dataDir: string;
  let logsDir: string;
  let mod: LogHelpers | null = null;

  async function load(): Promise<LogHelpers> {
    mod = await import('../src/utils/log-helpers.js');
    return mod;
  }

  beforeEach(() => {
    vi.resetModules();
    // Fresh data dir per test: FLEET_DIR is read at module load (resetModules).
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-log-helpers-'));
    process.env.APRA_FLEET_DATA_DIR = dataDir;
    logsDir = path.join(dataDir, 'logs');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    mod?.closeLogFile();
    mod = null;
    vi.restoreAllMocks();
    process.env.APRA_FLEET_DATA_DIR = originalDataDir;
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function parsedLines(): Record<string, unknown>[] {
    const file = path.join(logsDir, `fleet-${process.pid}.log`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('creates APRA_FLEET_DATA_DIR/logs/ directory on first logLine call', async () => {
    const { logLine } = await load();
    expect(fs.existsSync(logsDir)).toBe(false);
    logLine('test', 'hello');
    expect(fs.existsSync(logsDir)).toBe(true);
  });

  it('writes valid JSONL to fleet-<pid>.log synchronously', async () => {
    const { logLine } = await load();
    logLine('mytag', 'hello world');

    // No await between the call and the read: the line is already on disk.
    const lines = parsedLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'info', tag: 'mytag', msg: 'hello world' });
    expect(lines[0]).not.toHaveProperty('pid');
    expect(typeof lines[0].ts).toBe('string');
    expect((lines[0].ts as string)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('field order: ts, level, tag, msg (no mid/mem/pid when omitted)', async () => {
    const { logLine } = await load();
    logLine('tag', 'msg');

    const lines = parsedLines();
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0])).toEqual(['ts', 'level', 'tag', 'msg']);
  });

  it('includes mid between tag and msg when member provided; omits when not', async () => {
    const { logLine } = await load();
    logLine('tag', 'with member', { id: 'member-uuid-123', friendlyName: '' });
    logLine('tag', 'without member');

    const lines = parsedLines();
    expect(lines).toHaveLength(2);

    expect(Object.keys(lines[0])).toEqual(['ts', 'level', 'tag', 'mid', 'msg']);
    expect(lines[0].mid).toBe('member-uuid-123');

    expect(Object.keys(lines[1])).toEqual(['ts', 'level', 'tag', 'msg']);
    expect(lines[1]).not.toHaveProperty('mid');
  });

  it('includes mem field when member has a friendlyName', async () => {
    const { logLine } = await load();
    logLine('tag', 'with name', { id: 'member-uuid-123', friendlyName: 'MyMember' });

    const lines = parsedLines();
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0])).toEqual(['ts', 'level', 'tag', 'mid', 'mem', 'msg']);
    expect(lines[0].mid).toBe('member-uuid-123');
    expect(lines[0].mem).toBe('MyMember');
  });

  it('applies maskSecrets() -- {{secret.MY_KEY}} is written as [REDACTED]', async () => {
    const { logLine } = await load();
    logLine('tag', 'use {{secret.MY_KEY}} here');

    const lines = parsedLines();
    expect(lines[0].msg).toBe('use [REDACTED] here');
  });

  it('applies maskSecrets() -- legacy {{secure.MY_KEY}} is also written as [REDACTED]', async () => {
    const { logLine } = await load();
    logLine('tag', 'use {{secure.MY_KEY}} here');

    const lines = parsedLines();
    expect(lines[0].msg).toBe('use [REDACTED] here');
  });

  it('applies maskSecrets() -- a mix of {{secret.X}} and {{secure.Y}} are both redacted', async () => {
    const { logLine } = await load();
    logLine('tag', 'use {{secret.X}} and {{secure.Y}} here');

    const lines = parsedLines();
    expect(lines[0].msg).toBe('use [REDACTED] and [REDACTED] here');
  });

  it('still calls console.error on each logLine call', async () => {
    const { logLine } = await load();
    const consoleSpy = vi.mocked(console.error);

    logLine('mytag', 'test message');

    expect(consoleSpy).toHaveBeenCalledOnce();
    const output: string = consoleSpy.mock.calls[0][0];
    expect(output).toContain('mytag');
    expect(output).toContain('test message');
  });

  // GitHub #562: the file line is written BEFORE the stderr mirror.
  it('writes the file line before mirroring to stderr', async () => {
    const { logLine } = await load();
    let linesAtMirror = -1;
    vi.mocked(console.error).mockImplementation(() => { linesAtMirror = parsedLines().length; });
    logLine('order', 'file first');
    expect(linesAtMirror).toBe(1);
  });

  // GitHub #562: an undrained stderr pipe blocks console.error forever. The
  // line that blocked (and every line before it) must already be in the file.
  it('records the line in the file log even when stderr is an undrained pipe', async () => {
    const childDataDir = path.join(dataDir, 'child');
    // The child runs the BUILT module (like the kb-serve subprocess tests do).
    const distModule = new URL('../dist/utils/log-helpers.js', import.meta.url);
    expect(fs.existsSync(distModule), 'dist/ missing -- run npm run build first').toBe(true);
    const script = [
      `const m = await import(${JSON.stringify(distModule.href)});`,
      `const big = 'x'.repeat(1024);`,
      `for (let i = 0; i < 400; i++) m.logLine('flood', 'line-' + i + ' ' + big);`,
    ].join('\n');
    // stderr is a pipe nobody reads: the child blocks once the pipe buffer fills.
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, APRA_FLEET_DATA_DIR: childDataDir },
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    child.stderr!.pause();
    const childLog = path.join(childDataDir, 'logs', `fleet-${child.pid}.log`);
    let fileLines: string[] = [];
    const deadline = Date.now() + 15_000;
    try {
      // Wait until the file stops growing (the child is blocked on stderr) or the child exits.
      let last = -1;
      let stableSince = Date.now();
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        fileLines = fs.existsSync(childLog) ? fs.readFileSync(childLog, 'utf8').split('\n').filter(Boolean) : [];
        if (fileLines.length !== last) { last = fileLines.length; stableSince = Date.now(); }
        else if (fileLines.length > 0 && Date.now() - stableSince > 1500) break;
      }
      const blocked = child.exitCode === null;
      expect(fileLines.length).toBeGreaterThan(0);
      if (blocked) {
        // The child is wedged on stderr; with file-first + sync writes the
        // file is AHEAD of stderr: it holds the line that is blocking.
        const lastMsg = JSON.parse(fileLines[fileLines.length - 1]).msg as string;
        const lastIdx = Number(/line-(\d+)/.exec(lastMsg)![1]);
        expect(lastIdx).toBe(fileLines.length - 1);
      } else {
        expect(fileLines).toHaveLength(400);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((r) => child.once('exit', r));
        child.kill('SIGKILL');
        await exited;
      }
    }
  }, 30_000);
});
