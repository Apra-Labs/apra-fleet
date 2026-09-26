import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'url';
import {
    checkShellCommandPath,
    checkShellCommandPaths,
    findShellCommandViolations,
    findLineViolations,
    formatShellCommandViolation,
} from '../fleet-sprint/shell-command-guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// shell-command guard test. Companion to dispatch-safety-guard.test.mjs and
// dolt-literal-guard.test.mjs, same shape.
//
// Invariant under test: no member-bound command string built in a guarded
// module may rely on shell-level expansion (bare/braced variable expansion,
// a leading `~/` path, backtick or `$( )` substitution) -- the target
// member's shell may be PowerShell, not POSIX, so paths must be resolved in
// JavaScript before the command string is built (probeCommandFor(targetOs,
// shell) in src/services/member-home.ts, or a branch on
// isPosixShell(agentOs, shell)).
//
// SCOPE NOTE (important, and why this guard is pointed at a curated module
// list rather than the whole directory): fleet-sprint/se-posix.mjs,
// se-windows.mjs and dolt-settle.mjs deliberately DO emit `$HOME`,
// `$env:USERPROFILE`, `$env:TEMP` and `$( )` -- they ARE the per-shell
// command builders this invariant tells everyone else to route through, and
// their strings are chosen per target OS/shell. Scanning them would report
// their whole reason for existing as violations. This guard is therefore
// only ever pointed at the orchestrator-side modules that must stay
// shell-agnostic: runner.js today, plus whatever is extracted from it.
//
// Fixtures are built as in-memory source strings, and (for the path-scanning
// entry point) as files under os.tmpdir() removed on teardown -- nothing is
// written into the repo tree.
// =============================================================================

const RUNNER_PATH = path.join(__dirname, '../fleet-sprint/runner.js');
const MEMBER_STRAY_SWEEP_PATH = path.join(__dirname, '../fleet-sprint/member-stray-sweep.mjs');

