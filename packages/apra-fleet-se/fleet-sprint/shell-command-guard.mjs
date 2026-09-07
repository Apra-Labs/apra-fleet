import fs from 'fs';
import path from 'path';

// =============================================================================
// shell-command guard checker -- fourth mechanical guard in this directory,
// modelled on dispatch-safety-guard.mjs, dolt-literal-guard.mjs and
// full-db-fetch-guard.mjs (same shape: a line scanner exported and
// parameterizable by path, with explicit carve-outs for full-line comments
// and import/require lines, so it can be pointed at BOTH the real guarded
// modules and a throwaway fixture that deliberately violates the invariant).
//
// INVARIANT UNDER TEST: a member-bound command string must NEVER rely on
// shell-level expansion performed in the orchestrator process's idea of a
// shell. The target member's shell may be PowerShell (or cmd.exe, or
// Git-for-Windows bash), not POSIX sh -- so none of the following may appear
// in a string this repo hands to command()/execute_command:
//
//   - variable expansion, bare (`$HOME`, `$env:USERPROFILE`) or braced
//     (a literal `${VAR}` reaching the member, i.e. one written inside a
//     single/double-quoted JS string or escaped as `\${VAR}` in a template
//     literal);
//   - a leading tilde path (`~/...`) -- PowerShell and cmd.exe do not expand
//     it the way POSIX sh does;
//   - backtick command substitution (a literal backtick reaching the member),
//     or its `$( ... )` POSIX equivalent.
//
// Paths must instead be resolved in JavaScript BEFORE the command string is
// built -- via probeCommandFor(targetOs, shell) in src/services/member-home.ts,
// or by branching on isPosixShell(agentOs, shell) in src/providers/claude.ts
// (see also fleet-sprint/se-os-commands.mjs's per-shell command classes,
// which are how this package does that branching).
//
// WHAT IS DELIBERATELY NOT FLAGGED
//
//   1. JS template interpolation. A bare `${expr}` inside a backtick template
//      literal is resolved IN JAVASCRIPT before the string is ever dispatched;
//      that is the prescribed fix, not the violation. Only a `${...}` that
//      survives into the emitted text -- one inside a '...'/"..." string, or
//      written `\${...}` inside a template -- is a violation.
//   2. Backticks used as JS template-literal delimiters. Only an ESCAPED
//      backtick (a literal backtick in the emitted string), or a backtick
//      inside a '...'/"..." JS string, is a violation.
//   3. Secure token references. execute_command replaces each secure.NAME
//      token with a value that has ALREADY been quoted for the target
//      member's shell (escapePowerShellArg for windows members,
//      escapeShellArg otherwise -- src/tools/execute-command.ts). Those
//      tokens carry no `$`, `~/` or backtick, so they never match a rule
//      here; a bare token reference is correct and must stay bare (wrapping
//      one in extra quotes double-escapes the value and surfaces as a false
//      401 / invalid-token error). This guard must never push a caller toward
//      adding those quotes.
//
// CARVE-OUTS (mirroring the sibling guards):
//   - full-line comments (trimmed text starting with `//`, `*` or `/*`) --
//     prose that merely DISCUSSES `$HOME`/`~/`/backticks is not a dispatch;
//     runner.js's own RUNNER-WIDE POSIX-EXPANSION SWEEP note is exactly this;
//   - `import`/`require` lines;
//   - an explicit, documented per-line allow directive: a trailing
//     `// shell-guard-allow: <reason>` comment on the offending line (or on
//     the line immediately above it) suppresses that line, and the reason
//     text is REQUIRED -- an allow with no reason is itself reported. This
//     exists for the handful of genuinely deliberate cases where the member's
//     own shell must do the expansion because the WRITE side used the same
//     token (fleet-sprint/se-posix.mjs's `$HOME/...` credential-helper path
//     is the canonical example: it must stay byte-identical to what
//     src/os/linux.ts wrote).
// =============================================================================

/** Trailing/standalone directive that suppresses one line, with a required reason. */
const ALLOW_RE = /shell-guard-allow:\s*(\S.*)$/;
/** An allow directive with no reason text after the colon. */
const ALLOW_NO_REASON_RE = /shell-guard-allow:\s*$/;

