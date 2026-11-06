// A REAL 0.4.4 build of the KB SqliteProvider, for rollback tests.
//
// How it is located: the source comes from the git tag v0.4.4 of THIS
// repository (`git archive v0.4.4 src`), extracted under the caller's sandbox
// directory and bundled with esbuild (a root devDependency) into one ESM file
// whose npm imports resolve from this checkout's node_modules. This is
// reproducible offline once the tag has been fetched (`git fetch --tags`), and
// takes well under a second, so it runs inside `npm test`.
//
// The bundle is driven through a small runner script in a CHILD node process
// (as a rolled-back install would be: a separate process with its own module
// state). Each call runs a list of operations and returns their results.
//
// When the tag (or git, or esbuild) is not available, buildV044Kb returns
// { ok: false, reason } and the caller must SKIP LOUDLY with that reason.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const V044_TAG = 'v0.4.4';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export type V044Op =
  | { op: 'query'; query: string }
  | { op: 'list' }
  | { op: 'capture'; title: string; summary: string; content: string };

export type V044Result =
  | { op: 'query'; ids: string[] }
  | { op: 'list'; ids: string[] }
  | { op: 'capture'; id: string; decision: string }
  | { op: string; error: string };

export interface V044Kb {
  ok: true;
  bundle: string;
  /** Open dbFile with the 0.4.4 SqliteProvider in a child process and run ops in order. */
  run(dbFile: string, repoPath: string, ops: V044Op[]): V044Result[];
}

const RUNNER = `
import { SqliteProvider } from './v044-sqlite-provider.mjs';
const [dbFile, repoPath, opsJson] = process.argv.slice(2);
const ALL = ['CONFIRMED', 'INFERRED', 'UNVERIFIED'];
const p = new SqliteProvider(dbFile, repoPath);
await p.init();
const out = [];
for (const o of JSON.parse(opsJson)) {
  try {
    if (o.op === 'query') {
      const r = await p.query({ query: o.query, confidence: ALL, limit: 1000 });
      out.push({ op: o.op, ids: r.results.map(e => e.id) });
    } else if (o.op === 'list') {
      const r = await p.list({ confidence: ALL, limit: 1000 });
      out.push({ op: o.op, ids: r.map(e => e.id) });
    } else if (o.op === 'capture') {
      const r = await p.capture({
        type: 'knowledge', title: o.title, summary: o.summary, content: o.content,
        source_files: ['src/a.ts'], symbols: [], tags: [], content_hash: '', content_hash_type: 'sha256',
        flagged_for_review: false, author: 'v044-rollback-test', source: 'doer', confidence: 'INFERRED',
      });
      out.push({ op: o.op, id: r.id, decision: r.audn_decision });
    }
  } catch (err) {
    out.push({ op: o.op, error: String(err && err.message || err) });
  }
}
p.close();
process.stdout.write('V044_RESULT ' + JSON.stringify(out) + '\\n');
`;

export async function buildV044Kb(sandboxDir: string): Promise<V044Kb | { ok: false; reason: string }> {
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '-q', '--verify', `refs/tags/${V044_TAG}^{commit}`], { stdio: 'pipe' });
  } catch {
    return { ok: false, reason: `git tag ${V044_TAG} is not available in ${REPO_ROOT} (run: git fetch --tags)` };
  }
  const dir = path.join(sandboxDir, 'v044-build');
  fs.mkdirSync(dir, { recursive: true });
  const tarFile = path.join(dir, 'src.tar');
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'archive', '-o', tarFile, V044_TAG, 'src'], { stdio: 'pipe' });
    // A relative name: GNU tar reads 'C:\...' as a remote host:path.
    execFileSync('tar', ['-xf', path.basename(tarFile)], { cwd: dir, stdio: 'pipe' });
  } catch (err) {
    return { ok: false, reason: `could not extract ${V044_TAG} sources: ${(err as Error).message}` };
  }
  const bundle = path.join(dir, 'v044-sqlite-provider.mjs');
  try {
    const esbuild = await import('esbuild');
    await esbuild.build({
      entryPoints: [path.join(dir, 'src', 'services', 'knowledge', 'sqlite-provider.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      outfile: bundle,
      nodePaths: [path.join(REPO_ROOT, 'node_modules')],
      logLevel: 'silent',
      banner: { js: "import { createRequire as __v044cr } from 'node:module'; const require = __v044cr(import.meta.url);" },
    });
  } catch (err) {
    return { ok: false, reason: `could not bundle the ${V044_TAG} SqliteProvider with esbuild: ${(err as Error).message}` };
  }
  const runner = path.join(dir, 'run.mjs');
  fs.writeFileSync(runner, RUNNER);
  return {
    ok: true,
    bundle,
    run(dbFile, repoPath, ops) {
      const stdout = execFileSync(process.execPath, ['--no-warnings', runner, dbFile, repoPath, JSON.stringify(ops)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60_000,
      });
      const line = stdout.split('\n').find(l => l.startsWith('V044_RESULT '));
      if (!line) throw new Error(`0.4.4 runner printed no result:\n${stdout}`);
      return JSON.parse(line.slice('V044_RESULT '.length)) as V044Result[];
    },
  };
}
