import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildCreatePrCommand, buildCommentCommand } from '../fleet-sprint/vcs-module.mjs';
import { shQuote, shQuoteJson, escapeForWindowsArgv } from '../fleet-sprint/vcs-providers/shell-helpers.mjs';
import {
    nextPowerShellStringLiteral,
    legacyBinderCommandLine,
    crtParseCommandLine,
    nativeArgFromPowerShellWord,
    nativeDashDPayload,
} from './helpers/windows-argv.mjs';

// =============================================================================
// PowerShell-dialect `-d` payloads must survive what a NATIVE child actually
// does with them -- not just PowerShell's own string parser.
//
// The defect this pins: Windows PowerShell 5.1's legacy native-argument
// binder hands a single-quoted argument's value to the child's command line
// without escaping its double quotes, so the C-runtime argv parser inside
// curl.exe strips every `"` out of the JSON body (a live member answered
// HTTP 400 to `{title:x y}`). Every earlier PowerShell-dialect assertion in
// this package stopped at stage 1 (PowerShell's `''` rule) and therefore
// passed against the broken form.
//
// Two layers of proof:
//   1. A pure simulator of the documented binder + CRT rules
//      (helpers/windows-argv.mjs), runnable on every CI OS, that decodes the
//      built command the way the real stack does -- including decoding the
//      OLD broken form to the corrupted string, so the simulator is proven
//      to reproduce the defect, not just to accept the fix.
//   2. On a Windows host: the real powershell.exe, running the real built
//      `-d` word through a node argv probe. Skipped elsewhere.
//
// ASCII only.
// =============================================================================

const TITLE = 'Auto-sprint [PASS]: it\'s "quoted" 100% done';
const BODY = 'Notes: say "hi"\nsecond line\ttab, backslash \\ then \\"escaped\\", $env:PATH %PATH% `tick`';

const ADO_PARAMS = Object.freeze({
    provider: 'azure-devops',
    repoRef: { org: 'apralabs', project: 'e2e-fleet-testing', repo: 'fleet-e2e-toy' },
    base: 'main',
    head: 'auto-sprint/feat-x',
    title: TITLE,
    body: BODY,
    token: 'PAT-TOKEN-abc123',
});
const GH_PARAMS = Object.freeze({
    provider: 'github',
    repo: 'Apra-Labs/apra-fleet',
    base: 'main',
    head: 'auto-sprint/feat-x',
    title: TITLE,
    body: BODY,
    token: 'ghs_tok',
});

const POWERSHELL_TARGETS = [
    { label: 'windows+powershell5', os: 'windows', shell: 'powershell5' },
    { label: 'windows+pwsh7', os: 'windows', shell: 'pwsh7' },
    { label: 'windows+unresolved-shell', os: 'windows', shell: '' },
];

describe('windows-argv simulator reproduces the documented binder + CRT rules', () => {
    test('CRT: quote toggling, backslash runs and whitespace splitting behave per CommandLineToArgvW', () => {
        assert.deepEqual(crtParseCommandLine('a b "c d" e'), ['a', 'b', 'c d', 'e']);
        assert.deepEqual(crtParseCommandLine('{\\"a\\":\\"b\\"}'), ['{"a":"b"}']);
        assert.deepEqual(crtParseCommandLine('"{\\"a\\":\\"b c\\"}"'), ['{"a":"b c"}']);
        assert.deepEqual(crtParseCommandLine('x\\\\"y z"'), ['x\\y z']);
        assert.deepEqual(crtParseCommandLine('x\\\\\\"y'), ['x\\"y']);
        assert.deepEqual(crtParseCommandLine('C:\\dir\\file'), ['C:\\dir\\file']);
    });

    test('legacy binder: wraps only when whitespace sits at even quote parity, never escapes', () => {
        assert.equal(legacyBinderCommandLine(['-d', '{"a":"b"}']), '-d {"a":"b"}');
        assert.equal(legacyBinderCommandLine(['-H', 'Content-Type: application/json']), '-H "Content-Type: application/json"');
        // Whitespace after an odd number of quotes: the binder thinks it is
        // "inside quotes" and does not wrap.
        assert.equal(legacyBinderCommandLine(['{"title":"x y"}']), '{"title":"x y"}');
        // ...and on 5.1 an escaped quote counts too, so this is not wrapped
        // either (measured live: it then split at the space).
        assert.equal(legacyBinderCommandLine(['a\\"b c']), 'a\\"b c');
        // Whitespace before any quote: wrapped.
        assert.equal(legacyBinderCommandLine(['x y "z"']), '"x y "z""');
    });

    test('the OLD broken PowerShell form decodes to the corrupted argv a live member produced (quotes stripped)', () => {
        // What shQuote emitted before the fix for {"title":"x y"}: doubled
        // apostrophes only, bare double quotes.
        const oldForm = `'{"title":"x y","k":"it''s"}'`;
        const { value } = nextPowerShellStringLiteral(oldForm, 0);
        assert.equal(value, `{"title":"x y","k":"it's"}`);
        const argv = crtParseCommandLine(legacyBinderCommandLine([value]));
        assert.deepEqual(argv, [`{title:x y,k:it's}`], 'the simulator must reproduce the live corruption, or it proves nothing');
    });

    test('a value with BOTH whitespace and escaped quotes is split by the CRT -- the 5.1 limit shQuoteJson exists for', () => {
        // Measured on powershell.exe 5.1.19041: the binder counts `\"` toward
        // its quote parity and does not wrap this value, so the CRT splits it
        // (a node argv probe received ["a\"b", "c"]).
        const argv = crtParseCommandLine(legacyBinderCommandLine(['a\\"b c']));
        assert.deepEqual(argv, ['a"b', 'c']);
        // Which is exactly why a plain CRT pre-escape of a JSON payload with
        // spaces in it is NOT enough on its own:
        const naive = escapeForWindowsArgv('{"title":"x y"}');
        assert.notEqual(crtParseCommandLine(legacyBinderCommandLine([naive])).length, 1);
        // ...and why shQuoteJson removes the whitespace first.
        assert.equal(nativeArgFromPowerShellWord(shQuoteJson('{"title":"x y"}', 'windows', 'powershell5')), '{"title":"x\\u0020y"}');
    });
});