function isCommentLine(text) {
    const trimmed = text.trim();
    return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function isImportLine(text) {
    return /^\s*(import\b|export\b.*\bfrom\b|(const|let|var)\s.*\brequire\s*\()/.test(text);
}

/**
 * Splits `text` into segments tagged with the JS quoting context they sit in,
 * scanning a single line left to right. Returns an array of
 * { kind, start, end } where kind is one of 'code', 'single', 'double',
 * 'template'. Deliberately single-line (like dispatch-safety-guard.mjs's
 * isInsideSameLineString): a whole-file quote scan misfires on apostrophes in
 * prose. A template literal that opens on this line and does not close is
 * treated as running to end of line, which is the conservative choice -- the
 * bytes on THIS line are what we classify.
 */
export function segmentLine(text) {
    const segments = [];
    let kind = 'code';
    let start = 0;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\\') { i++; continue; }
        if (kind === 'code') {
            if (ch === "'" || ch === '"' || ch === '`') {
                segments.push({ kind: 'code', start, end: i });
                kind = ch === "'" ? 'single' : ch === '"' ? 'double' : 'template';
                start = i + 1;
            }
        } else {
            const closer = kind === 'single' ? "'" : kind === 'double' ? '"' : '`';
            if (ch === closer) {
                segments.push({ kind, start, end: i });
                kind = 'code';
                start = i + 1;
            }
        }
    }
    segments.push({ kind, start, end: text.length });
    return segments.filter((s) => s.end > s.start);
}

/** True when `col` sits inside a JS template literal opened earlier on the same line. */
function segmentKindAt(segments, col) {
    for (const s of segments) {
        if (col >= s.start && col < s.end) return s.kind;
    }
    return 'code';
}

// A shell variable expansion with no braces: `$HOME`, `$env:USERPROFILE`,
// `$pid`. Not preceded by a `$` (so `$$` is not double-counted) and not
// followed by `{`.
const BARE_VAR_RE = /(?<!\$)\$([A-Za-z_][A-Za-z0-9_:]*)/g;
// A brace expansion written so it SURVIVES into the emitted string.
const BRACED_VAR_RE = /\$\{/g;
// POSIX command substitution.
const CMD_SUBST_RE = /\$\(/g;
// A leading tilde path.
const TILDE_RE = /(^|[\s'"`=(,:])~\//g;

/**
 * Scans one line of source and returns an array of { column, reason } for
 * every shell-expansion construct that would survive into a dispatched
 * command string. Exported for direct unit testing.
 */
export function findLineViolations(text) {
    const segments = segmentLine(text);
    const found = [];
    const inString = (col) => segmentKindAt(segments, col) !== 'code';

    let m;
    BARE_VAR_RE.lastIndex = 0;
    while ((m = BARE_VAR_RE.exec(text)) !== null) {
        if (!inString(m.index)) continue;
        found.push({
            column: m.index + 1,
            reason:
                `bare shell variable expansion "$${m[1]}" in a command string -- the target member's shell may be ` +
                `PowerShell, not POSIX; resolve the value in JavaScript first (probeCommandFor(targetOs, shell) in ` +
                `src/services/member-home.ts, or branch on isPosixShell(agentOs, shell))`,
        });
    }

    CMD_SUBST_RE.lastIndex = 0;
    while ((m = CMD_SUBST_RE.exec(text)) !== null) {
        if (!inString(m.index)) continue;
        found.push({
            column: m.index + 1,
            reason:
                'POSIX command substitution "$(" in a command string -- run the probe as its own dispatch and ' +
                'interpolate the result in JavaScript instead',
        });
    }

    BRACED_VAR_RE.lastIndex = 0;
    while ((m = BRACED_VAR_RE.exec(text)) !== null) {
        const kind = segmentKindAt(segments, m.index);
        const escaped = m.index > 0 && text[m.index - 1] === '\\';
        // A bare `${...}` inside a template literal is JS interpolation --
        // resolved before dispatch, which is the prescribed fix. Only a
        // braced expansion that survives into the emitted text counts.
        if (kind === 'template' && !escaped) continue;
        if (kind === 'code') continue;
        found.push({
            column: m.index + 1,
            reason:
                'braced shell variable expansion "${...}" survives into the dispatched command string -- ' +
                'interpolate the value in JavaScript instead of leaving it for the member shell to expand',
        });
    }

    TILDE_RE.lastIndex = 0;
    while ((m = TILDE_RE.exec(text)) !== null) {
        const col = m.index + m[1].length;
        if (!inString(col)) continue;
        found.push({
            column: col + 1,
            reason:
                'leading tilde path "~/" in a command string -- PowerShell and cmd.exe do not expand it; resolve ' +
                "the member's home directory in JavaScript (probeCommandFor(targetOs, shell))",
        });
    }

    // Backticks: only an ESCAPED backtick counts -- see the rule note in this
    // file's header. An UNescaped backtick inside a '...'/"..." JS string is
    // overwhelmingly a markdown code span in agent-prompt prose (runner.js has
    // ~24 of them) or a JS fence-builder, not a dispatched shell substitution,
    // so flagging those makes the guard pure noise. `\`` in a template literal
    // is the deliberate "emit a literal backtick into this command string"
    // spelling, which is the construct this rule exists to catch.
    for (let i = 0; i < text.length; i++) {
        if (text[i] !== '`') continue;
        const escaped = i > 0 && text[i - 1] === '\\';
        if (!escaped) continue;
        found.push({
            column: i + 1,
            reason:
                'backtick command substitution in a command string -- run the probe as its own dispatch and ' +
                'interpolate the result in JavaScript instead',
        });
        break; // one report per line is enough; a pair of backticks is one construct
    }

    return found.sort((a, b) => a.column - b.column);
}

/**
 * Scans whole-file source `src`, applying the carve-outs, and returns an
 * array of { line, column, reason, text } violations.
 */
export function findShellCommandViolations(src) {
    const lines = src.split('\n');
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
        const text = lines[i];
        const prev = i > 0 ? lines[i - 1] : '';
        if (isCommentLine(text)) {
            // A standalone allow directive with no reason is still reported,
            // so a suppression can never be added without saying why.
            if (ALLOW_NO_REASON_RE.test(text)) {
                violations.push({
                    line: i + 1,
                    column: text.indexOf('shell-guard-allow') + 1,
                    reason: 'shell-guard-allow directive has no reason text -- state why the member shell must do the expansion',
                    text: text.trim(),
                });
            }
            continue;
        }
        if (isImportLine(text)) continue;
        const lineFindings = findLineViolations(text);
        if (lineFindings.length === 0) continue;
        if (ALLOW_NO_REASON_RE.test(text) || ALLOW_NO_REASON_RE.test(prev)) {
            violations.push({
                line: i + 1,
                column: 1,
                reason: 'shell-guard-allow directive has no reason text -- state why the member shell must do the expansion',
                text: text.trim(),
            });
            continue;
        }
        if (ALLOW_RE.test(text) || ALLOW_RE.test(prev)) continue;
        for (const f of lineFindings) {
            violations.push({ line: i + 1, column: f.column, reason: f.reason, text: text.trim() });
        }
    }
    return violations;
}

/**
 * Reads and scans the source file at `filePath`, returning
 * { violations } where each violation is { file, line, column, reason, text }
 * -- `file` is the basename, matching how the sibling guards label a
 * violation, so an aggregate run over several modules attributes each finding
 * to the module it came from.
 */
export function checkShellCommandPath(filePath) {
    const src = fs.readFileSync(filePath, 'utf8');
    const file = path.basename(filePath);
    const violations = findShellCommandViolations(src).map((v) => ({ file, ...v }));
    return { violations };
}

/**
 * Aggregate entry point: scans EVERY path in `paths` (e.g. the shared guarded
 * module list) and returns { violations, files } with each violation carrying
 * the file it came from. Takes an explicit array so this module stays
 * independent of any one registry.
 */
export function checkShellCommandPaths(paths) {
    if (!Array.isArray(paths)) throw new TypeError('checkShellCommandPaths(paths): paths must be an array of file paths');
    const violations = [];
    for (const p of paths) violations.push(...checkShellCommandPath(p).violations);
    return { violations, files: paths.map((p) => path.basename(p)) };
}

/** Human-readable rendering of one violation, for assertion messages and logs. */
export function formatShellCommandViolation(v) {
    return `${v.file || '<unknown>'}:${v.line}:${v.column} ${v.reason}`;
}
