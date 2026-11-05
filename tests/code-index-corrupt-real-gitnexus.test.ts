import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The corrupt-index detector against a REAL gitnexus index, no mocked answers:
// clone this repository, build a full index, make a one-line edit, run the
// incremental analyze, and ask for a symbol of a file that was not edited.
// Generated repos of 85, 2601 and 9201 nodes did not reproduce the corruption, so this
// needs a large real repo and takes about 6-10 minutes: it is opted in with
// APRA_RUN_REAL_GITNEXUS=1 (vitest.config.ts; the nightly regression.yml job
// code-index-real-gitnexus sets it), and is out of the default `npm test`.
//
// Isolation: the clone lives in one scratch dir removed in afterAll; gitnexus's
// registry follows HOME, which the test sandbox (scripts/test-sandbox.mjs)
// redirects, so the test refuses to run without that sandbox. Only the rebuild
// the detector would request is mocked (tests/setup.ts): the test runs the
// rebuild itself, to prove --force repairs the index.
//
// Environment vs real failure. The fleet's child is the real one, but two things
// about this runner must not decide the result, and a timeout must read as one:
// - Its npx install is pre-installed in beforeAll. npx keys its install dir by the
//   exact spec string, so ANALYZER's install is never the child's, and the child's
//   env (the MCP SDK's short default list) can also select another npm cache. Left
//   alone, the child cold-installs inside its connect handshake.
// - Connect and calls get CHILD_TIMEOUT_MS instead of the SDK's 60 s default, through
//   a subclass of the real client: there is no product option for this.
// A child failure surfaces with its reason: the offline text says TIMEOUT or failed,
// with the child's stderr, and payloadOf prints all of it.

const ANALYZER = 'gitnexus@1.6.12';
const EDITED_FILE = 'src/services/tool-scope.ts';
const child = vi.hoisted(() => ({ CHILD_TIMEOUT_MS: 300_000, failures: [] as string[] }));

vi.mock('../src/tools/code-intelligence-reindex.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/tools/code-intelligence-reindex.js')>();
  return { ...actual, maybeScheduleReindex: () => false };
});
vi.mock('@modelcontextprotocol/sdk/client/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/sdk/client/index.js')>();
  type Base = InstanceType<typeof actual.Client>;
  class PatientClient extends actual.Client {
    connect(...[transport, options]: Parameters<Base['connect']>) {
      return super.connect(transport, { ...options, timeout: child.CHILD_TIMEOUT_MS });
    }
    async callTool(...[params, schema, options]: Parameters<Base['callTool']>) {
      try {
        const result = await super.callTool(params, schema, { ...options, timeout: child.CHILD_TIMEOUT_MS });
        if (result.isError) child.failures.push(`${params.name}: ${JSON.stringify(result.content)}`);
        return result;
      } catch (err) {
        child.failures.push(`${params.name}: ${String(err)}`);
        throw err;
      }
    }
  }
  return { ...actual, Client: PatientClient };
});
vi.mock('../src/services/registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/registry.js')>();
  return { ...actual, getAgent: () => ({ codeIntelProvider: 'gitnexus' }) };
});