describe('shell-helpers: PowerShell dialect', () => {
    test('escapeForWindowsArgv: every run of n backslashes before a quote becomes 2n+1 backslashes + quote', () => {
        assert.equal(escapeForWindowsArgv('"'), '\\"');
        assert.equal(escapeForWindowsArgv('\\"'), '\\\\\\"');
        assert.equal(escapeForWindowsArgv('\\\\"'), '\\\\\\\\\\"');
        assert.equal(escapeForWindowsArgv('a\\nb'), 'a\\nb', 'a backslash not followed by a quote is untouched');
        assert.equal(escapeForWindowsArgv('trailing\\'), 'trailing\\');
    });

    test('shQuote: PowerShell dialect applies CRT escaping THEN apostrophe doubling; POSIX dialect is unchanged', () => {
        assert.equal(shQuote(`it's "x"`, 'windows', 'powershell5'), `'it''s \\"x\\"'`);
        assert.equal(shQuote(`it's "x"`, 'windows', ''), `'it''s \\"x\\"'`);
        assert.equal(shQuote(`it's "x"`, 'linux'), `'it'\\''s "x"'`);
        assert.equal(shQuote(`it's "x"`, 'windows', 'gitbash'), `'it'\\''s "x"'`);
    });

    test('shQuoteJson: PowerShell dialect leaves NO whitespace in the argument; the JSON still parses to the same object', () => {
        const json = JSON.stringify({ t: 'a b\u00a0c\u3000d', n: 'x\ny' });
        const quoted = shQuoteJson(json, 'windows', 'powershell5');
        const { value } = nextPowerShellStringLiteral(quoted, 0);
        assert.ok(!/\s/.test(value), `expected a whitespace-free argument, got: ${value}`);
        assert.deepEqual(JSON.parse(nativeArgFromPowerShellWord(quoted)), JSON.parse(json));
        // POSIX is byte-identical to a plain shQuote of the JSON.
        assert.equal(shQuoteJson(json, 'linux'), shQuote(json, 'linux'));
        assert.equal(shQuoteJson(json, 'windows', 'gitbash'), shQuote(json, 'windows', 'gitbash'));
    });

    for (const value of [
        '{"a":"b"}',
        'Content-Type: application/json',
        ":PAT'x",
        '\n%{http_code}',
        'no-quotes-no-space',
        'C:\\path\\with\\backslashes',
        // Whitespace BEFORE the first quote: the binder wraps, the CRT reads
        // the escaped quotes literally -- survives even without shQuoteJson.
        'leading words then a "quoted" tail',
    ]) {
        test(`shQuote round-trips ${JSON.stringify(value)} through binder + CRT as one argument`, () => {
            assert.equal(nativeArgFromPowerShellWord(shQuote(value, 'windows', 'powershell5')), value);
        });
    }
});

