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
// run/runCommand/runCmd/sh are run()-style wrappers that hand a command STRING to a shell.
const SPAWN_FNS = 'spawn|spawnSync|exec|execSync|execFile|execFileSync|spawnFn|spawnDetached|run|runCommand|runCmd|sh';

// \s spans newlines, so a call split as `spawn(` NEWLINE `'npx'` is matched too (the regex
// runs on the whole comment-stripped source, not line by line). A command string whose
// first token is a guarded program (`execSync('claude mcp remove ...')`) matches because
// a space after the program name satisfies the negative lookahead.
const BARE_PROGRAM_RE = new RegExp(
  `\\b(?:${SPAWN_FNS})\\s*\\(\\s*(['"\`])(?:${BUG_PROGRAMS})(?:\\.exe|\\.cmd)?(?![\\w.-])`,
  'g',
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
    file: 'cli/uninstall.ts',
    // Anchored on the 4-space indent of the `if (!plan) {` fallback inside removeClaudeMcpServer, so the
    // same call restored at the old call-site depth (the pre-fix shape) is NOT allowed.
    line: /^ {4}run\('claude mcp remove/,
    reason: 'fallback reached only when windowsCommand() is not used, i.e. off win32 (POSIX has no cwd search); win32 always runs an absolute plan via execFileSync',
  },
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
  const stripped = stripComments(source);
  const lines = stripped.split('\n');
  const allowed = allowlist.filter(a => a.file === relFile);
  const isAllowed = (text: string) => allowed.some(a => !a.line || a.line.test(text));
  const seen = new Set<string>();
  const add = (line: number, text: string, kind: Finding['kind']) => {
    const key = `${line}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file: `src/${relFile}`, line, text: text.trim(), kind });
  };
  // bare programs: whole-text match so calls split across lines are caught
  for (const m of stripped.matchAll(BARE_PROGRAM_RE)) {
    const startLine = stripped.slice(0, m.index).split('\n').length;
    const endLine = startLine + (m[0].match(/\n/g)?.length ?? 0);
    const spanned = lines.slice(startLine - 1, endLine);
    if (spanned.some(isAllowed)) continue;
    add(startLine, spanned.join(' '), 'bare-program');
  }
  lines.forEach((text, i) => {
    if (seen.has(`${i + 1}:bare-program`)) return; // one finding per line, bare-program wins
    if (SHELL_OPT_RE.test(text) && !isAllowed(text)) add(i + 1, text, 'shell-option');
  });
  return out.sort((a, b) => a.line - b.line);
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
      const rawLines = fs.readFileSync(p, 'utf8').split('\n');
      const used = hits.filter(h => !a.line || a.line.test(rawLines[h.line - 1] ?? h.text));
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

  it('flags a command string (execSync / exec / run wrapper) whose first token is a guarded program', () => {
    for (const src of [
      "execSync('claude mcp remove apra-fleet --scope user');",
      'exec(`npx -y gitnexus analyze`);',
      "run('taskkill /F /PID 1', { stdio: 'ignore' });",
      "            run('claude mcp remove apra-fleet --scope user', { stdio: 'ignore' });",
    ]) {
      expect(scanSource('fixture.ts', src).map(f => f.kind), src).toEqual(['bare-program']);
    }
  });

  it('flags a multi-line bare spawn (spawn( NEWLINE npx) with the call line', () => {
    const src = ['const a = 1;', 'const child = spawn(', "  'npx',", '  args,', ');'].join('\n');
    expect(scanSource('fixture.ts', src).map(f => `${f.line}:${f.kind}`)).toEqual(['2:bare-program']);
    expect(scanSource('fixture.ts', "execFileSync(\n  'cmd.exe',\n  a);").length).toBe(1);
  });

  it('does not flag absolute-path or resolved calls in either shape', () => {
    const ok = [
      "run(`${windowsExecutable('taskkill')} /F`);",
      "execFileSync(plan.file, [...plan.args, 'mcp']);",
      'spawn(',
      "  windowsExecutable('npx'),",
      '  args,',
      ');',
      "execSync('git status');",
      "run('C:\\\\tools\\\\claude.exe mcp remove');",
    ].join('\n');
    expect(scanSource('fixture.ts', ok)).toEqual([]);
  });

  it('reverting the uninstall fix (run with the claude command string at the call site) is reported', () => {
    const rel = 'cli/uninstall.ts';
    const real = fs.readFileSync(path.join(SRC_DIR, rel), 'utf8');
    expect(scanSource(rel, real)).toEqual([]);
    const reverted = real.replace(
      /^( *)removeClaudeMcpServer\(\);$/m,
      "$1run('claude mcp remove apra-fleet --scope user', { stdio: 'ignore' });",
    );
    expect(reverted).not.toBe(real);
    expect(scanSource(rel, reverted).map(f => f.kind)).toEqual(['bare-program']);
  });
});
