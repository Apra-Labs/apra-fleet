// Test sandbox: every test process (vitest, node --test suites, and every node
// child they spawn) runs with HOME/USERPROFILE/APPDATA/LOCALAPPDATA/XDG dirs
// and APRA_FLEET_DATA_DIR pointing at a per-run temp dir, and refuses to run
// if any of them still resolves to the real user profile.
//
// Why: tests that fall back to os.homedir() (a module that computes
// ~/.apra-fleet/fleet.key at load, a spawned server or `apra-fleet start`
// child, a client probe without APRA_FLEET_DATA_DIR) silently operated on the
// developer's REAL installation: they rewrote fleet.key (invalidating member
// JWTs) and launched the installed binary. Per-test env discipline did not
// hold, so the sandbox is applied by the runners, not by individual tests.
//
// Entry points: scripts/run-all-tests.mjs (npm test), scripts/with-test-sandbox.mjs
// (package test scripts), tests/global-setup.ts (bare `npx vitest`). The
// guard (scripts/test-sandbox-guard.mjs) is preloaded into every node process
// via NODE_OPTIONS=--import.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SANDBOX_ROOT_ENV = 'APRA_TEST_SANDBOX_ROOT';
export const REAL_HOME_ENV = 'APRA_TEST_REAL_HOME';

const GUARD_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-sandbox-guard.mjs')).href;

/** Per-user dirs under the real home that tests must never touch. */
const PROTECTED = ['.apra-fleet', '.apra-fleet-se', '.fleet-tasks', '.claude', '.claude.json', '.beads', '.gemini', '.codex', '.config', '.gitconfig'];

function norm(p) {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
}

function inside(child, parent) {
    const c = norm(child);
    const p = norm(parent);
    return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/**
 * Throws when this process would touch the real user profile: os.homedir()
 * is the real home, or a fleet data/home env var resolves into a protected
 * dir of the real home. No-op outside a sandbox (no real-home marker).
 * @param {Record<string, string|undefined>} [env]
 * @param {() => string} [homedir]
 */
export function assertNotRealProfile(env = process.env, homedir = os.homedir) {
    const real = env[REAL_HOME_ENV];
    if (!real) return;
    const problems = [];
    const home = homedir();
    if (norm(home) === norm(real)) problems.push(`os.homedir() is the real home (${home})`);
    for (const k of ['HOME', 'USERPROFILE']) {
        if (env[k] && norm(env[k]) === norm(real)) problems.push(`${k} is the real home (${env[k]})`);
    }
    for (const k of ['APRA_FLEET_DATA_DIR', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
        const v = env[k];
        if (!v) continue;
        if (norm(v) === norm(real) || PROTECTED.some((d) => inside(v, path.join(real, d)))) {
            problems.push(`${k} points into the real profile (${v})`);
        }
    }
    if (problems.length) {
        throw new Error(
            `[test-sandbox] refusing to run: this test process would use the REAL user profile -- ${problems.join('; ')}. ` +
                'Tests must run inside the per-run sandbox (npm test / scripts/with-test-sandbox.mjs); ' +
                'never point HOME/USERPROFILE/APRA_FLEET_DATA_DIR back at the real home.',
        );
    }
}

/**
 * Create (or reuse, when already inside one) the per-run sandbox and point
 * `env` at it. Returns { root, created, cleanup }.
 * @param {Record<string, string|undefined>} [env] mutated in place (normally process.env)
 */
export function ensureTestSandbox(env = process.env) {
    const existing = env[SANDBOX_ROOT_ENV];
    if (existing && fs.existsSync(existing)) {
        assertNotRealProfile(env);
        return { root: existing, created: false, cleanup: () => {} };
    }
    const realHome = env[REAL_HOME_ENV] || os.homedir();
    // realpath.native expands Windows 8.3 short names (e.g. RUNNER~1 on GitHub
    // runners): $HOME-relative PowerShell (hashFilesRecursive) slices
    // Get-ChildItem's long FullName by the length of the short $HOME-based
    // prefix, so a short-name sandbox home mangles every relative path.
    const root = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'apra-fleet-test-sandbox-'));
    const home = path.join(root, 'home');
    const dirs = {
        home,
        appdata: path.join(home, 'AppData', 'Roaming'),
        localappdata: path.join(home, 'AppData', 'Local'),
        xdgConfig: path.join(home, '.config'),
        xdgData: path.join(home, '.local', 'share'),
        data: path.join(root, 'fleet-data'),
    };
    for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
    // git and other tools read identity from the home dir: give tests a
    // neutral one instead of the developer's.
    fs.writeFileSync(path.join(home, '.gitconfig'),
        '[user]\n\tname = apra-fleet test\n\temail = test@apra-fleet.invalid\n[safe]\n\tdirectory = *\n[init]\n\tdefaultBranch = main\n');

    env[REAL_HOME_ENV] = realHome;
    env[SANDBOX_ROOT_ENV] = root;
    env.HOME = home;
    env.USERPROFILE = home;
    if (process.platform === 'win32') {
        const parsed = path.parse(home);
        env.HOMEDRIVE = parsed.root.replace(/\\$/, '');
        env.HOMEPATH = home.slice(env.HOMEDRIVE.length);
    }
    env.APPDATA = dirs.appdata;
    env.LOCALAPPDATA = dirs.localappdata;
    env.XDG_CONFIG_HOME = dirs.xdgConfig;
    env.XDG_DATA_HOME = dirs.xdgData;
    env.APRA_FLEET_DATA_DIR = dirs.data;
    const opt = `--import=${GUARD_URL}`;
    if (!(env.NODE_OPTIONS || '').includes(opt)) env.NODE_OPTIONS = `${env.NODE_OPTIONS ? env.NODE_OPTIONS + ' ' : ''}${opt}`;
    assertNotRealProfile(env);
    return {
        root,
        created: true,
        cleanup: () => { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* best-effort */ } },
    };
}