import { handleCodeContext } from '../src/tools/code-intelligence.js';
import { INDEX_ID_UNIQUENESS_QUERY, parseMarkdownTable } from '../src/tools/code-intelligence-gitnexus.js';
import { scheduleIndexBuild } from '../src/tools/code-index-heal.js';
import { GITNEXUS_PACKAGE_SPEC } from '../src/tools/code-intelligence-reindex.js';
import { getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(__dirname, '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let scratch: string;
let repo: string;

function gitnexus(...args: string[]): string {
  // shell only where a .cmd needs it; a cypher query travels through a file-free
  // argument, so quote it for cmd.exe.
  const quoted = process.platform === 'win32' ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
  return execFileSync(npx, ['-y', ANALYZER, ...quoted], {
    cwd: repo, encoding: 'utf8', timeout: 480_000, maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32', windowsHide: true,
  });
}

// Install the child's package where the child will look for it. Asks npm for the
// cache under the child's env rather than assuming it; installs with the full env,
// which build tools need and the child's env lacks.
function preinstallChildPackage(): void {
  const shell = process.platform === 'win32';
  const spec = shell ? `"${GITNEXUS_PACKAGE_SPEC}"` : GITNEXUS_PACKAGE_SPEC;
  const started = Date.now();
  try {
    const cache = execFileSync(npm, ['config', 'get', 'cache'], {
      env: getDefaultEnvironment(), encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], shell, windowsHide: true,
    }).trim();
    execFileSync(npx, ['-y', spec, '--help'], {
      env: { ...process.env, npm_config_cache: cache }, encoding: 'utf8', timeout: 480_000, maxBuffer: 256 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'], shell, windowsHide: true,
    });
    console.log(`[real-gitnexus] ${GITNEXUS_PACKAGE_SPEC} ready in ${cache} after ${Date.now() - started} ms`);
  } catch (err) {
    const e = err as { code?: string; message?: string };
    const outcome = e.code === 'ETIMEDOUT' ? 'TIMEOUT' : 'failed';
    throw new Error(`[environment] pre-install of ${GITNEXUS_PACKAGE_SPEC} ${outcome} after ${Date.now() - started} ms: ${e.message}`);
  }
}

function cypherRows(query: string): Array<Record<string, string>> {
  const out = gitnexus('cypher', query);
  const parsed = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as { markdown: string };
  return parseMarkdownTable(parsed.markdown);
}

function damagedRows(): number {
  const row = cypherRows(INDEX_ID_UNIQUENESS_QUERY)[0];
  return Number(row.total) - Number(row.distinct_ids);
}

function functionIds(): Map<string, string> {
  const rows = cypherRows('MATCH (n:Function) RETURN n.id AS id, n.name AS name');
  return new Map(rows.map((r) => [r.id, r.name]));
}

function payloadOf(result: unknown): Record<string, unknown> {
  const content = (result as { content: Array<{ text: string }> }).content;
  try {
    return JSON.parse(content[0].text.split('\n\n---\n')[0]) as Record<string, unknown>;
  } catch {
    const full = content.map((c) => c.text).join('\n');
    const kind = /\bTIMEOUT during\b/.test(full) ? 'gitnexus child TIMEOUT' : 'gitnexus or fleet failure';
    return expect.fail(`${kind}: the fleet response is not JSON. Full response:\n${full}`);
  }
}

const context = (name: string) => handleCodeContext({ name }, { repo, memberId: 'm' });

beforeAll(() => {
  expect(process.env.APRA_TEST_SANDBOX_ROOT, 'run through scripts/run-all-tests.mjs: gitnexus writes its registry under HOME').toBeTruthy();
  delete process.env.GITNEXUS_HOME;
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-corrupt-real-')));
  repo = path.join(scratch, 'repo');
  execFileSync('git', ['clone', '-q', '--no-hardlinks', repoRoot, repo], { windowsHide: true });
  preinstallChildPackage();
}, 600_000);

afterAll(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('corrupt-index detector on a real gitnexus index', () => {
  it('a healthy index is unflagged; an incremental analyze corrupts it and the not-found answer is flagged; --force repairs it', async () => {
    const schedule = vi.mocked(scheduleIndexBuild);
    schedule.mockClear();

    gitnexus('analyze', '--index-only', '--force', '.');
    expect(damagedRows(), 'a full build has one row per id').toBe(0);
    const healthy = functionIds();
    expect(healthy.size).toBeGreaterThan(1000);

    const missing = payloadOf(await context('noSuchSymbolAnywhere791'));
    expect(missing.error).toBe("Symbol 'noSuchSymbolAnywhere791' not found");
    expect(missing.index_integrity, 'a real absence in a healthy index is not flagged').toBeUndefined();
    expect(schedule).not.toHaveBeenCalled();

    fs.appendFileSync(path.join(repo, EDITED_FILE), '// one-line edit\n');
    gitnexus('analyze', '--index-only', '.');
    const damaged = damagedRows();
    expect(damaged, `${ANALYZER} no longer corrupts: this test and the detector can be retired`).toBeGreaterThan(0);

    const now = new Set(functionIds().keys());
    const names = [...healthy.values()];
    const lost = [...healthy].find(([id, name]) =>
      !now.has(id) && !id.includes(EDITED_FILE) && /^[A-Za-z_]\w+$/.test(name) && names.filter((n) => n === name).length === 1);
    expect(lost, 'a symbol of an unedited file lost its row').toBeTruthy();
    const name = lost![1];

    const corrupt = payloadOf(await context(name));
    expect(corrupt.error).toBe(`Symbol '${name}' not found`);
    // The count itself is not stable across readers of a corrupt index (seen:
    // 9291 from the CLI, 8299 from the MCP child), so only its sign is asserted.
    // The detector's cypher check fails open: without this list, a child failure
    // there would read as the detector not flagging.
    expect(corrupt.index_integrity, `child call failures so far: ${JSON.stringify(child.failures)}`).toMatchObject({ corrupt: true, rebuild: { started: true } });
    expect((corrupt.index_integrity as { damaged_rows: number }).damaged_rows).toBeGreaterThan(0);
    expect(corrupt.confidence).toBe('LOW');
    expect(schedule).toHaveBeenCalledWith(repo);

    schedule.mockClear();
    gitnexus('analyze', '--index-only', '--force', '.');
    expect(damagedRows(), '--force repairs the index').toBe(0);
    expect(payloadOf(await context(name)).status).toBe('found');
    expect(schedule).not.toHaveBeenCalled();
  }, 1_200_000);
});