describe('builders: the -d payload curl.exe receives on a PowerShell member is the exact JSON the builder built', () => {
    for (const target of POWERSHELL_TARGETS) {
        test(`azure-devops create-pull-request (${target.label})`, () => {
            const built = buildCreatePrCommand({ ...ADO_PARAMS, os: target.os, shell: target.shell });
            const received = JSON.parse(nativeDashDPayload(built.command));
            assert.deepEqual(received, {
                sourceRefName: 'refs/heads/auto-sprint/feat-x',
                targetRefName: 'refs/heads/main',
                title: TITLE,
                description: BODY,
            });
        });

        test(`azure-devops comment (${target.label})`, () => {
            const built = buildCommentCommand({ ...ADO_PARAMS, pull_request_id: 7, os: target.os, shell: target.shell });
            const received = JSON.parse(nativeDashDPayload(built.command));
            assert.deepEqual(received, {
                comments: [{ parentCommentId: 0, content: BODY, commentType: 'text' }],
                status: 'active',
            });
        });

        test(`github create-pull-request (${target.label})`, () => {
            const built = buildCreatePrCommand({ ...GH_PARAMS, os: target.os, shell: target.shell });
            const received = JSON.parse(nativeDashDPayload(built.command));
            assert.deepEqual(received, { title: TITLE, head: 'auto-sprint/feat-x', base: 'main', body: BODY });
        });

        test(`github comment (${target.label})`, () => {
            const built = buildCommentCommand({ provider: 'github', repo: 'Apra-Labs/apra-fleet', issue_number: 7, body: BODY, token: 'ghs_tok', os: target.os, shell: target.shell });
            const received = JSON.parse(nativeDashDPayload(built.command));
            assert.deepEqual(received, { body: BODY });
        });
    }

    test('every other quoted word of the ADO command (auth, headers, -w) also arrives as exactly one argument', () => {
        const built = buildCreatePrCommand({ ...ADO_PARAMS, os: 'windows', shell: 'powershell5' });
        // Walk the command: PowerShell-parse each `'...'` word and run it
        // through the binder + CRT as its own argument.
        const words = [];
        let i = 0;
        while (i < built.command.length) {
            if (built.command[i] === "'") {
                const { value, end } = nextPowerShellStringLiteral(built.command, i);
                words.push(value);
                i = end;
            } else {
                i += 1;
            }
        }
        assert.ok(words.length >= 5, `expected the -u/-H/-H/-d/-w words, got ${words.length}`);
        for (const w of words) {
            assert.equal(crtParseCommandLine(legacyBinderCommandLine([w])).length, 1, `word split by the CRT: ${w}`);
        }
        assert.ok(words.includes(':PAT-TOKEN-abc123'));
        assert.ok(words.includes('Content-Type: application/json'));
        assert.ok(words.includes('\n%{http_code}'));
    });
});

// -----------------------------------------------------------------------------
// The real thing: on a Windows host, run the built `-d` word through the REAL
// powershell.exe (the same interpreter src/os/windows.ts cleanExec() spawns
// for a Windows member) into a node argv probe and compare what the child
// received. Skipped on non-Windows CI; the simulator above stands in there.
// -----------------------------------------------------------------------------
const hasPowerShell = process.platform === 'win32'
    && spawnSync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;

test('real powershell.exe: the built -d JSON word reaches a native child as one argument equal to the intended JSON',
    { skip: hasPowerShell ? false : 'requires a Windows host with powershell.exe' },
    () => {
        const built = buildCreatePrCommand({ ...ADO_PARAMS, os: 'windows', shell: 'powershell5' });
        const marker = ' -d ';
        const idx = built.command.indexOf(marker);
        const { end } = nextPowerShellStringLiteral(built.command, idx + marker.length);
        const dWord = built.command.slice(idx + marker.length, end);
        const expected = JSON.stringify({
            sourceRefName: 'refs/heads/auto-sprint/feat-x',
            targetRefName: 'refs/heads/main',
            title: TITLE,
            description: BODY,
        });
        const expectedB64 = Buffer.from(expected, 'utf8').toString('base64');
        // The probe reports argc and, when exactly one argument arrived, whether
        // it parses to the same JSON object as the expectation (which travels
        // base64-encoded so it never goes through the binder itself).
        const probe = 'node -e "const a=process.argv.slice(1);const e=JSON.parse(Buffer.from(a[a.length-1],\'base64\').toString(\'utf8\'));'
            + 'const got=a.slice(0,-1);let ok=false;try{ok=got.length===1&&JSON.stringify(JSON.parse(got[0]))===JSON.stringify(e);}catch(err){}'
            + 'console.log(\'argc=\'+got.length+\' \'+(ok?\'MATCH\':\'MISMATCH\'));if(!ok){console.log(\'got: \'+JSON.stringify(got));}" --';
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apra-fleet-ps-argv-'));
        try {
            const script = path.join(dir, 'probe.ps1');
            fs.writeFileSync(script, `${probe} ${dWord} ${expectedB64}\r\n`);
            const res = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8' });
            assert.equal(res.status, 0, `powershell.exe failed: ${res.stderr}`);
            assert.match(res.stdout, /^argc=1 MATCH/m, `real powershell.exe argv probe output:\n${res.stdout}`);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
