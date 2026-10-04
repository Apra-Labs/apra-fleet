#!/usr/bin/env node
/**
 * check-bd-env-strip.mjs -- guards the BEADS_DIR leak fixed in
 * my-beads-db-qy8.9 (and its follow-ups) from silently coming back.
 *
 * `bd` resolves BEADS_DIR before it ever looks at cwd. On a host that
 * exports BEADS_DIR globally (this host does), any test harness that spawns
 * the real `bd` CLI into a scratch/tempdir/toy-repo clone WITHOUT stripping
 * BEADS_DIR from the child env silently hits the operator's own ambient
 * beads workspace instead of the scratch dir the test built -- this already
 * rewrote a real beads remote twice via the f34 test before my-beads-db-qy8.9
 * fixed every site-by-site occurrence found at the time. Nothing stopped the
 * NEXT contributor from adding one more unstripped real-`bd` spawn -- this
 * scanner closes that gap mechanically.
 *
 * What it scans: every real `bd`-invocation call site under the test file
 * set (SCAN_ROOTS below) --
 *   - `exec`/`execSync`/`execFile`/`execFileSync`/`spawn`/`spawnSync` whose
 *     first argument is the literal string `'bd'` (argv-style callee) or a
 *     literal command string/template starting with `bd ` or exactly `bd`
 *     (shell-string-style callee, e.g. `exec('bd dolt pull', ...)`).
 *   - `execBdSync`/`execBdAsync` call sites (scripts/lib/exec-bd.mjs's shared
 *     helper) -- these are ALWAYS real bd invocations, since that is the
 *     helper's entire purpose.
 * A call site is matched ONLY when the command/first-arg is a literal (a
 * variable holding a dynamically-built command string, e.g. bd-replay.mjs's
 * `exec(cmd, ...)`, cannot be judged by static analysis and is left alone --
 * those call sites must instead be reviewed by hand, same as this scanner's
 * own author had to).
 *
 * What it requires: the call's options object must carry an `env:` entry
 * whose value is provably BEADS_DIR-safe -- either a call to a `bdChildEnv()`
 * helper (any function literally named that; several call sites each define
 * their own local copy, see tests/helpers/bd-child-env.ts,
 * packages/apra-fleet-se/test/helpers/bd-replay.mjs, and the ad hoc
 * per-file copies in packages/apra-fleet-se/apra-pm/e2e/*.mjs) or an inline
 * `delete <x>.BEADS_DIR` in the same expression. No `env:` key at all (child
 * inherits process.env verbatim) or an `env:` value this scanner cannot
 * trace to one of those two shapes both fail.
 *
 * This is a plain-text/regex-adjacent scanner (balanced-bracket aware, not a
 * real JS parser) in the same spirit as
 * packages/apra-fleet-se/scripts/check-generic-boundary.mjs -- a mechanical
 * net, not a proof. A finding that is a deliberate, reviewed exception needs
 * BOTH a `BD-ENV-STRIP-EXCEPTION:` anchor comment next to the call AND a
 * matching ALLOWED_EXCEPTIONS entry below (see formatReport()).
 *
 * Run directly:
 *   node scripts/check-bd-env-strip.mjs
 * Exit code 1 on any undeclared finding.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build', '.gitnexus', 'fixtures']);
const SCANNABLE_EXT = new Set(['.ts', '.mjs', '.cjs', '.js']);

/** Function names whose first argument is checked for a literal 'bd' shape. */
const ARGV_STYLE_CALLEES = new Set(['execFile', 'execFileSync', 'spawn', 'spawnSync']);
/** Function names that take a single shell command string as their first argument. */
const SHELL_STYLE_CALLEES = new Set(['exec', 'execSync']);
/** Always a real bd invocation -- that is this helper's entire purpose. */
const ALWAYS_BD_CALLEES = new Set(['execBdSync', 'execBdAsync']);

const CALL_RE = new RegExp(
    `(?<![.\\w$])(${[...ARGV_STYLE_CALLEES, ...SHELL_STYLE_CALLEES, ...ALWAYS_BD_CALLEES].join('|')})\\s*\\(`,
    'g'
);

/**
 * Discover every `packages/<pkg>/test` dir (the generic "packages/**\/test"
 * half of the scanned set) plus the two static roots. Dynamic discovery
 * (rather than a hardcoded per-package list) means a new package's test dir
 * is covered automatically.
 */
