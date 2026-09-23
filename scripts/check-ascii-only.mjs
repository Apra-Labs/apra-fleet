#!/usr/bin/env node
/**
 * check-ascii-only.mjs -- enforces CLAUDE.md's "ASCII only: never write
 * non-ASCII characters to any file" convention.
 *
 * Design note (see apra-fleet-oomh.16): a census at authoring time found 133
 * git-tracked text files already carrying non-ASCII characters on 729 lines,
 * overwhelmingly pre-existing console-output symbols and em-dashes that
 * predate this gate. Rewriting all of that is out of scope for the sprint
 * that added this gate, so the check ships with a checked-in baseline
 * (scripts/ascii-baseline.mjs) mapping each currently-offending file to its
 * violation COUNT. That makes the exemption a RATCHET, not a blanket
 * exemption:
 *   - a file with no baseline entry must have zero violations;
 *   - a baselined file may have AT MOST its recorded count -- one more
 *     violation fails;
 *   - a baselined file with FEWER violations than recorded also fails, so the
 *     baseline cannot silently go stale -- shrinking it is a required edit,
 *     never a side effect that goes unnoticed.
 *
 * Binary files are excluded by an explicit, content-based filter (presence of
 * a NUL byte in the first 8000 bytes -- the same heuristic git itself uses to
 * decide "is this binary"), not by an accident of file extension: a tracked
 * asset that happens to end in a text-like extension but contains a NUL byte
 * is still treated as binary, and nothing is exempted merely by matching an
 * extension list.
 *
 * Usage:
 *   node scripts/check-ascii-only.mjs           # scan every git-tracked file
 *   node scripts/check-ascii-only.mjs a.ts b.md # scan explicit files (no
 *                                                # baseline applied -- any
 *                                                # non-ASCII byte fails)
 * Exit code 1 on any violation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');
export const BASELINE_PATH = path.join(__dirname, 'ascii-baseline.mjs');

/**
 * A file is treated as binary if a NUL byte appears in the first 8000 bytes
 * read from disk -- the same "is this text" heuristic `git diff`/`git grep`
 * use internally. This is a content check, not an extension allowlist, so a
 * tracked file with a text-like extension that happens to contain a NUL byte
 * is still skipped, and no file is exempted merely by its name.
 */
