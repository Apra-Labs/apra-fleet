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

test('findLineViolations reports a column for each construct on the line', () => {
    const found = findLineViolations('await command(\'cp ~/a "$HOME/b"\', { member_name: m });');
    assert.equal(found.length, 2, JSON.stringify(found));
    assert.ok(found[0].column < found[1].column, 'findings are ordered by column');
    assert.ok(found.every((f) => f.column > 0));
});
