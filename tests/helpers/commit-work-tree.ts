import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// The bible admission predicate (kb_export scope=project, kb_bible_commit)
// compares stored bases with file content at the work tree's HEAD commit, not
// the files on disk. Fixtures that write or edit cited files therefore commit
// them before calling either tool; this does that with a throwaway identity and
// no signing, initialising the repo first when the folder is not one yet.
export function commitWorkTree(dir: string, message = 'fixture'): void {
  const run = (args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (!fs.existsSync(path.join(dir, '.git'))) run(['init', '--quiet']);
  run(['add', '-A']);
  run(['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false',
    'commit', '--quiet', '--allow-empty', '--no-verify', '-m', message]);
}
