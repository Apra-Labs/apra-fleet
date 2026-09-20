#!/usr/bin/env node
/**
 * check-secret-terminology.mjs -- guards the "secret" vs "secure" terminology
 * standardization (chore/secret-terminology).
 *
 * The concept "secret variable" (a named value in the credential store,
 * injected into commands at execution time) has exactly one canonical name
 * going forward: "secret". The canonical placeholder is {{secret.NAME}}; the
 * legacy {{secure.NAME}} spelling still resolves (with a deprecation
 * warning) but must never be the one new text recommends. Reason codes are
 * secret_variable_not_found / secret_variable_denied / secret_variable_expired
 * with no legacy alias at all.
 *
 * This scanner is plain-text (no JS tokenizer): it flags any file, anywhere
 * in the scanned set, that still contains:
 *   - the literal token spelling `{{secure.`
 *   - the retired reason-code prefix `secure_credential_`
 *   - the phrases "secure variable" or "secure credential" (case-insensitive)
 *
 * Allowlisted (legacy-acceptance code / historical text, never flagged):
 *   - src/services/secret-token.ts (the shared module -- it MUST mention
 *     {{secure.NAME}} to document/implement the legacy spelling)
 *   - the mirrored block in packages/apra-fleet-se/fleet-sprint/contracts.mjs
 *   - tests/** and packages/**\/test/** (legacy-resolution test fixtures)
 *   - CHANGELOG.md (historical record)
 *   - docs/**\/adr-*.md (historical decision records)
 *   - any line containing the word "deprecated" (that IS the sanctioned
 *     mention of the legacy spelling)
 *
 * Run directly:
 *   node scripts/check-secret-terminology.mjs
 * Exit code 1 on any hit, printing file:line for each.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');

/** Directories/globs (relative to REPO_ROOT) scanned for stale terminology. */
export const SCAN_ROOTS = [
    'docs',
    'skills',
    'packages',
    'src',
    'README.md',
    'SECURITY.md',
];

const SKIP_DIR_NAMES = new Set(['node_modules', '.git', 'dist', 'build', '.gitnexus']);

/** File extensions worth scanning -- text/docs/source only. */
const SCANNABLE_EXT = new Set(['.md', '.ts', '.mjs', '.cjs', '.js', '.html']);

export const PATTERNS = [
    { id: 'legacy-token-literal', re: /\{\{secure\./g },
    { id: 'legacy-reason-code', re: /secure_credential_/g },
    { id: 'secure-variable-phrase', re: /secure variable/gi },
    { id: 'secure-credential-phrase', re: /secure credential/gi },
];

/**
 * A path (relative, forward-slash) is allowlisted if it matches one of these.
 * Function entries take the relative path; regex entries are tested against it.
 */
export const ALLOWLIST = [
    'src/services/secret-token.ts',
    'packages/apra-fleet-se/fleet-sprint/contracts.mjs',
    'CHANGELOG.md',
    /^tests\//,
    /\/test\//,
    /^packages\/.*\/test\//,
    /docs\/.*\/adr-.*\.md$/,
    /^docs\/adr-.*\.md$/,
];

export function isAllowlistedPath(rel) {
    return ALLOWLIST.some((entry) => (typeof entry === 'string' ? entry === rel : entry.test(rel)));
}

/** Enumerate files under SCAN_ROOTS (relative to repoRoot), skipping SKIP_DIR_NAMES. */
export function listScannableFiles(repoRoot = REPO_ROOT, roots = SCAN_ROOTS) {
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

/**
 * Scan one file's content for stale-terminology hits, skipping any line that
 * contains the word "deprecated" (the sanctioned way to mention the legacy
 * spelling) and any file matched by ALLOWLIST.
 * @returns {Array<{file:string, line:number, id:string, match:string, excerpt:string}>}
 */
export function scanFile(rel, content) {
    if (isAllowlistedPath(rel)) return [];
    const findings = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/deprecated/i.test(line)) continue;
        for (const p of PATTERNS) {
            p.re.lastIndex = 0;
            let m;
            while ((m = p.re.exec(line)) !== null) {
                findings.push({
                    file: rel,
                    line: i + 1,
                    id: p.id,
                    match: m[0],
                    excerpt: line.trim().slice(0, 160),
                });
            }
        }
    }
    return findings;
}

export function runScan(repoRoot = REPO_ROOT) {
    const files = listScannableFiles(repoRoot);
    const findings = [];
    for (const f of files) {
        const content = fs.readFileSync(f.abs, 'utf8');
        findings.push(...scanFile(f.rel, content));
    }
    return { files, findings };
}

export function formatFinding(f) {
    return `${f.file}:${f.line}  [${f.id}]  ${f.excerpt}`;
}

export function formatReport(findings) {
    return [
        `SECRET TERMINOLOGY: ${findings.length} stale "secure"-spelling hit(s) found.`,
        'Canonical spelling is now "secret" ({{secret.NAME}}, secret_variable_*, "secret variable"/"secret credential").',
        '{{secure.NAME}} still resolves for backward compatibility, but new text must recommend {{secret.NAME}}.',
        '',
        ...findings.map(formatFinding),
    ].join('\n');
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { files, findings } = runScan();
    console.log(`Scanned ${files.length} file(s) under ${SCAN_ROOTS.join(', ')}.`);
    if (findings.length) {
        console.log(formatReport(findings));
        process.exit(1);
    }
    console.log('OK: no stale "secure" terminology found.');
}
