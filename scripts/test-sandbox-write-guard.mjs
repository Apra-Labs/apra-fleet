// Write guard for the test sandbox (scripts/test-sandbox.mjs): inside a sandboxed
// process, a node:fs write into a protected dir throws E-TEST-SANDBOX-WRITE and is
// recorded. Protected: the git dir shared by the checkout the run started in (its
// hooks, config, info/exclude) and the real profile's fleet and tool dirs.
//
// Why: a kb_setup test with no folder fell back to process.cwd() and installed a
// real post-commit hook into the shared hooks folder of the developer's clone.
//
// Recorded, not only thrown, because product code may catch the error (a
// best-effort hook install): tests/setup.ts fails the test in afterEach. A
// violation in a child node process goes to <sandbox root>/write-guard.log,
// which tests/setup.ts reads too. A non-node child (git itself) is not covered.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';

export const PROTECTED_DIRS_ENV = 'APRA_TEST_PROTECTED_DIRS';
export const WRITE_GUARD_CODE = 'E-TEST-SANDBOX-WRITE';
const STATE = Symbol.for('apra-fleet.test-sandbox-write-guard');

function norm(p) {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
}

function toPath(p) {
    if (typeof p === 'string') return p;
    if (p instanceof URL) return p.protocol === 'file:' ? fileURLToPath(p) : null;
    if (Buffer.isBuffer(p)) return p.toString();
    return null; // a file descriptor: already opened, checked at open
}

/** The protected dir `p` is in, or null. */
export function protectedDirOf(p, dirs) {
    const s = toPath(p);
    if (s === null) return null;
    const n = norm(s);
    for (const d of dirs) {
        const nd = norm(d);
        if (n === nd || n.startsWith(nd.endsWith(path.sep) ? nd : nd + path.sep)) return d;
    }
    return null;
}

function logPath(env) {
    const root = env.APRA_TEST_SANDBOX_ROOT;
    return root ? path.join(root, 'write-guard.log') : null;
}

const WRITE_FLAGS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND;
function opensForWrite(flags) {
    if (flags === undefined || flags === null) return false;
    if (typeof flags === 'number') return (flags & WRITE_FLAGS) !== 0;
    return /[wa+]/.test(String(flags));
}

// [name, which path arguments to check, when the call writes]
const GUARDED = [
    ['writeFile', [0]], ['appendFile', [0]], ['mkdir', [0]], ['mkdtemp', [0]], ['copyFile', [1]], ['cp', [1]],
    ['rename', [0, 1]], ['rm', [0]], ['rmdir', [0]], ['unlink', [0]], ['chmod', [0]], ['chown', [0]],
    ['symlink', [1]], ['link', [1]], ['truncate', [0]], ['utimes', [0]],
    ['open', [0], (args) => opensForWrite(args[1])],
];

/**
 * Patch node:fs (sync, callback and promise forms, and the ESM named exports)
 * in this process. Idempotent. No-op when no protected dir is set.
 * @param {Record<string, string|undefined>} [env]
 */
export function installWriteGuard(env = process.env) {
    if (globalThis[STATE]) return globalThis[STATE];
    let dirs = [];
    try { dirs = JSON.parse(env[PROTECTED_DIRS_ENV] || '[]'); } catch { dirs = []; }
    const log = logPath(env);
    let logOffset = 0;
    try { logOffset = log ? fs.readFileSync(log, 'utf8').length : 0; } catch { logOffset = 0; }
    // Entries already in the log belong to earlier processes, and were reported there.
    const state = { dirs, violations: [], logOffset, log };
    globalThis[STATE] = state;
    if (dirs.length === 0) return state;
    const appendLog = fs.appendFileSync;

    const refuse = (name, target, dir) => {
        const line = `${WRITE_GUARD_CODE}: fs.${name} on ${target} (pid ${process.pid}) is inside ${dir}, outside the test sandbox`;
        state.violations.push(line);
        if (log) { try { appendLog(log, `${process.pid}\t${line}\n`); } catch { /* the throw still reports it */ } }
        const err = new Error(`[test-sandbox] ${line}. A test must write only under its own temp dirs.`);
        // Never silent, even where the error is caught and no vitest afterEach looks.
        process.stderr.write(`${err.message}\n`);
        err.code = WRITE_GUARD_CODE;
        return err;
    };
    const check = (name, idx, when, args) => {
        if (when && !when(args)) return null;
        for (const i of idx) {
            const dir = protectedDirOf(args[i], dirs);
            if (dir) return refuse(name, toPath(args[i]), dir);
        }
        return null;
    };

    for (const [name, idx, when] of GUARDED) {
        const sync = fs[`${name}Sync`];
        if (sync) {
            fs[`${name}Sync`] = function (...args) {
                const err = check(`${name}Sync`, idx, when, args);
                if (err) throw err;
                return sync.apply(this, args);
            };
        }
        const cb = fs[name];
        if (cb) {
            fs[name] = function (...args) {
                const err = check(name, idx, when, args);
                if (err) {
                    const done = args[args.length - 1];
                    if (typeof done === 'function') { process.nextTick(done, err); return undefined; }
                    throw err;
                }
                return cb.apply(this, args);
            };
        }
        const p = fs.promises[name];
        if (p) {
            fs.promises[name] = function (...args) {
                const err = check(`promises.${name}`, idx, when, args);
                if (err) return Promise.reject(err);
                return p.apply(this, args);
            };
        }
    }
    const createWriteStream = fs.createWriteStream;
    fs.createWriteStream = function (...args) {
        const err = check('createWriteStream', [0], null, args);
        if (err) throw err;
        return createWriteStream.apply(this, args);
    };
    syncBuiltinESMExports();
    return state;
}

/**
 * Violations since the last call: this process's, plus those child processes
 * logged. Each is returned once.
 */
export function takeWriteGuardViolations() {
    const state = globalThis[STATE];
    if (!state) return [];
    const out = state.violations.splice(0);
    if (state.log) {
        let text = '';
        try { text = fs.readFileSync(state.log, 'utf8'); } catch { text = ''; }
        const fresh = text.slice(state.logOffset);
        state.logOffset = text.length;
        for (const row of fresh.split('\n')) {
            const tab = row.indexOf('\t');
            if (tab > 0 && Number(row.slice(0, tab)) !== process.pid) out.push(row.slice(tab + 1));
        }
    }
    return out;
}
