import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  installerName,
  installerPath,
  launchdTarget,
  assertMacOS,
  parseArgs,
  main,
  DeployInstallError,
  installArgs,
  memberAccessKeyPath,
  // @ts-expect-error -- plain .mjs helper, no type declarations
} from '../scripts/deploy-install.mjs';

const repoRoot = path.resolve(__dirname, '..');

/** Returns the offending commands (with 1-based file line numbers) in shell fences. */
function findForbiddenShell(markdown: string): string[] {
  const problems: string[] = [];
  const lines = markdown.split(/\r?\n/);
  let inShell = false;
  let inOther = false;
  lines.forEach((line, i) => {
    const fence = /^\s*```\s*([A-Za-z0-9_-]*)/.exec(line);
    if (fence) {
      if (inShell || inOther) { inShell = false; inOther = false; return; }
      if (['bash', 'sh', 'shell'].includes(fence[1].toLowerCase())) inShell = true; else inOther = true;
      return;
    }
    if (!inShell) return;
    const t = line.trim();
    if (t === '' || t.startsWith('#')) return;
    if (t.includes('$(')) problems.push(`line ${i + 1}: command substitution $( : ${t}`);
    if (t.includes('`')) problems.push(`line ${i + 1}: backtick: ${t}`);
    if (/^(for|while|until)\b/.test(t)) problems.push(`line ${i + 1}: shell loop: ${t}`);
  });
  return problems;
}

describe('deploy.md commands', () => {
  const md = fs.readFileSync(path.join(repoRoot, 'deploy.md'), 'utf8');

  it('shell blocks contain no command substitution, backticks or loops', () => {
    expect(findForbiddenShell(md), findForbiddenShell(md).join('\n')).toEqual([]);
  });

  it('the checker flags the old uname substitution and a loop (self-check)', () => {
    const bad = '```bash\n# fine $(x)\nOS="$(uname -s)"\nfor f in a; do echo $f; done\n```\n';
    const found = findForbiddenShell(bad);
    expect(found.some((p) => p.startsWith('line 3'))).toBe(true);
    expect(found.some((p) => p.includes('shell loop'))).toBe(true);
    expect(found.some((p) => p.startsWith('line 2'))).toBe(false);
  });
});

describe('scripts/deploy-install.mjs', () => {
  it.each([
    ['darwin', 'x64', 'apra-fleet-installer-darwin-x64'],
    ['darwin', 'arm64', 'apra-fleet-installer-darwin-arm64'],
    ['linux', 'x64', 'apra-fleet-installer-linux-x64'],
    ['linux', 'arm64', 'apra-fleet-installer-linux-arm64'],
    ['win32', 'x64', 'apra-fleet-installer-win-x64.exe'],
    ['win32', 'arm64', 'apra-fleet-installer-win-arm64.exe'],
    ['linux', 'x86_64', 'apra-fleet-installer-linux-x64'],
    ['linux', 'aarch64', 'apra-fleet-installer-linux-arm64'],
  ])('%s/%s -> %s', (platform, arch, name) => {
    expect(installerName(platform, arch)).toBe(name);
    expect(installerPath(platform, arch)).toBe(`dist/${name}`);
  });

  it('builds the launchd target from the uid', () => {
    expect(launchdTarget(501)).toBe('gui/501/com.apra-fleet.server');
  });

  it('--launchagent hard-fails with a clear message off macOS', async () => {
    expect(() => assertMacOS('linux')).toThrow(/macOS only/);
    expect(() => assertMacOS('darwin')).not.toThrow();
    await expect(main(['--launchagent'], { platform: 'win32', arch: 'x64' })).rejects.toThrow(DeployInstallError);
    await expect(main(['--launchagent'], { platform: 'linux', arch: 'x64' })).rejects.toThrow(/macOS only/);
  });

  it('adds --ignore-running-sprints only when a member access key already exists', async () => {
    expect(installArgs(['--llm', 'agy'], true)).toEqual(['--llm', 'agy', '--ignore-running-sprints']);
    expect(installArgs(['--llm', 'agy'], false)).toEqual(['--llm', 'agy']);
    expect(installArgs(['--ignore-running-sprints'], true)).toEqual(['--ignore-running-sprints']);
    expect(memberAccessKeyPath({ APRA_FLEET_DATA_DIR: '/d' }, '/h')).toBe(path.join('/d', 'member-access.key'));
    expect(memberAccessKeyPath({}, '/h')).toBe(path.join('/h', '.apra-fleet', 'data', 'member-access.key'));

    const calls: string[][] = [];
    const run = async (_installer: string, extra: string[]) => { calls.push(extra); return { code: 0, seen: '' }; };
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await main([], { platform: 'linux', arch: 'x64', memberKeyExists: () => true, run })).toBe(0);
      expect(await main([], { platform: 'linux', arch: 'x64', memberKeyExists: () => false, run })).toBe(0);
    } finally {
      stderr.mockRestore();
    }
    expect(calls).toEqual([['--ignore-running-sprints'], []]);
  });

  it('parses flags and passthrough args, rejects unknown ones', () => {
    expect(parseArgs(['--launchagent', '--', '--llm', 'agy'])).toEqual({ launchagent: true, printPath: false, extra: ['--llm', 'agy'] });
    expect(parseArgs(['--llm', 'agy'])).toEqual({ launchagent: false, printPath: false, extra: ['--llm', 'agy'] });
    expect(() => parseArgs(['--llm'])).toThrow(/requires a value/);
    expect(() => parseArgs(['--bogus'])).toThrow(/unknown argument/);
  });
});
