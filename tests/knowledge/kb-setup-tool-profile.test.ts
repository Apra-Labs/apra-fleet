import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { runKbProfile, parseKbProfileArgs } from '../../src/cli/kb-profile.js';
import { FLEET_DIR } from '../../src/paths.js';
import { isolateGitConfig } from './isolate-git-config.js';

// Setting the KB tool profile (GitHub #759) through kb_setup and the
// `apra-fleet kb profile` verb. FLEET_DIR is shared by the run: every test
// starts from no config and puts back whatever was there.

let tmpDir: string;
const configPath = path.join(FLEET_DIR, 'knowledge', 'config.json');
let savedConfig: string | null;
let restoreGitConfig: () => void;

beforeEach(() => {
  restoreGitConfig = isolateGitConfig();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-setup-profile-test-'));
  execFileSync('git', ['init', '-q'], { cwd: tmpDir });
  savedConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  fs.rmSync(configPath, { force: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedConfig === null) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, savedConfig);
  restoreGitConfig();
});

function readConfig(): Record<string, any> {
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function writeConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function captureIo() {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { log: (m: string) => out.push(m), error: (m: string) => err.push(m) }, out, err };
}

describe('kb_setup tool_profile', () => {
  it('writes developer and leaves the existing provider settings intact', async () => {
    writeConfig({ provider: 'http', url: 'https://kb.example.test', token_ref: '{{secret.KB_TOKEN}}', request_timeout_ms: 9000, bible: { autoCommit: false } });
    const result = JSON.parse(await kbSetup({ tool_profile: 'developer' }, { folder: tmpDir }));
    expect(result.success).toBe(true);
    expect(result.steps.some((s: string) => /KB tool profile to developer.*reconnects/.test(s))).toBe(true);
    expect(readConfig()).toEqual({
      provider: 'http', url: 'https://kb.example.test', token_ref: '{{secret.KB_TOKEN}}', request_timeout_ms: 9000,
      bible: { autoCommit: false }, tool_profile: 'developer',
    });
  });

  it('writes a custom list and drops it again when switching back to full', async () => {
    await kbSetup({ tool_profile: 'custom', tool_profile_tools: ['kb_query', 'kb_setup'] }, { folder: tmpDir });
    expect(readConfig()).toMatchObject({ tool_profile: 'custom', tool_profile_tools: ['kb_query', 'kb_setup'] });
    await kbSetup({ tool_profile: 'full' }, { folder: tmpDir });
    const config = readConfig();
    expect(config.tool_profile).toBe('full');
    expect(config).not.toHaveProperty('tool_profile_tools');
  });

  it('refuses an unknown custom name with a clear error and writes nothing', async () => {
    writeConfig({ provider: 'sqlite', tool_profile: 'developer' });
    const before = fs.readFileSync(configPath, 'utf-8');
    await expect(kbSetup({ tool_profile: 'custom', tool_profile_tools: ['kb_query', 'kb_bogus'] }, { folder: tmpDir }))
      .rejects.toThrow(/unknown kb tool name\(s\): kb_bogus\. Valid names: .*kb_query/);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    expect(fs.existsSync(path.join(tmpDir, '.git', 'hooks', 'post-commit'))).toBe(false);
  });

  it('refuses tool_profile_tools without tool_profile custom', async () => {
    await expect(kbSetup({ tool_profile: 'developer', tool_profile_tools: ['kb_query'] }, { folder: tmpDir }))
      .rejects.toThrow(/only valid with tool_profile "custom"/);
    await expect(kbSetup({ tool_profile_tools: ['kb_query'] }, { folder: tmpDir }))
      .rejects.toThrow(/only valid with tool_profile "custom"/);
    expect(fs.existsSync(configPath)).toBe(false);
  });
});