export function discoverPackageTestDirs(repoRoot = REPO_ROOT) {
    const pkgsDir = path.join(repoRoot, 'packages');
    if (!fs.existsSync(pkgsDir)) return [];
    const dirs = [];
    for (const name of fs.readdirSync(pkgsDir)) {
        const testDir = path.join(pkgsDir, name, 'test');
        if (fs.existsSync(testDir) && fs.statSync(testDir).isDirectory()) {
            dirs.push(path.relative(repoRoot, testDir).split(path.sep).join('/'));
        }
    }
    return dirs.sort();
}

export function scanRoots(repoRoot = REPO_ROOT) {
    return ['tests', ...discoverPackageTestDirs(repoRoot), 'packages/apra-fleet-se/apra-pm/e2e'];
}

/** Enumerate scannable files (relative, forward-slash) under the given roots. */
export function listScannableFiles(repoRoot = REPO_ROOT, roots = scanRoots(repoRoot)) {
    const files = [];
    const walk = (abs) => {
        let stat;
        try { stat = fs.statSync(abs); } catch { return; }
        if (stat.isDirectory()) {
            if (SKIP_DIR_NAMES.has(path.basename(abs))) return;
            for (const entry of fs.readdirSync(abs)) walk(path.join(abs, entry));
            return;
        }
        if (SCANNABLE_EXT.has(path.extname(abs))) files.push(abs);
    };
    for (const root of roots) walk(path.join(repoRoot, root));
    return files
        .map((abs) => ({ abs, rel: path.relative(repoRoot, abs).split(path.sep).join('/') }))
        .sort((a, b) => a.rel.localeCompare(b.rel));
}

// ---------------------------------------------------------------------------
// Minimal source scanning helpers (balanced-bracket aware, string/template
// literal aware; NOT a real JS parser -- see module doc for the tradeoff).
// ---------------------------------------------------------------------------

/** Replace every comment with whitespace (newlines preserved), leaving string/template literal content untouched so line numbers stay aligned. */
export function maskComments(src) {
    const n = src.length;
    let out = '';
    let i = 0;
    while (i < n) {
        const c = src[i];
        const c2 = i + 1 < n ? src[i + 1] : '';
        if (c === '/' && c2 === '/') {
            while (i < n && src[i] !== '\n') { out += ' '; i += 1; }
            continue;
        }
        if (c === '/' && c2 === '*') {
            out += '  '; i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { out += src[i] === '\n' ? '\n' : ' '; i += 1; }
            if (i < n) { out += '  '; i += 2; }
            continue;
        }
        if (c === '\'' || c === '"') {
            const quote = c;
            out += c; i += 1;
            while (i < n) {
                if (src[i] === '\\' && i + 1 < n) { out += src[i] + src[i + 1]; i += 2; continue; }
                out += src[i];
                const closed = src[i] === quote;
                i += 1;
                if (closed || src[i - 1] === '\n') break;
            }
            continue;
        }
        if (c === '`') {
            out += c; i += 1;
            let depth = 0;
            while (i < n) {
                if (src[i] === '\\' && i + 1 < n) { out += src[i] + src[i + 1]; i += 2; continue; }
                if (src[i] === '`' && depth === 0) { out += src[i]; i += 1; break; }
                if (src[i] === '$' && src[i + 1] === '{') { depth += 1; out += '${'; i += 2; continue; }
                if (src[i] === '}' && depth > 0) { depth -= 1; out += '}'; i += 1; continue; }
                out += src[i]; i += 1;
            }
            continue;
        }
        out += c;
        i += 1;
    }
    return out;
}

/** Given the index of an opening bracket, return the index of its match (string/template aware). */
function findMatchingClose(src, openIdx) {
    let depth = 0;
    let i = openIdx;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (c === '\'' || c === '"') {
            const q = c; i += 1;
            while (i < n) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === q) { i += 1; break; }
                i += 1;
            }
            continue;
        }
        if (c === '`') {
            i += 1;
            let depth2 = 0;
            while (i < n) {
                if (src[i] === '\\') { i += 2; continue; }
                if (src[i] === '`' && depth2 === 0) { i += 1; break; }
                if (src[i] === '$' && src[i + 1] === '{') { depth2 += 1; i += 2; continue; }
                if (src[i] === '}' && depth2 > 0) { depth2 -= 1; i += 1; continue; }
                i += 1;
            }
            continue;
        }
        if (c === '(' || c === '[' || c === '{') depth += 1;
        else if (c === ')' || c === ']' || c === '}') {
            depth -= 1;
            if (depth === 0) return i;
        }
        i += 1;
    }
    return -1;
}

