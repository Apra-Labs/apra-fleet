// BUILD_VERSION is replaced by esbuild `define` at bundle time.
// In dev (tsc), it stays as-is and we fall back to reading version.json.
import { createRequire } from 'node:module';

declare const BUILD_VERSION: string | undefined;

function resolveVersion(): string {
  // 1. Build-time injection (esbuild bundle / SEA binary)
  try {
    if (typeof BUILD_VERSION !== 'undefined') return BUILD_VERSION;
  } catch {
    // BUILD_VERSION not defined -- dev/npm mode
  }

  // 2. Resolve the package root containing version.json.
  //    fs/path/url are loaded lazily via require() rather than top-level ESM
  //    imports so that consumers which mock 'node:fs' at module scope do not
  //    perturb this module-load-time call (serverVersion is assigned eagerly).
  //    Under ESM (tsc output for npm) `require` and `__dirname` do not exist,
  //    so we build a require() from import.meta.url and derive the dir from it.
  //    Under CJS/SEA we use the bare globals so the existing path is unaffected.
  try {
    let req: NodeRequire;
    let dir: string;
    if (typeof __dirname === 'undefined') {
      // ESM path (tsc output for npm).
      req = createRequire(import.meta.url);
      const { fileURLToPath } = req('node:url');
      const { dirname } = req('node:path');
      dir = dirname(fileURLToPath(import.meta.url));
    } else {
      // CJS / SEA path. __dirname points to dist/ (tsc output).
      req = require;
      dir = __dirname;
    }

    const { readFileSync, existsSync } = req('node:fs');
    const { join } = req('node:path');

    // dist/ entry -> package root is one level up.
    const root = join(dir, '..');
    const vf = JSON.parse(readFileSync(join(root, 'version.json'), 'utf-8'));

    // 3. Dev-only git-hash suffix. npm installs ship no .git/ directory, so
    //    this naturally yields a bare semver for npm users.
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