describe('apra-fleet kb profile', () => {
  it('rewrites a developer config to full, keeping the other keys', () => {
    writeConfig({ provider: 'sqlite', tool_profile: 'developer', bible: { autoCommit: false } });
    const { io, out } = captureIo();
    expect(runKbProfile(['full'], io)).toBe(0);
    expect(readConfig()).toEqual({ provider: 'sqlite', tool_profile: 'full', bible: { autoCommit: false } });
    expect(out.join('\n')).toMatch(/reconnect/);
  });

  it('prints the current profile with no argument', () => {
    const { io, out } = captureIo();
    expect(runKbProfile([], io)).toBe(0);
    expect(out[0]).toMatch(/^KB tool profile: full/);
    writeConfig({ tool_profile: 'custom', tool_profile_tools: ['kb_query'] });
    const second = captureIo();
    expect(runKbProfile([], second.io)).toBe(0);
    expect(second.out[0]).toBe('KB tool profile: custom (kb_query)');
  });

  it('sets custom from a comma-separated list', () => {
    const { io } = captureIo();
    expect(runKbProfile(['custom', 'kb_query,kb_capture'], io)).toBe(0);
    expect(readConfig()).toMatchObject({ tool_profile: 'custom', tool_profile_tools: ['kb_query', 'kb_capture'] });
  });

  it('exits non-zero with usage on an unknown tool name and writes nothing', () => {
    writeConfig({ tool_profile: 'developer' });
    const before = fs.readFileSync(configPath, 'utf-8');
    const { io, err } = captureIo();
    expect(runKbProfile(['custom', 'kb_query,kb_bogus'], io)).toBe(1);
    expect(err.join('\n')).toMatch(/kb_bogus/);
    expect(err.join('\n')).toMatch(/Usage: apra-fleet kb profile/);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
  });

  it('exits non-zero with usage on an unknown profile or stray arguments', () => {
    const { io, err } = captureIo();
    expect(runKbProfile(['minimal'], io)).toBe(1);
    expect(runKbProfile(['full', 'kb_query'], io)).toBe(1);
    expect(runKbProfile(['custom'], io)).toBe(1);
    expect(err.filter(l => l.startsWith('Usage:')).length).toBe(3);
    expect(fs.existsSync(configPath)).toBe(false);
  });

  describe('a config it cannot parse', () => {
    const TRAILING_COMMA = '{"provider":"http","url":"https://kb.example.test","token_ref":"{{secret.KB}}",}';

    for (const [name, content] of [
      ['malformed JSON', TRAILING_COMMA],
      ['an empty file', ''],
      ['a JSON array', '[]'],
    ] as const) {
      it(`${name}: setting a profile exits 1, says to fix it by hand and leaves the file as it was`, () => {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, content);
        const { io, err } = captureIo();
        expect(runKbProfile(['full'], io)).toBe(1);
        expect(fs.readFileSync(configPath, 'utf-8')).toBe(content);
        const text = err.join('\n');
        expect(text).toContain(configPath);
        expect(text).toMatch(/nothing was written/);
        expect(text).toMatch(/by hand/);
      });
    }

    it('printing the profile on malformed JSON advises the hand fix, not a command that rewrites the file', () => {
      fs.mkdirSync(path.dirname(configPath), { recursive: true });
      fs.writeFileSync(configPath, TRAILING_COMMA);
      const { io, err } = captureIo();
      expect(runKbProfile([], io)).toBe(1);
      const text = err.join('\n');
      expect(text).toContain(configPath);
      expect(text).toMatch(/by hand/);
      expect(text).not.toMatch(/apra-fleet kb profile/);
      // The JSON parser's message can quote the file; it must not reach the user.
      expect(text).not.toContain('kb.example.test');
    });

    it('printing a parseable but unknown profile still offers the CLI fix, which keeps the other keys', () => {
      writeConfig({ provider: 'http', url: 'https://kb.example.test', tool_profile: 'Developer' });
      const first = captureIo();
      expect(runKbProfile([], first.io)).toBe(1);
      expect(first.err.join('\n')).toMatch(/"Developer"/);
      expect(first.err.join('\n')).toMatch(/apra-fleet kb profile full/);
      const second = captureIo();
      expect(runKbProfile(['full'], second.io)).toBe(0);
      expect(readConfig()).toEqual({ provider: 'http', url: 'https://kb.example.test', tool_profile: 'full' });
    });
  });

  it('parseKbProfileArgs accepts space- or comma-separated custom lists', () => {
    expect(parseKbProfileArgs(['custom', 'kb_query,', 'kb_capture'])).toEqual({ name: 'custom', tools: ['kb_query', 'kb_capture'] });
    expect(parseKbProfileArgs([])).toBeNull();
  });
});
