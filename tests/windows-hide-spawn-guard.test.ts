import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Source-scan guard: every child_process spawn in product code (and in the
// test runners / helper scripts the suites drive) must pass windowsHide: true.
//
// Why: a process with no console of its own -- a `detached: true` child (the
// server from `apra-fleet start`, the self-update installer, sprint children,
// sandbox servers) or anything under one -- gives each console child it
// spawns a NEW visible console window unless windowsHide is set. On a
// developer's desktop those windows flash up and steal keyboard focus.
// Measured on Windows 10: an unhidden `tasklist` under a detached node child
// opened a console window and took the foreground; the same call with
// windowsHide: true did not.
//
// The check is lexical: it tracks names imported from child_process (plus
// promisify()/`x = y ?? name` aliases) and requires each call's argument text
// to contain windowsHide, directly or via a same-file `const OPTS = {...}`.
// Spawns made through injected deps objects (deps.spawn(...)) are not seen.

const REPO_ROOT = path.resolve(__dirname, '..');

const SCAN_DIRS = [
  'src',
  'packages/apra-fleet-se/src',
  'packages/apra-fleet-client/src',
];
const SCAN_FILES = [
  'scripts/run-all-tests.mjs',
  'scripts/with-test-sandbox.mjs',
  'scripts/kill-port.mjs',
  'scripts/reap-sandbox-dolt.mjs',
  'scripts/sandbox-deploy.mjs',
  'packages/apra-fleet-se/scripts/run-tests.mjs',
];

// Whole files that never run on win32.
const POSIX_ONLY_FILES = new Set([
  'src/os/linux.ts',
  'src/services/service-manager/linux.ts',
  'src/services/service-manager/macos.ts',
]);

// Individual call sites that are deliberately NOT hidden. `match` is a
// substring of the call text.
const ALLOWLIST: Array<{ file: string; match: string; reason: string }> = [
  {
    file: 'src/services/auth-socket.ts',
    match: "spawn('osascript'",
    reason: 'macOS only (Terminal.app auth window via AppleScript)',
  },
  {
    file: 'src/services/auth-socket.ts',
    match: 'spawn(terminal.bin',
    reason: 'Linux only; opens a terminal emulator the user must type into',
  },
  {
    file: 'src/services/auth-web.ts',
    match: 'spawn(opener.cmd',
    reason: 'intentional browser launch; on win32 a detached `cmd /c start` has no console, so nothing flashes',
  },
];

const SPAWN_FNS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

function listFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|mts|cts|mjs|cjs|js)$/.test(e.name) && !/\.d\.ts$|\.test\./.test(e.name)) out.push(p);
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(REPO_ROOT, d));
  for (const f of SCAN_FILES) out.push(path.join(REPO_ROOT, f));
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Local names that refer to a child_process spawn function in this file. */
function trackedNames(src: string): { names: Set<string>; namespaces: Set<string> } {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  const imp = /import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g;
  for (const m of src.matchAll(imp)) {
    for (const part of m[1].split(',')) {
      const t = part.trim().replace(/^type\s+/, '');
      const am = /^(\w+)(?:\s+as\s+(\w+))?$/.exec(t);
      if (am && SPAWN_FNS.includes(am[1])) names.add(am[2] ?? am[1]);
    }
  }
  for (const m of src.matchAll(/import\s+\*\s+as\s+(\w+)\s+from\s*['"](?:node:)?child_process['"]/g)) namespaces.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/g)) namespaces.add(m[1]);
  // Aliases: X = promisify(name), X = a ?? name, param defaults `X = name`.
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of [...names]) {
      const n1 = escapeRe(n);
      const alias = new RegExp(`\\b(\\w+)\\s*=\\s*(?:promisify\\(\\s*${n1}\\s*\\)|(?:[\\w.]+\\s*\\?\\?\\s*)?${n1}\\b(?!\\s*\\())`, 'g');
      for (const m of src.matchAll(alias)) {
        if (!names.has(m[1]) && m[1] !== n) { names.add(m[1]); grew = true; }
      }
    }
  }
  return { names, namespaces };
}

/** Balanced-paren call text starting at index `start` (the callee name). */
function callText(src: string, start: number): string {
  let i = src.indexOf('(', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

/** Same-file `const NAME = { ... }` objects that set windowsHide. */
function hiddenOptionConsts(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(/(?:const|let)\s+(\w+)\s*=\s*\{/g)) {
    const body = callText(src.replace(/\{/g, '(').replace(/\}/g, ')'), m.index! + m[0].length - 1);
    if (/windowsHide\s*:\s*true/.test(body)) out.add(m[1]);
  }
  return out;
}

interface Site { file: string; line: number; text: string }

function unhiddenSites(): Site[] {
  const bad: Site[] = [];
  for (const abs of listFiles()) {
    const rel = path.relative(REPO_ROOT, abs).replace(/\\/g, '/');
    if (POSIX_ONLY_FILES.has(rel)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    if (!/child_process/.test(src)) continue;
    const { names, namespaces } = trackedNames(src);
    if (names.size === 0 && namespaces.size === 0) continue;
    const hiddenConsts = hiddenOptionConsts(src);
    const alts = [
      ...[...names].map(escapeRe),
      ...[...namespaces].map(ns => `${escapeRe(ns)}\\.(?:${SPAWN_FNS.join('|')})`),
    ];
    const callRe = new RegExp(`(?<![\\w.])(?:${alts.join('|')})\\s*\\(`, 'g');
    for (const m of src.matchAll(callRe)) {
      const lineStart = src.lastIndexOf('\n', m.index!) + 1;
      const lineText = src.slice(lineStart, src.indexOf('\n', m.index!));
      if (/^\s*(\/\/|\*|\/\*)/.test(lineText)) continue;
      if (/\bfunction\s+\w*\s*$/.test(src.slice(lineStart, m.index!))) continue;
      const text = callText(src, m.index!);
      // Bare alias reference with no options at all, e.g. `exec(cmd)`, still counts.
      if (/windowsHide\s*:\s*true/.test(text)) continue;
      const ids = text.match(/\b[A-Za-z_]\w*\b/g) ?? [];
      if (ids.some(id => hiddenConsts.has(id))) continue;
      if (ALLOWLIST.some(a => a.file === rel && text.includes(a.match))) continue;
      bad.push({ file: rel, line: src.slice(0, m.index!).split('\n').length, text: text.replace(/\s+/g, ' ').slice(0, 160) });
    }
  }
  return bad;
}

describe('windowsHide spawn guard', () => {
  it('every child_process spawn in product code and test runners passes windowsHide: true', () => {
    const bad = unhiddenSites();
    expect(bad.map(s => `${s.file}:${s.line} ${s.text}`)).toEqual([]);
  });

  it('allowlist entries still match a real call site (no stale exemptions)', () => {
    for (const a of ALLOWLIST) {
      const src = fs.readFileSync(path.join(REPO_ROOT, a.file), 'utf8');
      expect(src.includes(a.match), `${a.file}: ${a.match}`).toBe(true);
    }
    for (const f of POSIX_ONLY_FILES) expect(fs.existsSync(path.join(REPO_ROOT, f)), f).toBe(true);
  });
});
