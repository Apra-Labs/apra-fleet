import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const versionFile = JSON.parse(readFileSync(join(__dirname, '..', 'version.json'), 'utf-8'));

function getGitHash(): string | null {
  try {
    const repoRoot = join(__dirname, '..');
    const headPath = join(repoRoot, '.git', 'HEAD');
    if (!existsSync(headPath)) return null;
    const head = readFileSync(headPath, 'utf-8').trim();
    if (head.startsWith('ref: ')) {
      const refPath = join(repoRoot, '.git', head.slice(5));
      if (!existsSync(refPath)) return null;
      return readFileSync(refPath, 'utf-8').trim().slice(0, 6);
    }
    return head.slice(0, 6);
  } catch {
    return null;
  }
}

const gitHash = getGitHash();

export const serverVersion = gitHash ? `v${versionFile.version}_${gitHash}` : `v${versionFile.version}`;