/** Split a call's argument text into top-level (depth-0) argument strings. */
function splitTopLevelArgs(text) {
    const args = [];
    let depth = 0;
    let cur = '';
    let i = 0;
    const n = text.length;
    while (i < n) {
        const c = text[i];
        if (c === '\'' || c === '"') {
            const q = c;
            cur += c; i += 1;
            while (i < n) {
                if (text[i] === '\\') { cur += text[i] + (text[i + 1] ?? ''); i += 2; continue; }
                cur += text[i];
                const closed = text[i] === q;
                i += 1;
                if (closed) break;
            }
            continue;
        }
        if (c === '`') {
            cur += c; i += 1;
            let d = 0;
            while (i < n) {
                if (text[i] === '\\') { cur += text[i] + (text[i + 1] ?? ''); i += 2; continue; }
                if (text[i] === '`' && d === 0) { cur += text[i]; i += 1; break; }
                if (text[i] === '$' && text[i + 1] === '{') { d += 1; cur += '${'; i += 2; continue; }
                if (text[i] === '}' && d > 0) { d -= 1; cur += '}'; i += 1; continue; }
                cur += text[i]; i += 1;
            }
            continue;
        }
        if (c === '(' || c === '[' || c === '{') { depth += 1; cur += c; i += 1; continue; }
        if (c === ')' || c === ']' || c === '}') { depth -= 1; cur += c; i += 1; continue; }
        if (c === ',' && depth === 0) { args.push(cur); cur = ''; i += 1; continue; }
        cur += c; i += 1;
    }
    if (cur.trim() !== '') args.push(cur);
    return args.map((a) => a.trim());
}

/** `'bd'` / `"bd"` / `` `bd` `` (whole literal, no interpolation) -> 'bd'; anything else -> null. */
function literalStringValue(argText) {
    // Strip a trailing TypeScript cast (`'not-an-array' as never`) so the
    // quote-boundary check below still recognizes the literal underneath.
    const t = argText.trim().replace(/\s+as\s+[A-Za-z_$][\w$.<>[\], ]*$/, '').trim();
    if (t.length < 2) return null;
    const quote = t[0];
    if ((quote === '\'' || quote === '"' || quote === '`') && t[t.length - 1] === quote) {
        const inner = t.slice(1, -1);
        if (quote === '`' && inner.includes('${')) return null; // interpolated -- not a static literal
        return inner;
    }
    return null;
}

function isBdInvocation(calleeName, args) {
    if (ALWAYS_BD_CALLEES.has(calleeName)) {
        const first = args[0] ?? '';
        // execBdSync(args, options, execFileSyncImpl, ...) / execBdAsync(args,
        // options, execFileAsyncImpl, ...): a 3rd positional argument is an
        // INJECTED test double standing in for the real execFileSync/execFile
        // -- no real child process, and therefore no real env, is ever
        // involved. Only the default-impl (2-arg) call shape is a real spawn.
        if (args.length >= 3) return false;
        // Both helpers' first line is `if (!Array.isArray(args)) throw new
        // TypeError(...)` -- a plain string literal passed as `args` (e.g. the
        // "not-an-array" defensive-guard tests) throws before any subprocess
        // is ever touched, so it carries no env-leak risk either.
        if (literalStringValue(first) != null) return false;
        return true;
    }
    const first = args[0] ?? '';
    const inner = literalStringValue(first);
    if (inner == null) return false;
    if (ARGV_STYLE_CALLEES.has(calleeName)) return inner.trim() === 'bd';
    if (SHELL_STYLE_CALLEES.has(calleeName)) return /^\s*bd(\s|$)/.test(inner);
    return false;
}