export function isBinaryFile(absPath) {
    const fd = fs.openSync(absPath, 'r');
    try {
        const buf = Buffer.alloc(8000);
        const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
        return buf.subarray(0, bytesRead).includes(0);
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * Same NUL-byte heuristic, applied to an in-memory buffer -- used by tests
 * that build fixtures without touching disk.
 */
export function isBinaryBuffer(buf) {
    return buf.includes(0);
}

/**
 * Scans decoded text for characters outside 0x00-0x7F. Returns one entry per
 * offending character with 1-based line/column and its Unicode codepoint.
 * Column counts UTF-16 code units (matching how editors report columns);
 * astral characters (surrogate pairs) are reported once, at the position of
 * the high surrogate, and the codepoint reported is the combined codepoint.
 */
export function findNonAsciiInText(text) {
    const violations = [];
    const lines = text.split('\n');
    for (let li = 0; li < lines.length; li += 1) {
        const line = lines[li];
        for (let ci = 0; ci < line.length; ci += 1) {
            const codePoint = line.codePointAt(ci);
            if (codePoint > 0x7f) {
                violations.push({ line: li + 1, column: ci + 1, codePoint });
                if (codePoint > 0xffff) ci += 1; // astral char consumes a surrogate pair
            }
        }
    }
    return violations;
}

/** Formats a codepoint as "U+XXXX" (minimum 4 hex digits, uppercase). */
export function formatCodePoint(codePoint) {
    return `U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`;
}

/** Lists every git-tracked file (relative paths) under repoRoot. */
export function listTrackedFiles(repoRoot = REPO_ROOT) {
    const out = execFileSync('git', ['-C', repoRoot, 'ls-files'], { encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
}

/**
 * Scans one file on disk. Returns { rel, binary, violations }. Binary files
 * report violations: [] and binary: true (never flagged).
 */
export function scanFile(absPath, rel) {
    if (isBinaryFile(absPath)) return { rel, binary: true, violations: [] };
    const text = fs.readFileSync(absPath, 'utf8');
    return { rel, binary: false, violations: findNonAsciiInText(text) };
}

/** Scans a list of repo-relative paths, resolved against repoRoot. */
export function scanFiles(relFiles, repoRoot = REPO_ROOT) {
    return relFiles.map((rel) => scanFile(path.join(repoRoot, rel), rel));
}

/**
 * Loads the baseline module (default export: { [relPath]: violationCount }).
 * A missing file behaves like an empty baseline (used by tests that pass
 * their own baseline object directly to evaluate() instead).
 */
export async function loadBaseline(baselinePath = BASELINE_PATH) {
    if (!fs.existsSync(baselinePath)) return {};
    const mod = await import(`${baselinePath}?t=${Date.now()}`);
    return mod.default ?? {};
}

/**
 * Compares scan results against a baseline. Every non-empty-violation file
 * not in the baseline is a 'new-file' finding (full violation detail
 * attached). A baselined file with MORE violations than recorded is a
 * 'ratchet' finding. A baselined file with FEWER violations than recorded
 * (including zero) is a 'shrink' finding -- the baseline is stale and must be
 * updated; this is reported as a failure so it is never silently accepted.
 * A baselined file whose count matches exactly is not reported at all.
 */
export function evaluate(scanResults, baseline = {}) {
    const findings = [];
    const currentCounts = {};
    for (const r of scanResults) {
        if (r.binary) continue;
        if (r.violations.length > 0) currentCounts[r.rel] = r.violations;
    }

    const filesToCheck = new Set([...Object.keys(currentCounts), ...Object.keys(baseline)]);
    for (const file of filesToCheck) {
        const violations = currentCounts[file] ?? [];
        const baselineCount = baseline[file] ?? 0;
        if (baselineCount === 0 && violations.length > 0) {
            findings.push({ kind: 'new-file', file, count: violations.length, violations });
        } else if (violations.length > baselineCount) {
            findings.push({ kind: 'ratchet', file, count: violations.length, baseline: baselineCount, violations });
        } else if (violations.length < baselineCount) {
            findings.push({ kind: 'shrink', file, count: violations.length, baseline: baselineCount });
        }
    }
    findings.sort((a, b) => a.file.localeCompare(b.file));
    return { ok: findings.length === 0, findings };
}

export function formatFinding(f) {
    const lines = [];
    if (f.kind === 'new-file') {
        lines.push(`${f.file}: ${f.count} non-ASCII character(s) found (file is not in the baseline -- must be zero)`);
        for (const v of f.violations) {
            lines.push(`    ${f.file}:${v.line}:${v.column}  ${formatCodePoint(v.codePoint)}`);
        }
    } else if (f.kind === 'ratchet') {
        lines.push(`${f.file}: ${f.count} non-ASCII character(s) found, baseline allows only ${f.baseline} -- new violation(s) in a baselined file`);
        for (const v of f.violations) {
            lines.push(`    ${f.file}:${v.line}:${v.column}  ${formatCodePoint(v.codePoint)}`);
        }
    } else if (f.kind === 'shrink') {
        lines.push(`${f.file}: ${f.count} non-ASCII character(s) found, baseline records ${f.baseline} -- baseline is stale, update scripts/ascii-baseline.mjs to ${f.count} (or remove the entry if 0)`);
    }
    return lines.join('\n');
}

export function formatReport(result) {
    if (result.ok) return 'OK: no ASCII-only violations.';
    const parts = [
        `ASCII-ONLY GATE: ${result.findings.length} violation(s) found.`,
        'CLAUDE.md: "ASCII only: never write non-ASCII characters to any file."',
        '',
        ...result.findings.map(formatFinding),
    ];
    return parts.join('\n');
}

/**
 * Runs the full check. `files`, when provided, is scanned as-is with NO
 * baseline applied (any non-ASCII byte fails) -- used by the explicit-files
 * CLI mode and mirrors check-generic-boundary.mjs's own explicit-file mode.
 * Otherwise every git-tracked file under repoRoot is scanned against the
 * checked-in baseline.
 */
export async function runCheck({ repoRoot = REPO_ROOT, baselinePath = BASELINE_PATH, files = null } = {}) {
    if (files) {
        const results = scanFiles(files, repoRoot);
        return evaluate(results, {});
    }
    const tracked = listTrackedFiles(repoRoot);
    const results = scanFiles(tracked, repoRoot);
    const baseline = await loadBaseline(baselinePath);
    return evaluate(results, baseline);
}

// CLI
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const result = args.length === 0 ? await runCheck() : await runCheck({ files: args });
    console.log(formatReport(result));
    process.exit(result.ok ? 0 : 1);
}
