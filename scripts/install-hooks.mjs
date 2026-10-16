// Installs git hooks from .github/hooks/ into .git/hooks/.
// Runs automatically on `npm install` via the `prepare` lifecycle script.
// Works on Windows, Linux, and macOS.
import { copyFileSync, chmodSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, '.github', 'hooks');
const dst = join(root, '.git', 'hooks');

// npm runs `prepare` on `npm pack` / `npm publish` too (even with
// --ignore-scripts, npm 10). Packing must not touch the packer's git hooks --
// a test that packs the repo would otherwise write into the checkout.
if (process.env.npm_command === 'pack' || process.env.npm_command === 'publish') {
  console.log(`install-hooks: npm ${process.env.npm_command}, skipping`);
  process.exit(0);
}

if (!existsSync(dst)) {
  console.log('install-hooks: no .git/hooks directory found, skipping');
  process.exit(0);
}

for (const file of readdirSync(src)) {
  const srcFile = join(src, file);
  const dstFile = join(dst, file);
  copyFileSync(srcFile, dstFile);
  try { chmodSync(dstFile, 0o755); } catch { /* Windows: chmod is a no-op, Git Bash handles it */ }
  console.log(`install-hooks: installed ${file}`);
}