/** Extract the depth-1 value text of `key:` (or the bare shorthand `key`) from an object-literal's inner text. Returns null if absent. */
function extractObjectKeyValue(objLiteralText, keyName) {
    const inner = objLiteralText.slice(1, -1); // strip { }
    let i = 0;
    const n = inner.length;
    while (i < n) {
        while (i < n && /\s/.test(inner[i])) i += 1;
        if (i >= n) break;
        const entryStart = i;
        let d = 0;
        let j = i;
        while (j < n) {
            const c = inner[j];
            if (c === '\'' || c === '"') {
                const q = c; j += 1;
                while (j < n) { if (inner[j] === '\\') { j += 2; continue; } if (inner[j] === q) { j += 1; break; } j += 1; }
                continue;
            }
            if (c === '`') {
                j += 1; let td = 0;
                while (j < n) {
                    if (inner[j] === '\\') { j += 2; continue; }
                    if (inner[j] === '`' && td === 0) { j += 1; break; }
                    if (inner[j] === '$' && inner[j + 1] === '{') { td += 1; j += 2; continue; }
                    if (inner[j] === '}' && td > 0) { td -= 1; j += 1; continue; }
                    j += 1;
                }
                continue;
            }
            if (c === '(' || c === '[' || c === '{') { d += 1; j += 1; continue; }
            if (c === ')' || c === ']' || c === '}') { d -= 1; j += 1; continue; }
            if (c === ',' && d === 0) break;
            j += 1;
        }
        const entry = inner.slice(entryStart, j).trim();
        if (entry === keyName) return keyName; // shorthand { env } -- value is the identifier itself
        const m = entry.match(/^(['"]?)([A-Za-z_$][\w$]*)\1\s*:([\s\S]*)$/);
        if (m && m[2] === keyName) return m[3].trim();
        i = j + 1;
    }
    return null;
}

function resolveIdentifierObjectLiteral(name, src) {
    const re = new RegExp(`(?:const|let|var)\\s+${name}\\b[^=]*=\\s*\\{`);
    const m = re.exec(src);
    if (!m) return null;
    const openIdx = m.index + m[0].length - 1;
    const closeIdx = findMatchingClose(src, openIdx);
    if (closeIdx === -1) return null;
    return src.slice(openIdx, closeIdx + 1);
}

/** Does this env-value expression provably strip BEADS_DIR? */
function isSafeEnvExpr(exprText, maskedSrc) {
    if (/bdChildEnv\s*\(/.test(exprText)) return true;
    if (/\bdelete\b[^;]*\bBEADS_DIR\b/.test(exprText)) return true;
    const idMatch = exprText.trim().match(/^[A-Za-z_$][\w$]*$/);
    if (idMatch) {
        const name = idMatch[0];
        const declRe = new RegExp(`(?:const|let|var)\\s+${name}\\b\\s*(?::[^=]+)?=\\s*([^;]+);`);
        const m = maskedSrc.match(declRe);
        if (m && (/bdChildEnv\s*\(/.test(m[1]) || /\bdelete\b[^;]*\bBEADS_DIR\b/.test(m[1]))) return true;
    }
    return false;
}

/**
 * @param {string} rel
 * @param {string} content
 * @returns {Array<{file:string, line:number, callee:string, excerpt:string, reason:string}>}
 */
export function scanFile(rel, content) {
    const masked = maskComments(content);
    const findings = [];
    CALL_RE.lastIndex = 0;
    let m;
    while ((m = CALL_RE.exec(masked)) !== null) {
        const calleeName = m[1];
        const openIdx = m.index + m[0].length - 1;
        const closeIdx = findMatchingClose(masked, openIdx);
        if (closeIdx === -1) continue;
        const argsText = masked.slice(openIdx + 1, closeIdx);
        const args = splitTopLevelArgs(argsText);
        if (!isBdInvocation(calleeName, args)) continue;

        const line = masked.slice(0, m.index).split('\n').length;
        const excerpt = masked.slice(m.index, Math.min(closeIdx + 1, m.index + 160)).replace(/\s+/g, ' ').trim();

        let optObjText = null;
        for (let k = 1; k < args.length; k += 1) {
            if (/^\{/.test(args[k])) { optObjText = args[k]; break; }
        }

        let safe = false;
        let reason;
        if (optObjText) {
            const envVal = extractObjectKeyValue(optObjText, 'env');
            if (envVal == null) {
                reason = 'options object has no env: key -- child inherits process.env (and BEADS_DIR) verbatim';
            } else if (isSafeEnvExpr(envVal, masked)) {
                safe = true;
            } else {
                reason = `env: value "${envVal.slice(0, 80)}" does not resolve to a bdChildEnv() call or an inline "delete ...BEADS_DIR"`;
            }
        } else {
            const identArg = args.slice(1).find((a) => /^[A-Za-z_$][\w$]*$/.test(a));
            if (identArg) {
                const resolved = resolveIdentifierObjectLiteral(identArg, masked);
                const envVal = resolved ? extractObjectKeyValue(resolved, 'env') : null;
                if (envVal != null && isSafeEnvExpr(envVal, masked)) {
                    safe = true;
                } else {
                    reason = `options argument "${identArg}" could not be resolved to an inline object literal with a BEADS_DIR-safe env:`;
                }
            } else {
                reason = 'no options object passed at all -- child inherits process.env (and BEADS_DIR) verbatim';
            }
        }

        if (!safe) {
            findings.push({ file: rel, line, callee: calleeName, excerpt, reason });
        }
    }
    return findings;
}

export function scanFiles(files) {
    const contentsByRel = {};
    const findings = [];
    for (const f of files) {
        const src = fs.readFileSync(f.abs, 'utf8');
        contentsByRel[f.rel] = src;
        findings.push(...scanFile(f.rel, src));
    }
    return { findings, contentsByRel };
}

// ---------------------------------------------------------------------------
// Deliberate exceptions
// ---------------------------------------------------------------------------

/**
 * A finding here only ever needs an entry if a real bd spawn genuinely
 * cannot strip BEADS_DIR (none are known at the time of writing -- every
 * current call site either already uses bdChildEnv() or is a dynamic
 * (non-literal) command this scanner does not flag in the first place).
 * An exception needs BOTH an entry here AND a `BD-ENV-STRIP-EXCEPTION:`
 * anchor comment within `window` lines of the call site, stating the
 * reason -- so the exception is reviewed in the diff, same convention as
 * packages/apra-fleet-se/scripts/check-generic-boundary.mjs's
 * ALLOWED_EXCEPTIONS.
 */
export const ALLOWED_EXCEPTIONS = [];

export const ANCHOR_RE = /BD-ENV-STRIP-EXCEPTION:/;

export function applyExceptions(findings, contentsByRel, exceptions = ALLOWED_EXCEPTIONS) {
    const resolved = exceptions.map((ex) => {
        const content = contentsByRel[ex.file];
        if (!content) throw new Error(`ALLOWED_EXCEPTIONS entry "${ex.name}" names a file not in the scanned set: ${ex.file}`);
        const lines = content.split('\n');
        const idx = lines.findIndex((l) => ANCHOR_RE.test(l));
        if (idx === -1) throw new Error(`ALLOWED_EXCEPTIONS entry "${ex.name}" has no BD-ENV-STRIP-EXCEPTION anchor comment in ${ex.file}`);
        return { ...ex, anchorLine: idx + 1, hits: 0 };
    });
    const violations = [];
    for (const f of findings) {
        const cover = resolved.find((ex) => ex.file === f.file && Math.abs(ex.anchorLine - f.line) <= (ex.window ?? 6));
        if (cover) cover.hits += 1;
        else violations.push(f);
    }
    const stale = resolved.filter((ex) => ex.hits === 0).map((ex) => ex.name);
    return { violations, stale };
}

export function formatFinding(f) {
    return [
        `${f.file}:${f.line}  [${f.callee}]  ${f.excerpt}`,
        `    reason: ${f.reason}`,
    ].join('\n');
}

export function formatReport(violations, stale = []) {
    const parts = [];
    if (violations.length) {
        parts.push(
            `BD-ENV-STRIP: ${violations.length} real 'bd' child-process spawn(s) found that do not provably strip BEADS_DIR from their env.`,
            'Fix: pass `env: bdChildEnv()` (see tests/helpers/bd-child-env.ts) in the options object, or an inline `delete <env>.BEADS_DIR`.',
            '',
            ...violations.map(formatFinding),
            '',
            'Deliberate exception? It takes two visible edits: a `BD-ENV-STRIP-EXCEPTION: <reason>` comment beside the call',
            'AND a matching ALLOWED_EXCEPTIONS entry in scripts/check-bd-env-strip.mjs, so the exception is reviewed in the diff.',
        );
    }
    if (stale.length) {
        parts.push(`Stale ALLOWED_EXCEPTIONS (cover no finding any more -- remove them): ${stale.join(', ')}`);
    }
    return parts.join('\n');
}

export function runScan(repoRoot = REPO_ROOT) {
    const files = listScannableFiles(repoRoot);
    const { findings, contentsByRel } = scanFiles(files);
    const { violations, stale } = applyExceptions(findings, contentsByRel);
    return { files, findings, violations, stale };
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const result = runScan();
    console.log(`Scanned ${result.files.length} file(s) under ${scanRoots().join(', ')}.`);
    if (result.violations.length || result.stale.length) {
        console.log(formatReport(result.violations, result.stale));
        process.exit(1);
    }
    console.log('OK: every real bd child-process spawn provably strips BEADS_DIR.');
}
