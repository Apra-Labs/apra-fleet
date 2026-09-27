import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { registerAllTools } from '../../src/services/tool-registry.js';
import { kbScopeRefusal, KB_SCOPE_REQUIRED_REASON } from '../../src/services/knowledge/kb-scope-guard.js';
import { FLEET_DIR } from '../../src/paths.js';

// Server-handled kb_* calls must name their repo. The fleet server is one
// process serving every project, so a kb_* call with no repo_path/repo (and
// no repo_remote_url where accepted) is refused with repo_scope_required
// instead of resolving a project KB from the server's own process.cwd().
// CLI entry points never go through the MCP registration and keep their
// cwd behavior.

type Handler = (input: unknown, extra?: unknown) => Promise<{
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}>;

async function recordRegisteredTools(): Promise<Map<string, Handler>> {
  const registered = new Map<string, Handler>();
  const fakeServer = {
    tool: (name: string, _d: string, _s: unknown, handler: Handler) => { registered.set(name, handler); },
    server: { sendLoggingMessage: async () => {} },
  };
  await registerAllTools(fakeServer as never);
  return registered;
}

const GUARDED = [
  'kb_capture', 'kb_context', 'kb_export', 'kb_feedback', 'kb_freshness_sweep', 'kb_harvest',
  'kb_import', 'kb_invalidate', 'kb_list', 'kb_promote', 'kb_query', 'kb_reconcile_prefilter',
  'kb_resolve_contradiction', 'kb_session_prime', 'kb_stats',
];

// Every file (path + size + mtime) under the knowledge root, so a test can
// prove a refused call opened, created or wrote no KB database at all.
function snapshotKnowledge(): string[] {
  const root = path.join(FLEET_DIR, 'knowledge');
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { out.push(full + '/'); walk(full); } else {
        const st = fs.statSync(full);
        out.push(`${full} ${st.size} ${st.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

describe('server-handled kb_* tools refuse to guess the repo scope', () => {
  let tools: Map<string, Handler>;
  beforeAll(async () => { tools = await recordRegisteredTools(); });

  it('guards exactly the scoped kb_* tools (kb_setup is exempt: its repo_path is not a KB scope)', () => {
    const kbTools = [...tools.keys()].filter(n => n.startsWith('kb_')).sort();
    expect(kbTools).toEqual([...GUARDED, 'kb_setup'].sort());
  });

  it.each(GUARDED)('%s without any repo scope -> repo_scope_required, and no KB db is created or written', async (name) => {
    const before = snapshotKnowledge();
    const res = await tools.get(name)!({});
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toMatchObject({ isError: true, reason: KB_SCOPE_REQUIRED_REASON, code: 'E-REPO-SCOPE-REQUIRED', tool: name });
    expect(res.content[0].text).toContain(`${name}: repo scope required`);
    expect(res.content[0].text).toContain('repo_path');
    expect(snapshotKnowledge()).toEqual(before);
  });

  it('blank strings do not count as a scope', async () => {
    const res = await tools.get('kb_query')!({ query: 'x', repo_path: '   ', repo_remote_url: '' });
    expect(res.structuredContent).toMatchObject({ reason: KB_SCOPE_REQUIRED_REASON });
  });

  it('with repo_path the call proceeds exactly as before', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-scope-guard-repo-'));
    try {
      const res = await tools.get('kb_list')!({ repo_path: repo });
      expect(res.isError).toBeUndefined();
      const parsed = JSON.parse(res.content[res.content.length - 1].text);
      expect(parsed).toHaveProperty('results');
      expect(parsed).toHaveProperty('total');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('kbScopeRefusal()', () => {
  it('accepts repo_remote_url alone for tools that do not resolve a local checkout', () => {
    expect(kbScopeRefusal('kb_query', { repo_remote_url: 'https://example.com/acme/widgets.git' })).toBeNull();
    expect(kbScopeRefusal('kb_capture', { repo_remote_url: 'git@example.com:acme/widgets.git' })).toBeNull();
  });

  it.each(['kb_export', 'kb_import', 'kb_stats', 'kb_session_prime'])(
    '%s needs a local repo path: repo_remote_url alone is refused',
    (name) => {
      const r = kbScopeRefusal(name, { repo_remote_url: 'https://example.com/acme/widgets.git' });
      expect(r?.structuredContent.reason).toBe(KB_SCOPE_REQUIRED_REASON);
      expect(r?.content[0].text).not.toContain('repo_remote_url');
    },
  );

  it('accepts the `repo` alias used by kb_import and kb_stats', () => {
    expect(kbScopeRefusal('kb_import', { repo: '/some/repo' })).toBeNull();
    expect(kbScopeRefusal('kb_stats', { repo: '/some/repo' })).toBeNull();
  });
});

// The post-commit hook's `apra-fleet kb invalidate` runs in the user's own
// shell inside the repo: it must keep resolving the project from its cwd.
describe('CLI `apra-fleet kb invalidate` still resolves the project from cwd', () => {
  const distIndex = path.join(process.cwd(), 'dist', 'index.js');
  let tmp: string;
  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-scope-cli-')); });
  afterAll(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

  it.skipIf(!fs.existsSync(distIndex))('creates/uses the KB scope of the repo it is run in', () => {
    const repo = path.join(tmp, 'repo');
    const data = path.join(tmp, 'data');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(data, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/acme/cli-scope-probe.git'], { cwd: repo });
    const out = execFileSync(process.execPath, [distIndex, 'kb', 'invalidate', 'src/a.ts'], {
      cwd: repo,
      env: { ...process.env, APRA_FLEET_DATA_DIR: data },
      encoding: 'utf-8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    expect(out).toContain('Invalidated 0 entries.');
    expect(fs.existsSync(path.join(data, 'knowledge', 'githubcom-acme-cli-scope-probe', 'kb.sqlite'))).toBe(true);
  });
});
