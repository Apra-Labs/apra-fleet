#!/usr/bin/env node
/**
 * check-ssh2-native.mjs -- fails when ssh2's optional native crypto binding
 * (sshcrypto.node) is missing or unloadable.
 *
 * Why: `npm ci` can fail to build that optional addon silently (exit 0), and
 * ssh2 then runs on its pure-JS cipher. CI must not cache such a tree
 * (see .github/actions/node-modules-cache/action.yml), because tests that
 * pass natively can fail on the JS path.
 *
 * The logic is a pure function with an injected `resolve`/`load` so tests run
 * on any OS without touching the real node_modules.
 *
 * Run directly: node scripts/check-ssh2-native.mjs   (exit 0 ok, 1 missing)
 */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

export const BINDING_REL = path.join('lib', 'protocol', 'crypto', 'build', 'Release', 'sshcrypto.node');

/**
 * @param {{ resolve: (id: string) => string, load: (file: string) => unknown }} deps
 * @returns {{ ok: boolean, exitCode: number, bindingPath?: string, message: string }}
 */
export function checkSsh2Native({ resolve, load }) {
  let pkgJson;
  try {
    pkgJson = resolve('ssh2/package.json');
  } catch (e) {
    return fail(`could not resolve ssh2 (${errMsg(e)})`);
  }
  const bindingPath = path.join(path.dirname(pkgJson), BINDING_REL);
  try {
    const binding = load(bindingPath);
    if (!binding || typeof binding !== 'object' || !('AESGCMCipher' in binding)) {
      return fail(`${bindingPath} loaded but exports no AESGCMCipher`);
    }
  } catch (e) {
    return fail(`could not load ${bindingPath} (${errMsg(e)})`);
  }
  return { ok: true, exitCode: 0, bindingPath, message: `[OK] ssh2 native crypto binding found: ${bindingPath}` };
}

function errMsg(e) {
  return e instanceof Error ? e.message : String(e);
}

function fail(detail) {
  return {
    ok: false,
    exitCode: 1,
    message:
      `[FAIL] ssh2 native crypto binding (sshcrypto.node) is missing: ${detail}. ` +
      'ssh2 would silently fall back to its pure-JS cipher. Fix: rebuild with build tools present ' +
      '(python3, make, a C++ compiler), e.g. `npm rebuild ssh2`, then re-run `npm ci`.',
  };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const req = createRequire(path.join(process.cwd(), 'noop.js'));
  const result = checkSsh2Native({ resolve: (id) => req.resolve(id), load: (f) => req(f) });
  (result.ok ? console.log : console.error)(result.message);
  process.exit(result.exitCode);
}
