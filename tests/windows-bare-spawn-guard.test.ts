import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Source-scanning guard: on Windows a bare program name (claude, npx, agy,
 * taskkill, tasklist, schtasks, whoami, cmd.exe) or `shell: true` lets cmd.exe /
 * CreateProcess look in the spawn cwd (a planted claude.cmd in the work folder)
 * before PATH. Such programs must be resolved to an absolute path first
 * (src/os/windows-executable.ts, src/os/windows-command.ts). This test reads
 * src/**\/*.ts only -- it never touches ~/.claude.json, ~/.ssh or an install.
 */

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const BUG_PROGRAMS = 'claude|npx|agy|taskkill|tasklist|schtasks|whoami|cmd';
const SPAWN_FNS = 'spawn|spawnSync|exec|execSync|execFile|execFileSync|spawnFn|spawnDetached';

const BARE_PROGRAM_RE = new RegExp(
  `\\b(?:${SPAWN_FNS})\\s*\\(\\s*(['"\`])(?:${BUG_PROGRAMS})(?:\\.exe|\\.cmd)?(?![\\w.-])`,
);
// shell: true, a win32-conditional shell option, or a literal cmd.exe shell.
const SHELL_OPT_RE = /\bshell\s*:\s*(?:true\b|process\.platform\b|isWin\w*|['"`]cmd(?:\.exe)?['"`])/;

export interface Finding { file: string; line: number; text: string; kind: 'bare-program' | 'shell-option' }

interface AllowEntry {
  /** repo-relative path under src/, forward slashes */
  file: string;
  /** when set, only lines matching this regex are allowed; otherwise the whole file */
  line?: RegExp;
  reason: string;
}

const ALLOWLIST: AllowEntry[] = [
  { file: 'cli/install.ts', reason: 'out of scope this sprint (open PRs); the cmd.exe/claude/tasklist/taskkill sites are tracked separately (djez.1.4)' },
  { file: 'cli/beads-install.ts', reason: 'npm and bd resolution with shell:true belongs to a separate bd/npm resolution follow-up; npm/bd are not ga85 programs' },
  { file: 'cli/dolt-install.ts', reason: 'dolt version with a win32 shell option: dolt is not a ga85 program' },
  {
    file: 'tools/register-member.ts',
    line: /spawnFn\(\s*'claude'.*shell:\s*true/,
    reason: 'fallback reached only when windowsCommand() returns null, i.e. off win32 (POSIX has no cwd search); win32 always gets an absolute plan',
  },
  {
    file: 'tools/code-intelligence-reindex.ts',
    line: /\}\)\s*:\s*spawn\(\s*'npx'|^\s*shell:\s*process\.platform\s*===\s*'win32',?\s*$/,
    reason: 'else-branch reached only when windowsCommand() returns null, i.e. off win32; on win32 an absolute plan is spawned instead',
  },
];

function stripComments(text: string): string {
  const keepNewlines = (m: string) => m.replace(/[^\n]/g, ' ');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, keepNewlines)
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
}

export function scanSource(relFile: string, source: string, allowlist: AllowEntry[] = ALLOWLIST): Finding[] {
  const out: Finding[] = [];
  const lines = stripComments(source).split('\n');
  const allowed = allowlist.filter(a => a.file === relFile);
  lines.forEach((text, i) => {
    let kind: Finding['kind'] | null = null;
    if (BARE_PROGRAM_RE.test(text)) kind = 'bare-program';
    else if (SHELL_OPT_RE.test(text)) kind = 'shell-option';
    if (!kind) return;
    if (allowed.some(a => !a.line || a.line.test(text))) return;
    out.push({ file: `src/${relFile}`, line: i + 1, text: text.trim(), kind });
  });
  return out;
}

function listTsFiles(dir: string): string[] {
  const acc: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) acc.push(...listTsFiles(p));
    else if (e.isFile() && p.endsWith('.ts') && !p.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

describe('windows bare-name spawn guard', () => {
  it('no src file spawns claude/npx/agy/taskkill/tasklist/schtasks/whoami/cmd.exe by bare name or passes shell:true outside the allowlist', () => {
    const findings: Finding[] = [];
    for (const f of listTsFiles(SRC_DIR)) {
      const rel = path.relative(SRC_DIR, f).split(path.sep).join('/');
      findings.push(...scanSource(rel, fs.readFileSync(f, 'utf8')));
    }
    expect(
      findings.map(f => `${f.file}:${f.line} [${f.kind}] ${f.text}`),
      'resolve via windowsExecutable()/windowsCommand() or add a justified ALLOWLIST entry',
    ).toEqual([]);
  });

  it('every allowlist entry still matches something (no stale entries)', () => {
    for (const a of ALLOWLIST) {
      const p = path.join(SRC_DIR, a.file);
      expect(fs.existsSync(p), `${a.file} missing`).toBe(true);
      const hits = scanSource(a.file, fs.readFileSync(p, 'utf8'), []);
      const used = hits.filter(h => !a.line || a.line.test(h.text));
      expect(used.length, `allowlist entry for ${a.file} matches nothing: ${a.reason}`).toBeGreaterThan(0);
    }
  });

  it('flags a scratch fixture with a bare claude spawn with shell:true, naming file and line', () => {
    const fixture = [
      "import { spawn } from 'node:child_process';",
      '// spawn(\'claude\') in a comment is ignored',
      "spawn('claude', ['--x'], { cwd, shell: true });",
    ].join('\n');
    const found = scanSource('fixture.ts', fixture);
    expect(found.map(f => `${f.file}:${f.line}:${f.kind}`)).toEqual(['src/fixture.ts:3:bare-program']);
    expect(scanSource('fixture.ts', "x.spawnSync('cmd.exe', a);\nexecFileSync('npx.cmd', b);").length).toBe(2);
    expect(scanSource('fixture.ts', 'spawn(file, args, { shell: true });')[0]).toMatchObject({ line: 1, kind: 'shell-option' });
  });

  it('does not flag resolved or non-ga85 programs', () => {
    const ok = [
      "execFileSync(windowsExecutable('taskkill'), args);",
      "spawn(plan.file, plan.args, { shell: plan.shell });",
      "spawn('git', ['status']);",
    ].join('\n');
    expect(scanSource('fixture.ts', ok)).toEqual([]);
  });
});
