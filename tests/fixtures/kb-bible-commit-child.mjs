// Child process for tests/knowledge/kb-bible-cross-process.test.ts: a second
// (third, ...) server process acting on one bible. Runs the BUILT server code
// (dist/), so `npm run build` must have run. KB location comes from
// APRA_FLEET_DATA_DIR, which the parent points into its sandbox.
//
// Modes (each prints one JSON line on stdout):
//   setup <repo> <srcRel>          capture + promote a CONFIRMED entry citing srcRel -> {id}
//   commit <repo> <id> <startAtMs> wait until startAtMs, then kb_bible_commit {ids:[id]} -> result
//   hold <biblePath>               take the bible lock and never release it -> {held: pid}
//
// ASCII only.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '..', '..', 'dist');
const load = (rel) => import(pathToFileURL(path.join(dist, rel)).href);

const [mode, ...args] = process.argv.slice(2);

if (mode === 'setup') {
  const [repo, srcRel] = args;
  const { getKbProviders } = await load('services/knowledge/kb-providers.js');
  const { project } = await getKbProviders(repo);
  const name = path.basename(srcRel, '.ts');
  const { id } = await project.capture({
    type: 'knowledge', title: name + ' is a constant', summary: name + ' is a plain exported constant.',
    content: name + ' is a plain exported constant.', source_files: [srcRel], symbols: [name],
    tags: [], content_hash: '', content_hash_type: 'sha256', flagged_for_review: false,
    author: 'test-agent', source: 'doer', confidence: 'INFERRED',
  });
  await project.promote(id, 'test fixture: verified');
  await project.promote(id, 'test fixture: verified');
  process.stdout.write(JSON.stringify({ id }) + '\n');
  process.exit(0);
} else if (mode === 'commit') {
  const [repo, id, startAt] = args;
  const { kbBibleCommit } = await load('tools/kb-bible-commit.js');
  const wait = Number(startAt) - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  const out = await kbBibleCommit({ ids: [id], baseBranch: 'main', baseCommit: 'a'.repeat(40) }, { folder: repo });
  process.stdout.write(out + '\n');
  process.exit(0);
} else if (mode === 'hold') {
  const [biblePath] = args;
  const { withBibleFileLock } = await load('services/knowledge/bible-file-lock.js');
  void withBibleFileLock(biblePath, () => new Promise(() => {
    process.stdout.write(JSON.stringify({ held: process.pid }) + '\n');
  }));
  setInterval(() => {}, 1000);
} else {
  process.stderr.write('unknown mode: ' + mode + '\n');
  process.exit(2);
}
