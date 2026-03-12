// BUILD_VERSION is replaced by esbuild `define` at bundle time.
// In dev (tsc), it stays as-is and we fall back to reading version.json.
declare const BUILD_VERSION: string | undefined;

function resolveVersion(): string {
  // 1. Build-time injection (esbuild bundle / SEA binary)
  try {
    if (typeof BUILD_VERSION !== 'undefined') return BUILD_VERSION;
  } catch {
    // BUILD_VERSION not defined — dev mode
  }

  // 2. Dev fallback — read version.json + git hash
  try {
    const { readFileSync, existsSync } = require('node:fs');
    const { dirname, join } = require('node:path');

    // In dev, __dirname points to dist/ (tsc output)
    const root = join(__dirname, '..');
    const vf = JSON.parse(readFileSync(join(root, 'version.json'), 'utf-8'));

    let hash = '';
    try {
      const headPath = join(root, '.git', 'HEAD');
      if (existsSync(headPath)) {
        const head = readFileSync(headPath, 'utf-8').trim();
        if (head.startsWith('ref: ')) {
          const refPath = join(root, '.git', head.slice(5));
          if (existsSync(refPath)) {
            hash = '_' + readFileSync(refPath, 'utf-8').trim().slice(0, 6);
          }
        } else {
          hash = '_' + head.slice(0, 6);
        }
      }
    } catch { /* no git info */ }

    return `v${vf.version}${hash}`;
  } catch {
    return 'v0.0.0-unknown';
  }
}

export const serverVersion = resolveVersion();