/** Writes `src` to a throwaway file under os.tmpdir(); returns { file, dir, cleanup }. */
function withFixture(name, src) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-guard-'));
    const file = path.join(dir, name);
    fs.writeFileSync(file, src, 'utf8');
    return { file, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// -----------------------------------------------------------------------------
// Baseline: the guarded module is clean today.
// -----------------------------------------------------------------------------

test('shell guard reports zero violations for runner.js on current HEAD (baseline)', () => {
    const { violations } = checkShellCommandPath(RUNNER_PATH);
    assert.deepEqual(
        violations.map(formatShellCommandViolation),
        [],
        'runner.js must build no member-bound command string that relies on shell-level expansion; ' +
        'resolve paths in JavaScript (probeCommandFor / isPosixShell) instead'
    );
});

// -----------------------------------------------------------------------------
// apra-fleet-i4ku.8: member-stray-sweep.mjs's buildKillCommand() emits a
// member-bound `$?` (POSIX exit status) and is registered in GUARDED_MODULES,
// yet the guard reported zero violations before this bead -- BARE_VAR_RE
// requires a letter/underscore right after `$`, so every POSIX special
// parameter ($? $! $$ $# $@ $* $0-$9) passed unflagged. This pins the fix: the
// module is scanned clean now ONLY because the real `$?` site carries a
// documented shell-guard-allow annotation (see the next test for proof the
// annotation is load-bearing, not decorative).
// -----------------------------------------------------------------------------

test('shell guard reports zero violations for member-stray-sweep.mjs on current HEAD (baseline, apra-fleet-i4ku.8)', () => {
    const { violations } = checkShellCommandPath(MEMBER_STRAY_SWEEP_PATH);
    assert.deepEqual(
        violations.map(formatShellCommandViolation),
        [],
        'member-stray-sweep.mjs must build no member-bound command string with an unannotated shell-level ' +
        'expansion; its one deliberate $? use (buildKillCommand) must carry a documented shell-guard-allow'
    );
});

// -----------------------------------------------------------------------------
// The guard actually fails on a non-compliant fixture (not vacuous).
// -----------------------------------------------------------------------------

const NON_COMPLIANT_SRC = [
    "import { runCommand } from './somewhere.mjs';",
    '',
    'export async function deployHelper(command, member) {',
    '    // Both of the next two lines are the mistake this guard exists to catch.',
    '    await command(`cat ~/.fleet-git-credential-github`, { member_name: member });',
    '    await command(\'test -f "$HOME/.apra-fleet/bin/dolt"\', { member_name: member });',
    '}',
].join('\n');

const COMPLIANT_SRC = [
    "import { probeCommandFor } from '../../src/services/member-home.mjs';",
    '',
    'export async function deployHelper(command, member, homeDir) {',
    '    // Home directory resolved in JavaScript BEFORE the string is built, then',
    '    // interpolated with a JS template -- nothing left for the member shell.',
    '    const helper = `${homeDir}/.fleet-git-credential-github`;',
    '    await command(`cat "${helper}"`, { member_name: member });',
    '}',
].join('\n');

test('shell guard flags a synthetic fixture containing a tilde path and an unquoted variable expansion', () => {
    const violations = findShellCommandViolations(NON_COMPLIANT_SRC);
    assert.equal(violations.length, 2, `expected exactly 2 violations, got: ${JSON.stringify(violations, null, 2)}`);

    const tilde = violations.find((v) => /tilde/.test(v.reason));
    assert.ok(tilde, `expected a tilde-path violation, got: ${JSON.stringify(violations, null, 2)}`);
    assert.equal(tilde.line, 5, 'tilde violation must name the offending line');

    const variable = violations.find((v) => /bare shell variable expansion/.test(v.reason));
    assert.ok(variable, `expected a bare-variable violation, got: ${JSON.stringify(violations, null, 2)}`);
    assert.equal(variable.line, 6, 'variable violation must name the offending line');
    assert.match(variable.reason, /\$HOME/, 'the reason must quote the offending expansion');
    assert.match(variable.reason, /probeCommandFor|isPosixShell/, 'the reason must point at the prescribed JS-side fix');
});

test('shell guard passes a fixture that resolves paths in JavaScript', () => {
    assert.deepEqual(
        findShellCommandViolations(COMPLIANT_SRC),
        [],
        'a JS-resolved path interpolated with a template literal is the prescribed fix, not a violation'
    );
});

// -----------------------------------------------------------------------------
// Violation shape: file, line and reason (path-scanning entry point).
// -----------------------------------------------------------------------------

test('checkShellCommandPath returns violations carrying file, line and reason', () => {
    const fx = withFixture('non-compliant.mjs', NON_COMPLIANT_SRC);
    try {
        const { violations } = checkShellCommandPath(fx.file);
        assert.equal(violations.length, 2);
        for (const v of violations) {
            assert.equal(v.file, 'non-compliant.mjs', 'each violation names the file it came from');
            assert.equal(typeof v.line, 'number');
            assert.ok(v.line > 0);
            assert.equal(typeof v.reason, 'string');
            assert.ok(v.reason.length > 20, 'the reason must actually explain the problem');
        }
        assert.match(formatShellCommandViolation(violations[0]), /^non-compliant\.mjs:5:/);
    } finally {
        fx.cleanup();
    }
});

test('checkShellCommandPaths scans every path it is given and attributes each violation to its own file', () => {
    const bad = withFixture('bad-module.mjs', NON_COMPLIANT_SRC);
    const good = withFixture('good-module.mjs', COMPLIANT_SRC);
    try {
        const { violations, files } = checkShellCommandPaths([good.file, bad.file, RUNNER_PATH]);
        assert.deepEqual(files, ['good-module.mjs', 'bad-module.mjs', 'runner.js']);
        assert.equal(violations.length, 2);
        assert.deepEqual([...new Set(violations.map((v) => v.file))], ['bad-module.mjs']);
    } finally {
        bad.cleanup();
        good.cleanup();
    }
});

test('checkShellCommandPaths rejects a non-array argument rather than silently scanning nothing', () => {
    assert.throws(() => checkShellCommandPaths(RUNNER_PATH), /must be an array/);
});

// -----------------------------------------------------------------------------
// Every individual rule, and every carve-out.
// -----------------------------------------------------------------------------

test('rule: POSIX command substitution and a literal backtick are both flagged', () => {
    const subst = findShellCommandViolations('await command(`echo $(hostname)`, { member_name: m });');
    assert.equal(subst.length, 1, JSON.stringify(subst));
    assert.match(subst[0].reason, /command substitution/);

    const backtick = findShellCommandViolations('await command(`echo \\`hostname\\``, { member_name: m });');
    assert.equal(backtick.length, 1, JSON.stringify(backtick));
    assert.match(backtick[0].reason, /backtick command substitution/);
});

test('rule: a braced expansion that SURVIVES into the emitted string is flagged, JS interpolation is not', () => {
    // Single-quoted: the ${...} is literal text handed to the member shell.
    const survives = findShellCommandViolations("await command('echo ${HOME}', { member_name: m });");
    assert.equal(survives.length, 1, JSON.stringify(survives));
    assert.match(survives[0].reason, /braced shell variable expansion/);

    // Escaped inside a template literal: likewise literal in the emitted text.
    const escaped = findShellCommandViolations('await command(`echo \\${HOME}`, { member_name: m });');
    assert.equal(escaped.length, 1, JSON.stringify(escaped));

    // Plain JS template interpolation: resolved before dispatch -- the fix, not the bug.
    assert.deepEqual(findShellCommandViolations('await command(`echo ${homeDir}`, { member_name: m });'), []);
});

test('carve-out: a full-line comment that merely discusses $HOME, ~/ or backticks is never a violation', () => {
    const src = [
        "// the credential helper lives at $HOME/.fleet-git-credential-github on POSIX",
        ' * ...and this JSDoc line mentions ~/ and $(whoami) too',
        '/* as does this block-comment opener: ${VAR} */',
    ].join('\n');
    assert.deepEqual(findShellCommandViolations(src), []);
});

test('carve-out: import/require lines are never scanned', () => {
    const src = [
        "import { x } from './a$HOME.mjs';",
        "const y = require('./b~/c.mjs');",
    ].join('\n');
    assert.deepEqual(findShellCommandViolations(src), []);
});

test('carve-out: a secure token reference is left bare and is never flagged', () => {
    // Built by concatenation so the literal braced token pattern never appears
    // verbatim in this file. execute_command substitutes an ALREADY
    // shell-escaped, OS-branched value for this token, so the correct usage is
    // exactly this -- bare, with no quotes of our own around it. The guard must
    // never nudge a caller into adding those quotes (double-escaping surfaces
    // as a false 401 / invalid-token error).
    const token = '{' + '{secure.GITHUB_TOKEN}' + '}';
    const src = `await command(\`git clone https://x:${token}@github.com/o/r.git\`, { member_name: m });`;
    assert.deepEqual(findShellCommandViolations(src), []);
});

test('carve-out: an allow directive with a reason suppresses the line, above it or on it', () => {
    const onLine = [
        'const p = `$HOME/.fleet-git-credential-${label}`; // shell-guard-allow: must match what src/os/linux.ts wrote',
    ].join('\n');
    assert.deepEqual(findShellCommandViolations(onLine), []);

    const above = [
        '// shell-guard-allow: must match what src/os/linux.ts wrote at provision time',
        'const p = `$HOME/.fleet-git-credential-${label}`;',
    ].join('\n');
    assert.deepEqual(findShellCommandViolations(above), []);
});

test('carve-out: an allow directive with NO reason is itself reported, so suppressions cannot be silent', () => {
    const src = [
        'const p = `$HOME/.fleet-git-credential-${label}`; // shell-guard-allow:',
    ].join('\n');
    const violations = findShellCommandViolations(src);
    assert.equal(violations.length, 1, JSON.stringify(violations));
    assert.match(violations[0].reason, /no reason text/);
});

// -----------------------------------------------------------------------------
// apra-fleet-3swo.39 -- pins the escaped-backtick-only semantics documented in
// this guard's header (WHAT IS DELIBERATELY NOT FLAGGED, item 2) against the
// four cases measured while reconciling that header with the scan loop below.
// SYNTHESIZED source strings only, never a real dispatch site, so this test
// stays valid regardless of the current shape of the tree. The header used to
// claim that a backtick inside a '...'/"..." JS string was ALSO a violation;
// it is not -- only an escaped backtick (one that survives into the emitted
// command string) is. This bead is docs-only: it must not change what
// findShellCommandViolations flags, only confirm the existing behaviour.
// -----------------------------------------------------------------------------
test('backtick semantics: only an escaped backtick is flagged, an unescaped one inside a quoted JS string is not (apra-fleet-3swo.39)', () => {
    // (1) A backtick inside a SINGLE-quoted JS string -- e.g. prose describing
    // a `code span` -- is deliberately not flagged.
    const singleQuoted = findShellCommandViolations("const msg = 'wrap it in `backticks` for the reader';");
    assert.deepEqual(singleQuoted, [], JSON.stringify(singleQuoted));

    // (2) A backtick inside a DOUBLE-quoted JS string is likewise not flagged.
    const doubleQuoted = findShellCommandViolations('const msg = "wrap it in `backticks` for the reader";');
    assert.deepEqual(doubleQuoted, [], JSON.stringify(doubleQuoted));

    // (3) An ESCAPED backtick inside a template literal -- the deliberate
    // "emit a literal backtick into this command string" spelling -- is
    // exactly the construct this rule exists to catch: exactly 1 violation.
    const escapedInTemplate = findShellCommandViolations('await command(`echo \\`hostname\\``, { member_name: m });');
    assert.equal(escapedInTemplate.length, 1, JSON.stringify(escapedInTemplate));
    assert.match(escapedInTemplate[0].reason, /backtick command substitution/);

    // (4) Control case: a bare $HOME expansion inside a single-quoted string
    // still yields exactly 1 violation -- proves the scanner actually ran
    // over this source rather than returning empty for an unrelated reason
    // (e.g. a carve-out swallowing the whole line).
    const control = findShellCommandViolations("await command('echo $HOME', { member_name: m });");
    assert.equal(control.length, 1, JSON.stringify(control));
    assert.match(control[0].reason, /bare shell variable expansion/);
});

// -----------------------------------------------------------------------------
// apra-fleet-i4ku.8: POSIX shell special parameters ($? $! $$ $# $@ $* and
// $0-$9) -- BARE_VAR_RE's blind spot, closed by SPECIAL_PARAM_RE.
// -----------------------------------------------------------------------------

test('rule: an unannotated "$?" in a member-bound command string is reported (the exact gap this bead closes)', () => {
    // Mirrors member-stray-sweep.mjs's buildKillCommand() shape verbatim
    // (minus the shell-guard-allow annotation this test proves is load-
    // bearing): "$?" right after a `kill` dispatch, with no suppressing
    // comment anywhere near it.
    const src = 'await command(`kill -9 ${pid} 2>&1; echo "SWEEP-KILL-STATUS ${pid} $?"`, { member_name: m });';
    const violations = findShellCommandViolations(src);
    assert.equal(violations.length, 1, JSON.stringify(violations));
    assert.match(violations[0].reason, /POSIX shell special parameter "\$\?"/);
});

test('rule: every POSIX special parameter ($? $! $$ $# $@ $* and a lone digit $1-$9) is individually flagged', () => {
    for (const [construct, snippet] of [
        ['$?', 'echo "exit=$?"'],
        ['$!', 'echo "bgpid=$!"'],
        ['$$', 'echo "mypid=$$ done"'],
        ['$#', 'echo "argc=$# done"'],
        ['$@', 'echo "args=$@ done"'],
        ['$*', 'echo "args=$* done"'],
        ['$1', 'echo "first=$1 done"'],
    ]) {
        const violations = findShellCommandViolations(`await command('${snippet}', { member_name: m });`);
        assert.equal(violations.length, 1, `${construct}: ${JSON.stringify(violations)}`);
        assert.match(violations[0].reason, /POSIX shell special parameter/, `${construct} must be flagged`);
        assert.ok(violations[0].reason.includes(`"${construct}"`), `${construct}: reason must quote the offending construct, got: ${violations[0].reason}`);
    }
});

test('rule: "$0" (positional param zero) is flagged the same as $1-$9', () => {
    const violations = findShellCommandViolations("await command('echo $0', { member_name: m });");
    assert.equal(violations.length, 1, JSON.stringify(violations));
    assert.match(violations[0].reason, /POSIX shell special parameter "\$0"/);
});

test('false-positive guard: a dollar-amount literal ($5.00, $1234, multi-digit) is never mistaken for a positional parameter', () => {
    // A genuine POSIX positional parameter is always exactly ONE digit; a
    // digit immediately followed by another digit or "." is a currency
    // literal in a report/PR-body string (sprint-report.mjs is full of
    // these), never dispatched to a shell at all.
    assert.deepEqual(findShellCommandViolations("const s = 'Budget ceiling: $5.00.';"), []);
    assert.deepEqual(findShellCommandViolations("const s = 'Remaining: $1234 today.';"), []);
    assert.deepEqual(findShellCommandViolations("const s = 'Spend: $0.0000 tracked.';"), []);
});

test('false-positive guard: "$" immediately followed by "${...}" JS interpolation ("$${expr}") is never flagged as a literal "$$"', () => {
    // The exact shape this package's own cost-report / kill-status strings
    // use: a literal "$" (currency sign, or this guard's own message prefix)
    // immediately followed by a JS template interpolation -- never a shell
    // "$$" (process id).
    assert.deepEqual(findShellCommandViolations('const s = `Budget ceiling: $${total.toFixed(4)}.`;'), []);
});

test('rule: a genuine "$$" (shell pid, not followed by "{") IS flagged', () => {
    const violations = findShellCommandViolations("await command('echo $$ is my pid', { member_name: m });");
    assert.equal(violations.length, 1, JSON.stringify(violations));
    assert.match(violations[0].reason, /POSIX shell special parameter "\$\$"/);
});

test('carve-out: an annotated "$?" (mirroring buildKillCommand\'s real shell-guard-allow) is suppressed', () => {
    const src = 'await command(`kill -9 ${pid} 2>&1; echo "STATUS ${pid} $?"`, { member_name: m }); ' +
        '// shell-guard-allow: $? is the invoking POSIX shell\'s own exit status for the kill immediately above.';
    assert.deepEqual(findShellCommandViolations(src), []);
});

test('findLineViolations reports a column for each construct on the line', () => {
    const found = findLineViolations('await command(\'cp ~/a "$HOME/b"\', { member_name: m });');
    assert.equal(found.length, 2, JSON.stringify(found));
    assert.ok(found[0].column < found[1].column, 'findings are ordered by column');
    assert.ok(found.every((f) => f.column > 0));
});
