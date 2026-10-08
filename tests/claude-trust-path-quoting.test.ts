/**
 * ensureWorkspaceTrusted embeds the member home and work folder inside "..." in
 * member-bound commands. Environment-derived paths (os.homedir() for a local
 * member) must be treated as literals: $ and backtick inside double quotes
 * would otherwise expand/execute on the member (CodeQL
 * js/shell-command-injection-from-environment).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeProvider } from '../src/providers/claude.js';
import { escapeForDoubleQuotes } from '../src/utils/shell-escape.js';
import type { SSHExecResult } from '../src/types.js';

let hasBash = true;
try { execFileSync('bash', ['-c', 'true'], { stdio: 'ignore' }); } catch { hasBash = false; }

/** Run `printf %s "<escaped>"` in bash and return what the shell saw. */
function bashEcho(value: string): string {
  const cmd = `printf %s "${escapeForDoubleQuotes(value, false)}"`;
  return execFileSync('bash', ['-c', cmd], { encoding: 'utf8' });
}

describe('escapeForDoubleQuotes', () => {
  it('POSIX: escapes backslash, double quote, $ and backtick', () => {
    expect(escapeForDoubleQuotes('a\\b"c$d`e', false)).toBe('a\\\\b\\"c\\$d\\`e');
  });

  it('POSIX: leaves single quote, ! and newline untouched', () => {
    expect(escapeForDoubleQuotes("it's a!\nb", false)).toBe("it's a!\nb");
  });

  it('PowerShell: backtick-escapes backtick, double quote and $', () => {
    expect(escapeForDoubleQuotes('a"b$c`d', true)).toBe('a`"b`$c``d');
  });

  it('PowerShell: leaves backslash, single quote, ! and newline untouched', () => {
    expect(escapeForDoubleQuotes("C:\\u's!\nx", true)).toBe("C:\\u's!\nx");
  });

  it('PowerShell: also escapes curly double quotes', () => {
    expect(escapeForDoubleQuotes('a\u201Cb\u201Dc', true)).toBe('a`\u201Cb`\u201Dc');
  });

  it.runIf(process.platform === 'win32')('PowerShell output round-trips through real powershell.exe double quotes', () => {
    const values = [
      'a$(Get-Date)b',
      'x$env:USERPROFILEy',
      'p`nq',
      'say "hi"',
      'curly \u201Cquoted\u201D here',
      'C:\\Users\\a b\\.claude.json',
    ];
    for (const v of values) {
      const script = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [Console]::Out.Write("${escapeForDoubleQuotes(v, true)}")`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
      expect(out).toBe(v);
    }
  });

  it.runIf(hasBash)('POSIX output round-trips through real bash double quotes', () => {
    const v = 'a b\\c"d$HOME`id`e!f\'g';
    expect(bashEcho(v)).toBe(v);
  });
});

describe('ClaudeProvider.ensureWorkspaceTrusted path quoting (real bash)', () => {
  it.runIf(hasBash)('uses a home and work folder containing $ and backtick literally', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-trust-q-'));
    try {
      // `fakecmd` would be command substitution; $FLEETX would expand to "".
      const home = path.join(root, 'h$FLEETX`fakecmd`');
      const work = path.join(root, 'w$FLEETY`fakecmd`');
      fs.mkdirSync(home);
      fs.mkdirSync(work);
      fs.writeFileSync(path.join(home, '.claude.json'), '{"projects":{}}');
      fs.writeFileSync(path.join(work, '.mcp.json'), '{}');

      const exec = (cmd: string): Promise<SSHExecResult> =>
        new Promise((resolve) => {
          execFile('bash', ['-c', cmd], { encoding: 'utf8' }, (err, stdout, stderr) => {
            resolve({ stdout, stderr, code: err ? ((err as any).code ?? 1) : 0 });
          });
        });

      const provider = new ClaudeProvider();
      const fwd = (p: string) => p.replace(/\\/g, '/');
      // The merged file goes through the file channel (never a command line);
      // the staged file is then moved into place by a command embedding both
      // paths inside "...", which is what this test exercises.
      const transport = { writeHomeFile: async (rel: string, content: string) => { fs.writeFileSync(path.join(home, rel), content); } };
      await provider.ensureWorkspaceTrusted(fwd(work), exec, 'linux', undefined, transport, fwd(home));

      const written = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
      expect(written.projects[fwd(work)]?.hasTrustDialogAccepted).toBe(true);
      // No stray file created at an expanded path.
      expect(fs.readdirSync(root).sort()).toEqual([path.basename(home), path.basename(work)].sort());
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ClaudeProvider.syncMemberMcpEntry path quoting (real bash)', () => {
  it.runIf(hasBash)('writes the local-scope entry into a home containing $ and backtick literally', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-mcp-q-'));
    try {
      const home = path.join(root, 'h$FLEETX`fakecmd`');
      fs.mkdirSync(home);
      fs.writeFileSync(path.join(home, '.claude.json'), '{"projects":{}}');
      const env = { ...process.env };
      delete env.CLAUDE_CONFIG_DIR;

      const exec = (cmd: string): Promise<SSHExecResult> =>
        new Promise((resolve) => {
          execFile('bash', ['-c', cmd], { encoding: 'utf8', env }, (err, stdout, stderr) => {
            resolve({ stdout, stderr, code: err ? ((err as any).code ?? 1) : 0 });
          });
        });

      const fwd = (p: string) => p.replace(/\\/g, '/');
      const work = fwd(path.join(root, 'work'));
      const url = 'http://127.0.0.1:1/mcp?member=m1';
      await new ClaudeProvider().syncMemberMcpEntry({
        agent: { id: 'm1', workFolder: work } as any,
        execCommand: exec,
        memberHomeDir: fwd(home),
        agentOs: 'linux',
        url,
        // File channel as above: the move command embeds the escaped paths.
        transport: { writeHomeFile: async (rel: string, content: string) => { fs.writeFileSync(path.join(home, rel), content); } },
      });

      const written = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
      expect(written.projects[work]?.mcpServers?.['apra-fleet']).toEqual({ type: 'http', url });
      expect(fs.readdirSync(root)).toEqual([path.basename(home)]);
      expect(fs.readdirSync(home)).toEqual(['.claude.json']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
