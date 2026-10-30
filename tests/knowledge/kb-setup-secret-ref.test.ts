import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { kbSetup } from '../../src/tools/kb-setup.js';
import { FLEET_DIR } from '../../src/paths.js';
import { decryptPassword } from '../../src/utils/crypto.js';
import { credentialSet, credentialDelete } from '../../src/services/credential-store.js';
import { isolateGitConfig } from './isolate-git-config.js';

const configPath = path.join(FLEET_DIR, 'knowledge', 'config.json');
const NAME = 'KBSETUP_REF_TEST';
const CANARY = 'canary-secret-value-9f3a1c';
const REMOTE = 'https://kb.example.test';

let tmpDir: string;
let savedConfig: string | null;
let restoreGitConfig: () => void;

beforeEach(() => {
  restoreGitConfig = isolateGitConfig();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-setup-ref-'));
  execFileSync('git', ['init', '-q'], { cwd: tmpDir });
  savedConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : null;
  fs.rmSync(configPath, { force: true });
  credentialSet(NAME, CANARY, true, 'allow');
});

afterEach(() => {
  credentialDelete(NAME);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (savedConfig === null) fs.rmSync(configPath, { force: true });
  else fs.writeFileSync(configPath, savedConfig);
  restoreGitConfig();
});

const hookPath = () => path.join(tmpDir, '.git', 'hooks', 'post-commit');
const readConfig = () => JSON.parse(fs.readFileSync(configPath, 'utf-8'));
function writeConfig(content: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, content);
}

describe('kb_setup named secret token', () => {
  it('stores only the placeholder for an existing secret', async () => {
    const out = await kbSetup({ remote: REMOTE, token: `{{secret.${NAME}}}` }, { folder: tmpDir });
    expect(JSON.parse(out).success).toBe(true);
    const cfg = readConfig();
    expect(cfg.token_ref).toBe(`{{secret.${NAME}}}`);
    expect(cfg).not.toHaveProperty('token_encrypted');
    expect(fs.readFileSync(configPath, 'utf-8')).not.toContain(CANARY);
    expect(out).not.toContain(CANARY);
    expect(out).toContain(`reference to secret ${NAME}`);
  });

  it('accepts the legacy spelling with a deprecation warning and stores the canonical form', async () => {
    const out = JSON.parse(await kbSetup({ remote: REMOTE, token: `{{secure.${NAME}}}` }, { folder: tmpDir }));
    expect(out.success).toBe(true);
    expect(out.warnings.join(' ')).toMatch(/deprecated/);
    expect(readConfig().token_ref).toBe(`{{secret.${NAME}}}`);
  });

  const bad: Array<[string, string]> = [
    ['quotes', `"{{secret.${NAME}}}"`],
    ['text before', `Bearer {{secret.${NAME}}}`],
    ['text after', `{{secret.${NAME}}}x`],
    ['two placeholders', `{{secret.${NAME}}}{{secret.${NAME}}}`],
  ];
  for (const [label, token] of bad) {
    it(`refuses ${label} leaving config and hook untouched`, async () => {
      writeConfig('{"provider":"sqlite"}');
      const before = fs.readFileSync(configPath, 'utf-8');
      await expect(kbSetup({ remote: REMOTE, token }, { folder: tmpDir })).rejects.toThrow(/token/);
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
      expect(fs.existsSync(hookPath())).toBe(false);
    });
  }

  it('refuses a missing secret for provider http, naming it and the fix, without leaking values', async () => {
    writeConfig('{"provider":"sqlite"}');
    const before = fs.readFileSync(configPath, 'utf-8');
    let msg = '';
    try {
      await kbSetup({ provider: 'http', remote: REMOTE, token: '{{secret.NO_SUCH_KB_SECRET}}' }, { folder: tmpDir });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('NO_SUCH_KB_SECRET');
    expect(msg).toContain('apra-fleet secret --set NO_SUCH_KB_SECRET --persist -y');
    expect(msg).not.toContain(CANARY);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(before);
    expect(fs.existsSync(hookPath())).toBe(false);
  });

  it('refuses an expired secret for provider http', async () => {
    credentialSet(NAME, CANARY, true, 'allow', '*', -10);
    await expect(kbSetup({ remote: REMOTE, token: `{{secret.${NAME}}}` }, { folder: tmpDir }))
      .rejects.toThrow(new RegExp(NAME));
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('does not check secret existence for provider sqlite', async () => {
    const out = JSON.parse(await kbSetup({ provider: 'sqlite', token: '{{secret.NO_SUCH_KB_SECRET}}' }, { folder: tmpDir }));
    expect(out.success).toBe(true);
    expect(readConfig().token_ref).toBe('{{secret.NO_SUCH_KB_SECRET}}');
  });
});

describe('kb_setup literal token regression', () => {
  it('writes token_encrypted for a literal token, no token_ref', async () => {
    const token = crypto.randomBytes(8).toString('hex');
    await kbSetup({ remote: REMOTE, token }, { folder: tmpDir });
    const cfg = readConfig();
    expect(decryptPassword(cfg.token_encrypted)).toBe(token);
    expect(cfg).not.toHaveProperty('token_ref');
  });

  it('switching literal -> ref -> literal removes the other key', async () => {
    await kbSetup({ remote: REMOTE, token: 'literal-one' }, { folder: tmpDir });
    await kbSetup({ remote: REMOTE, token: `{{secret.${NAME}}}` }, { folder: tmpDir });
    let cfg = readConfig();
    expect(cfg).toHaveProperty('token_ref');
    expect(cfg).not.toHaveProperty('token_encrypted');
    await kbSetup({ remote: REMOTE, token: 'literal-two' }, { folder: tmpDir });
    cfg = readConfig();
    expect(cfg).not.toHaveProperty('token_ref');
    expect(decryptPassword(cfg.token_encrypted)).toBe('literal-two');
  });

  it('URL change without a token drops token_ref with the existing warning', async () => {
    await kbSetup({ remote: REMOTE, token: `{{secret.${NAME}}}` }, { folder: tmpDir });
    const out = JSON.parse(await kbSetup({ remote: 'https://other.example.test' }, { folder: tmpDir }));
    expect(out.warnings[0]).toMatch(/remote changed and no token was given/);
    expect(readConfig()).not.toHaveProperty('token_ref');
  });
});
