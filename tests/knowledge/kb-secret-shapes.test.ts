import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { SqliteProvider } from '../../src/services/knowledge/sqlite-provider.js';
import { kbBibleCommit } from '../../src/tools/kb-bible-commit.js';
import { hasBibleSecret, scrubBibleSecrets } from '../../src/tools/kb-export.js';
import * as kbProvidersModule from '../../src/services/knowledge/kb-providers.js';
import { vetKbWork } from '../../packages/apra-fleet-se/fleet-sprint/kb.mjs';
import { commitWorkTree } from '../helpers/commit-work-tree.js';

// PR 790 judge F6: the secret shapes the bible writer redacts
// (BIBLE_SECRET_SHAPES in src/tools/kb-export.ts) and the ones the engine
// capture lint refuses (KB_SECRET_RE plus KB_PLACEHOLDER_RE in fleet-sprint
// kb.mjs) agree on one corpus; prose that only looks like a credential is left
// alone; and a prior bible value holding a secret is scrubbed on re-merge.
//
// Every token below is built by concatenation, so no token-shaped literal lives
// in this repository (secret scanners).

const MUST_FLAG: Record<string, string> = {
  'OpenAI project key': 'sk-' + 'proj-' + 'Ab3dEf6hIj9kLm2nOp5qRs8t',
  'Anthropic key': 'sk-' + 'ant-' + 'api03-' + 'Zx9Yw8Vu7Ts6Rq5Po4Nm',
  'npm token': 'npm' + '_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  'JWT': 'ey' + 'JhbGciOiJIUzI1NiJ9' + '.' + 'ey' + 'JzdWIiOiIxMjM0NTY3ODkwIn0' + '.' + 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  'PEM RSA private key header': '-----' + 'BEGIN RSA ' + 'PRIVATE KEY' + '-----',
  'PEM private key header': '-----' + 'BEGIN ' + 'PRIVATE KEY' + '-----',
  'PEM OpenSSH private key header': '-----' + 'BEGIN OPENSSH ' + 'PRIVATE KEY' + '-----',
  'classic GitHub token': 'gh' + 'p_' + 'a1'.repeat(18),
  'random Bearer value': 'Bear' + 'er ' + 'd4'.repeat(20),
  'mixed-case Bearer value': 'Bear' + 'er ' + 'AbCdEfGhIjKlMnOpQrStUv',
  'base64 Basic value': 'Bas' + 'ic ' + 'dXNlcm5hbWU6cGFzc3dvcmQxMjM=',
  'secret placeholder': '{{' + 'secret.GH_TOKEN' + '}}',
};

const MUST_NOT_FLAG: Record<string, string> = {
  'Bearer with hyphenated words': 'Bear' + 'er some-long-hyphenated-words',
  'Basic with a source path': 'Bas' + 'ic src/long/path.ts',
  'GitHub Actions secrets expression': '$' + '{{ secrets.GITHUB_TOKEN }}',
  'GitHub Actions expression without spaces': '$' + '{{secrets.NPM_TOKEN}}',
  'sk- prefix in prose': 'the sk-learn-style naming of the helper module',
  'npm_ prefix in prose': 'npm' + '_config_registry is an env var',
  'eyJ in prose': 'a JWT starts with eyJ and has three dotted parts',
  'PEM public key header': '-----' + 'BEGIN PUBLIC KEY' + '-----',
};

/** True when the engine capture lint refuses a capture whose summary holds `text` for a secret or placeholder. */
function engineFlags(text: string): boolean {
  const { refused } = vetKbWork('doer', { kb_captures: [{
    type: 'knowledge', title: 'A capture about credentials',
    summary: 'The job config holds ' + text + ' for each call.',
    trigger: 'env-quirk', source_files: ['src/alpha.ts'], symbols: ['fixture'],
  }] });
  if (refused.length === 0) return false;
  const reason = String(refused[0]);
  expect(reason, 'refused only for a secret or placeholder: ' + reason).toMatch(/rule (secret|placeholder)/);
  return true;
}

describe('secret shapes: server and engine agree', () => {
  for (const [name, text] of Object.entries(MUST_FLAG)) {
    it('flags ' + name, () => {
      expect(hasBibleSecret('context: ' + text + ' end')).toBe(true);
      expect(scrubBibleSecrets('context: ' + text + ' end')).not.toContain(text);
      expect(engineFlags(text)).toBe(true);
    });
  }
  for (const [name, text] of Object.entries(MUST_NOT_FLAG)) {
    it('does not flag ' + name, () => {
      expect(hasBibleSecret('context: ' + text + ' end')).toBe(false);
      expect(engineFlags(text)).toBe(false);
    });
  }
  it('server and engine give the same verdict on the whole corpus', () => {
    for (const text of [...Object.values(MUST_FLAG), ...Object.values(MUST_NOT_FLAG)]) {
      expect(engineFlags(text), text).toBe(hasBibleSecret(text));
    }
  });
});

describe('kb_bible_commit: a prior bible value holding a secret is scrubbed on re-merge', () => {
  let sandbox: string;
  let repo: string;
  let provider: SqliteProvider;
  let savedGitEnv: Array<[string, string | undefined]>;
  const BASE = { baseBranch: 'main', baseCommit: 'a'.repeat(40) };
  const biblePath = () => path.join(repo, '.fleet', 'kb-canonical.json');

  beforeEach(async () => {
    sandbox = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-secret-shapes-')));
    const gitconfig = path.join(sandbox, '.gitconfig');
    fs.writeFileSync(gitconfig, '[user]\n\tname = KB Test\n\temail = kb@test.invalid\n[commit]\n\tgpgsign = false\n');
    savedGitEnv = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'].map(k => [k, process.env[k]]);
    process.env.GIT_CONFIG_GLOBAL = gitconfig;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    repo = path.join(sandbox, 'repo');
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'alpha.ts'), 'export const alpha = 1;\n');
    execFileSync('git', ['init', '--quiet', '-b', 'main', repo]);
    commitWorkTree(repo, 'seed');
    provider = new SqliteProvider(path.join(sandbox, 'kb.sqlite'), repo);
    await provider.init();
    vi.spyOn(kbProvidersModule, 'getKbProviders').mockResolvedValue({
      project: provider, global: provider, projectSlug: 'test',
    } as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    provider.close();
    for (const [k, v] of savedGitEnv) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('content, cues and signatures kept from the bible leave the re-merge redacted', async () => {
    const { id } = await provider.capture({
      type: 'learning', title: 'alpha is read first', summary: 'alpha must be read before beta at module load.',
      content: 'alpha must be read before beta at module load.',
      source_files: ['src/alpha.ts'], symbols: ['alpha'], tags: [], content_hash: '', content_hash_type: 'sha256',
      flagged_for_review: false, author: 'test-agent', source: 'doer', confidence: 'INFERRED',
    });
    await provider.promote(id, 'test fixture: verified');
    await provider.promote(id, 'test fixture: verified');
    expect(JSON.parse(await kbBibleCommit({ ids: [id], ...BASE }, { folder: repo })).committed).toBe(true);

    // An older writer left secret-shaped text in the committed bible entry.
    const token = MUST_FLAG['OpenAI project key'];
    const jwt = MUST_FLAG.JWT;
    const doc = JSON.parse(fs.readFileSync(biblePath(), 'utf-8'));
    doc.entries[0].content = 'The loader reads alpha lazily; the old setup sent ' + token + ' on every call.';
    doc.entries[0].recall_cues = ['why alpha with ' + token];
    doc.entries[0].error_signatures = ['401 for ' + jwt];
    fs.writeFileSync(biblePath(), JSON.stringify(doc, null, 2) + '\n');
    commitWorkTree(repo, 'older writer');

    const r = JSON.parse(await kbBibleCommit({ ids: [id], ...BASE }, { folder: repo }));
    expect(r.merged).toEqual([id]);
    expect(r.committed).toBe(true);
    const text = fs.readFileSync(biblePath(), 'utf-8');
    expect(text).not.toContain(token);
    expect(text).not.toContain(jwt);
    const entry = JSON.parse(text).entries[0];
    expect(entry.content).toBe('The loader reads alpha lazily; the old setup sent [REDACTED] on every call.');
    expect(entry.recall_cues).toEqual(['why alpha with [REDACTED]']);
    expect(entry.error_signatures).toEqual(['401 for [REDACTED]']);
  });
});
