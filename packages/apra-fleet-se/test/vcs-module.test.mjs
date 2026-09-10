import { test, describe } from 'node:test';
import assert from 'node:assert';
import { VCSModule, buildCreatePrCommand, buildCommentCommand, resolveProvider } from '../fleet-sprint/vcs-module.mjs';
import { nativeDashDPayload } from './helpers/windows-argv.mjs';

// apra-fleet-tfx.7: orchestrator-side VCSModule -- provider-dispatched
// PR-creation command builder. Pure/deterministic: no network calls in this
// suite, only string-building assertions.

describe('VCSModule.buildCreatePrCommand', () => {
    test('builds the exact GitHub create-pull-request curl command', () => {
        const result = buildCreatePrCommand({
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            base: 'main',
            head: 'auto-sprint/feature-x',
            title: 'Auto-sprint: feature-x',
            body: 'PASS -- see report',
            token: 'ghs_abcdef123456',
        });

        const expectedPayload = JSON.stringify({
            title: 'Auto-sprint: feature-x',
            head: 'auto-sprint/feature-x',
            base: 'main',
            body: 'PASS -- see report',
        });

        const expectedCommand = [
            'curl -sS -X POST',
            `-H 'Authorization: Bearer ghs_abcdef123456'`,
            `-H 'Accept: application/vnd.github+json'`,
            `-H 'Content-Type: application/json'`,
            `-H 'X-GitHub-Api-Version: 2022-11-28'`,
            `-d '${expectedPayload}'`,
            `-w '\n%{http_code}'`,
            'https://api.github.com/repos/Apra-Labs/apra-fleet/pulls',
        ].join(' ');

        assert.strictEqual(result.command, expectedCommand);
        assert.strictEqual(result.provider, 'github');
        assert.strictEqual(result.action, 'create-pull-request');
        assert.deepStrictEqual(result.interpret, {
            successStatusRange: [200, 299],
            alreadyExistsStatus: 422,
            alreadyExistsPattern: 'already exists',
        });
    });

    test('doubles embedded single quotes (PowerShell-safe) when os is windows', () => {
        const result = buildCreatePrCommand({
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            base: 'main',
            head: 'auto-sprint/feature-x',
            title: "Fix doer's crash",
            token: 'ghs_abcdef123456',
            os: 'windows',
        });

        // PowerShell single-quoted strings escape an embedded ' by doubling
        // it (''), never via the POSIX '\'' close-reopen trick -- so the
        // JSON payload's apostrophe surfaces as "doer''s crash" and there is
        // no backslash-quote sequence anywhere in the built command.
        assert.ok(result.command.includes(`Fix\\u0020doer''s\\u0020crash`), `expected the doubled apostrophe (and \\u0020 for the spaces), got: ${result.command}`);
        assert.ok(!result.command.includes(`\\'`));
    });

    test('keeps POSIX close-reopen escaping when os is omitted or non-windows', () => {
        const posixParams = {
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            base: 'main',
            head: 'auto-sprint/feature-x',
            title: "Fix doer's crash",
            token: 'ghs_abcdef123456',
        };
        const withoutOs = buildCreatePrCommand(posixParams);
        const withLinux = buildCreatePrCommand({ ...posixParams, os: 'linux' });

        assert.strictEqual(withoutOs.command, withLinux.command);
        assert.ok(withoutOs.command.includes(`"Fix doer'\\''s crash"`));
    });

    test('omits body from the JSON payload when not supplied', () => {
        const result = buildCreatePrCommand({
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            base: 'main',
            head: 'feature-y',
            title: 'no body here',
            token: 'ghs_tok',
        });
        assert.ok(!result.command.includes('"body"'));
    });

    test('never echoes the raw token in logSafeCommand', () => {
        const result = buildCreatePrCommand({
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            base: 'main',
            head: 'feature-x',
            title: 't',
            token: 'ghs_super_secret_value',
        });
        assert.ok(!result.logSafeCommand.includes('ghs_super_secret_value'));
        assert.ok(result.logSafeCommand.includes('***REDACTED***'));
        // The real command is still fully usable for execution.
        assert.ok(result.command.includes('ghs_super_secret_value'));
        // Every other part of the command is identical between the two forms.
        assert.strictEqual(
            result.logSafeCommand.replace('***REDACTED***', 'ghs_super_secret_value'),
            result.command,
        );
    });

    test('never emits a gh CLI invocation or a create_pull_request reference', () => {
        const result = buildCreatePrCommand({
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            base: 'main',
            head: 'feature-x',
            title: 't',
            token: 'ghs_tok',
        });
        assert.ok(!/(^|\s)gh(\s|$)/.test(result.command));
        assert.ok(!result.command.includes('gh pr create'));
        assert.ok(!result.command.toLowerCase().includes('create_pull_request'));
        assert.ok(!result.logSafeCommand.toLowerCase().includes('create_pull_request'));
    });

    test('unsupported provider fails with an ASCII ERROR: message, not a wrong command', () => {
        assert.throws(
            () => buildCreatePrCommand({
                provider: 'bitbucket',
                repo: 'ws/repo',
                base: 'main',
                head: 'feature-x',
                title: 't',
                token: 'tok',
            }),
            (err) => err.message.startsWith('ERROR: VCSModule: '),
        );
        assert.throws(
            () => buildCreatePrCommand({
                provider: 'gitlab',
                repo: 'ws/repo',
                base: 'main',
                head: 'feature-x',
                title: 't',
                token: 'tok',
            }),
            (err) => err.message.startsWith('ERROR: VCSModule: unsupported VCS provider "gitlab"'),
        );
    });

    test('missing required fields fail with an ASCII ERROR: message', () => {
        assert.throws(
            () => buildCreatePrCommand({ provider: 'github', repo: 'Apra-Labs/apra-fleet', base: 'main', head: 'x', title: 't' }),
            (err) => err.message.startsWith('ERROR: VCSModule: no token supplied'),
        );
        assert.throws(
            () => buildCreatePrCommand({ provider: 'github', repo: 'not-a-repo', base: 'main', head: 'x', title: 't', token: 'tok' }),
            (err) => err.message.startsWith('ERROR: VCSModule: invalid repo'),
        );
        assert.throws(
            () => buildCreatePrCommand({ provider: 'github', repo: 'a/b', head: 'x', title: 't', token: 'tok' }),
            (err) => err.message.startsWith('ERROR: VCSModule: "base" branch is required'),
        );
    });

    test('is pure/deterministic -- identical input yields byte-identical output, no network access attempted', () => {
        const params = {
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            base: 'main',
            head: 'feature-x',
            title: 'deterministic test',
            body: 'body text',
            token: 'ghs_tok',
        };
        const a = buildCreatePrCommand(params);
        const b = buildCreatePrCommand(params);
        assert.deepStrictEqual(a, b);
    });
});

describe('VCSModule.buildCommentCommand', () => {
    test('builds a GitHub issue-comment curl command for annotating an existing PR on abort', () => {
        const result = buildCommentCommand({
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            issue_number: 42,
            body: 'Sprint aborted -- see run log.',
            token: 'ghs_tok',
        });
        assert.strictEqual(result.provider, 'github');
        assert.strictEqual(result.action, 'comment');
        assert.ok(result.command.includes('https://api.github.com/repos/Apra-Labs/apra-fleet/issues/42/comments'));
        assert.ok(result.command.includes('ghs_tok'));
        assert.ok(!result.logSafeCommand.includes('ghs_tok'));
        assert.ok(!result.command.toLowerCase().includes('create_pull_request'));
    });

    test('unsupported provider fails with an ASCII ERROR: message', () => {
        assert.throws(
            () => buildCommentCommand({ provider: 'azure-devops', repo: 'a/b', issue_number: 1, body: 'x', token: 'tok' }),
            (err) => err.message.startsWith('ERROR: VCSModule: '),
        );
    });

    test('doubles embedded single quotes (PowerShell-safe) when os is windows', () => {
        const result = buildCommentCommand({
            provider: 'github',
            repo: 'Apra-Labs/apra-fleet',
            issue_number: 42,
            body: "doer's step failed -- see run log.",
            token: 'ghs_tok',
            os: 'windows',
        });
        assert.ok(result.command.includes(`doer''s\\u0020step\\u0020failed`), `expected the doubled apostrophe (and \\u0020 for the spaces), got: ${result.command}`);
        assert.ok(!result.command.includes(`\\'`));
    });
});

// =============================================================================
// apra-fleet-ot2z.17: golden Windows vs POSIX commands for
// buildGitHubCreatePrCommand/buildGitHubCommentCommand, pinning the
// apra-fleet-ot2z.16 fix (curl.exe on Windows to dodge PowerShell's built-in
// `curl` -> Invoke-WebRequest alias) plus everything that fix must NOT
// change: redaction parity, apostrophe quoting, and the interpret contract.
// =============================================================================
describe('VCSModule GitHub PR/comment builders: Windows-safe curl (apra-fleet-ot2z.17)', () => {
    const prParams = {
        provider: 'github',
        repo: 'Apra-Labs/apra-fleet',
        base: 'main',
        head: 'auto-sprint/feature-x',
        title: 'Auto-sprint: feature-x',
        body: 'PASS -- see report',
        token: 'ghs_abcdef123456',
    };
    const commentParams = {
        provider: 'github',
        repo: 'Apra-Labs/apra-fleet',
        issue_number: 42,
        body: 'Sprint aborted -- see run log.',
        token: 'ghs_tok',
    };

    const prPayload = JSON.stringify({
        title: 'Auto-sprint: feature-x',
        head: 'auto-sprint/feature-x',
        base: 'main',
        body: 'PASS -- see report',
    });
    const commentPayload = JSON.stringify({ body: 'Sprint aborted -- see run log.' });

    // Golden strings, item 1: pin the pre-existing POSIX shape (bare `curl`)
    // as a true before/after regression pin -- these must stay byte-identical
    // to what the suite already asserted for buildCreatePrCommand's default
    // (os-omitted) case above, and to buildCommentCommand's os:'linux' case.
    const expectedPrLinux = [
        'curl -sS -X POST',
        `-H 'Authorization: Bearer ghs_abcdef123456'`,
        `-H 'Accept: application/vnd.github+json'`,
        `-H 'Content-Type: application/json'`,
        `-H 'X-GitHub-Api-Version: 2022-11-28'`,
        `-d '${prPayload}'`,
        `-w '\n%{http_code}'`,
        'https://api.github.com/repos/Apra-Labs/apra-fleet/pulls',
    ].join(' ');
    const expectedCommentLinux = [
        'curl -sS -X POST',
        `-H 'Authorization: Bearer ghs_tok'`,
        `-H 'Accept: application/vnd.github+json'`,
        `-H 'Content-Type: application/json'`,
        `-H 'X-GitHub-Api-Version: 2022-11-28'`,
        `-d '${commentPayload}'`,
        `-w '\n%{http_code}'`,
        'https://api.github.com/repos/Apra-Labs/apra-fleet/issues/42/comments',
    ].join(' ');

    // Golden strings, item 2: the Windows shape differs in the curl token
    // (`curl.exe`, the real binary, not the PowerShell curl->Invoke-WebRequest
    // alias) AND in the -d payload: the PowerShell dialect CRT-escapes every
    // JSON double quote (\") and rewrites literal whitespace inside the JSON
    // as \u0020 so Windows PowerShell 5.1's legacy native-argument binder
    // cannot split or de-quote it (see shell-helpers.mjs shQuoteJson and
    // test/vcs-powershell-argv-roundtrip.test.mjs). Headers carry no quotes
    // and stay byte-identical.
    const psJson = (json) => json.replace(/"/g, '\\"').replace(/ /g, '\\u0020');
    const expectedPrWindows = expectedPrLinux
        .replace(/^curl /, 'curl.exe ')
        .replace(`-d '${prPayload}'`, `-d '${psJson(prPayload)}'`);
    const expectedCommentWindows = expectedCommentLinux
        .replace(/^curl /, 'curl.exe ')
        .replace(`-d '${commentPayload}'`, `-d '${psJson(commentPayload)}'`);

    // A bare `curl` token (not followed by `.exe`) is exactly what PowerShell
    // aliases to Invoke-WebRequest -- assert it is categorically absent from
    // the Windows command, word-boundary-anchored so `curl.exe` itself does
    // not false-positive.
    const BARE_CURL_RE = /\bcurl\b(?!\.exe)/;

    describe('create-pull-request', () => {
        test('golden POSIX command (os: linux) is unchanged by the curl.exe fix', () => {
            const result = buildCreatePrCommand({ ...prParams, os: 'linux' });
            assert.strictEqual(result.command, expectedPrLinux);
        });

        test('golden Windows command (os: windows) emits curl.exe, never a bare curl token', () => {
            const result = buildCreatePrCommand({ ...prParams, os: 'windows' });
            assert.strictEqual(result.command, expectedPrWindows);
            assert.ok(!BARE_CURL_RE.test(result.command), `Expected no bare curl token in: ${result.command}`);
            assert.ok(result.command.startsWith('curl.exe '));
        });

        test('redaction parity holds on both os branches', () => {
            for (const os of ['linux', 'windows']) {
                const result = buildCreatePrCommand({ ...prParams, os });
                assert.ok(!result.logSafeCommand.includes('ghs_abcdef123456'), `os=${os}: raw token leaked into logSafeCommand`);
                assert.ok(result.logSafeCommand.includes('***REDACTED***'), `os=${os}: expected the REDACTED literal`);
                assert.strictEqual(
                    result.logSafeCommand.replace('***REDACTED***', 'ghs_abcdef123456'),
                    result.command,
                    `os=${os}: logSafeCommand must equal command with only the token substring replaced`,
                );
            }
        });

        test('apostrophe in title/body still quotes correctly on Windows after the curl.exe change', () => {
            const result = buildCreatePrCommand({
                ...prParams,
                title: "Fix doer's crash",
                os: 'windows',
            });
            assert.ok(result.command.startsWith('curl.exe '));
            assert.ok(result.command.includes(`Fix\\u0020doer''s\\u0020crash`), `expected the doubled apostrophe (and \\u0020 for the spaces), got: ${result.command}`);
            assert.ok(!result.command.includes(`\\'`));
        });

        test('interpret contract (successStatusRange, alreadyExistsStatus, alreadyExistsPattern) is identical on both os branches', () => {
            const linux = buildCreatePrCommand({ ...prParams, os: 'linux' });
            const windows = buildCreatePrCommand({ ...prParams, os: 'windows' });
            const expectedInterpret = {
                successStatusRange: [200, 299],
                alreadyExistsStatus: 422,
                alreadyExistsPattern: 'already exists',
            };
            assert.deepStrictEqual(linux.interpret, expectedInterpret);
            assert.deepStrictEqual(windows.interpret, expectedInterpret);
            // The publish path parses the trailing HTTP status this -w flag
            // appends; confirm the Windows command still carries it.
            assert.ok(windows.command.includes(`-w '\n%{http_code}'`));
        });
    });

    describe('comment', () => {
        test('golden POSIX command (os: linux) is unchanged by the curl.exe fix', () => {
            const result = buildCommentCommand({ ...commentParams, os: 'linux' });
            assert.strictEqual(result.command, expectedCommentLinux);
        });

        test('golden Windows command (os: windows) emits curl.exe, never a bare curl token', () => {
            const result = buildCommentCommand({ ...commentParams, os: 'windows' });
            assert.strictEqual(result.command, expectedCommentWindows);
            assert.ok(!BARE_CURL_RE.test(result.command), `Expected no bare curl token in: ${result.command}`);
            assert.ok(result.command.startsWith('curl.exe '));
        });

        test('redaction parity holds on both os branches', () => {
            for (const os of ['linux', 'windows']) {
                const result = buildCommentCommand({ ...commentParams, os });
                assert.ok(!result.logSafeCommand.includes('ghs_tok'), `os=${os}: raw token leaked into logSafeCommand`);
                assert.ok(result.logSafeCommand.includes('***REDACTED***'), `os=${os}: expected the REDACTED literal`);
                assert.strictEqual(
                    result.logSafeCommand.replace('***REDACTED***', 'ghs_tok'),
                    result.command,
                    `os=${os}: logSafeCommand must equal command with only the token substring replaced`,
                );
            }
        });

        test('apostrophe in body still quotes correctly on Windows after the curl.exe change', () => {
            const result = buildCommentCommand({
                ...commentParams,
                body: "doer's step failed -- see run log.",
                os: 'windows',
            });
            assert.ok(result.command.startsWith('curl.exe '));
            assert.ok(result.command.includes(`doer''s\\u0020step\\u0020failed`), `expected the doubled apostrophe (and \\u0020 for the spaces), got: ${result.command}`);
            assert.ok(!result.command.includes(`\\'`));
        });

        test('interpret contract (successStatusRange) is identical on both os branches', () => {
            const linux = buildCommentCommand({ ...commentParams, os: 'linux' });
            const windows = buildCommentCommand({ ...commentParams, os: 'windows' });
            const expectedInterpret = { successStatusRange: [200, 299] };
            assert.deepStrictEqual(linux.interpret, expectedInterpret);
            assert.deepStrictEqual(windows.interpret, expectedInterpret);
            assert.ok(windows.command.includes(`-w '\n%{http_code}'`));
        });
    });
});

// =============================================================================
// Shell-vs-OS quoting matrix: shQuote must dispatch on the member's registered
// SHELL, not the bare OS. A Windows member running Git-for-Windows bash needs
// POSIX quoting ('\''); the PowerShell doubled-quote form ('') is read by bash
// as close-then-reopen, silently deleting the apostrophe from the curl -d JSON
// payload -- confirmed live as GitHub answering "HTTP 400: Problems parsing
// JSON" on the create-PR endpoint. pwsh7/powershell5 and the unresolved-shell
// ('') fallback on Windows must stay byte-identical to the historical os-only
// behavior; non-Windows os must stay POSIX regardless of shell.
// =============================================================================
describe('VCSModule GitHub builders: quoting dialect follows the member shell, not the OS', () => {
    const title = `Fix "it's broken"`;
    const body = "the doer's step failed -- see run log";
    const prParams = {
        provider: 'github',
        repo: 'Apra-Labs/apra-fleet',
        base: 'main',
        head: 'fix/quoting',
        title,
        body,
        token: 'ghs_tok',
    };
    const commentParams = {
        provider: 'github',
        repo: 'Apra-Labs/apra-fleet',
        issue_number: 7,
        body,
        token: 'ghs_tok',
    };

    // Recover the single argv word following ` -d ` under the given shell's
    // single-quote rules, so the assertions below prove what the member's
    // shell would actually hand to curl -- not just what substrings the
    // command text contains.
    //   posix:      '...' regions are literal; \x outside quotes escapes x
    //               (covers the '\'' close-escape-reopen idiom).
    //   powershell: inside a '...' region, '' is a literal single quote.
    function parseShellWord(cmd, startIdx, dialect) {
        let i = startIdx;
        let out = '';
        while (i < cmd.length && cmd[i] !== ' ') {
            if (cmd[i] === "'") {
                i += 1;
                while (i < cmd.length) {
                    if (cmd[i] === "'") {
                        if (dialect === 'powershell' && cmd[i + 1] === "'") {
                            out += "'";
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    out += cmd[i];
                    i += 1;
                }
                i += 1; // consume the closing quote
            } else if (dialect === 'posix' && cmd[i] === '\\') {
                out += cmd[i + 1];
                i += 2;
            } else {
                out += cmd[i];
                i += 1;
            }
        }
        return out;
    }

    function extractDashDArg(command, dialect) {
        const idx = command.indexOf(' -d ');
        assert.notEqual(idx, -1, `expected a -d flag in: ${command}`);
        return parseShellWord(command, idx + 4, dialect);
    }

    test('windows + gitbash: POSIX quoting -- the -d payload survives bash parsing as the exact JSON', () => {
        const result = buildCreatePrCommand({ ...prParams, os: 'windows', shell: 'gitbash' });
        // curl binary token stays OS-keyed: still curl.exe on Windows.
        assert.ok(result.command.startsWith('curl.exe '), `expected curl.exe for a windows member, got: ${result.command}`);
        // POSIX close-escape-reopen idiom present, exactly the linux shape.
        assert.ok(result.command.includes(`'\\''`), `expected POSIX '\\'' quoting for a gitbash member, got: ${result.command}`);
        const linux = buildCreatePrCommand({ ...prParams, os: 'linux' });
        assert.strictEqual(result.command, linux.command.replace(/^curl /, 'curl.exe '), 'windows+gitbash must be the POSIX command with only the curl token swapped');
        // The real-world trigger: bash-parse the -d word back and confirm
        // GitHub's JSON parser would accept it, apostrophe intact.
        const payload = extractDashDArg(result.command, 'posix');
        const parsed = JSON.parse(payload);
        assert.strictEqual(parsed.title, title);
        assert.strictEqual(parsed.body, body);
    });

    test('windows + gitbash: comment builder gets the same POSIX quoting', () => {
        const result = buildCommentCommand({ ...commentParams, os: 'windows', shell: 'gitbash' });
        assert.ok(result.command.startsWith('curl.exe '));
        const linux = buildCommentCommand({ ...commentParams, os: 'linux' });
        assert.strictEqual(result.command, linux.command.replace(/^curl /, 'curl.exe '));
        const parsed = JSON.parse(extractDashDArg(result.command, 'posix'));
        assert.strictEqual(parsed.body, body);
    });

    test('the pinned defect: bash-parsing the PowerShell-dialect payload corrupts the JSON', () => {
        const legacy = buildCreatePrCommand({ ...prParams, os: 'windows' });
        // What curl.exe receives from PowerShell (correct JSON) -- through
        // the binder + CRT stages, not just PowerShell's own string parser...
        const psView = nativeDashDPayload(legacy.command);
        assert.strictEqual(JSON.parse(psView).title, title);
        // ...is NOT what bash hands to curl from the same string: the doubled
        // quote collapses to nothing under POSIX rules, losing the apostrophe.
        const bashView = extractDashDArg(legacy.command, 'posix');
        assert.notStrictEqual(bashView, psView);
        let bashTitle = null;
        try {
            bashTitle = JSON.parse(bashView).title;
        } catch {
            bashTitle = null; // outright unparseable is the live 400 case
        }
        assert.notStrictEqual(bashTitle, title, 'bash-parsing the PowerShell-dialect payload must not reproduce the intended title');
    });

    test('windows + pwsh7/powershell5: byte-identical to the os-only windows output (doubled apostrophes, CRT-escaped double quotes)', () => {
        const legacy = buildCreatePrCommand({ ...prParams, os: 'windows' });
        assert.ok(legacy.command.includes(`it''s`), `expected PowerShell doubled-quote escaping, got: ${legacy.command}`);
        assert.ok(legacy.command.includes(`\\"title\\"`), `expected CRT-escaped JSON double quotes, got: ${legacy.command}`);
        for (const shell of ['pwsh7', 'powershell5']) {
            const result = buildCreatePrCommand({ ...prParams, os: 'windows', shell });
            assert.strictEqual(result.command, legacy.command, `shell=${shell} must keep the PowerShell shape byte-identical`);
            const comment = buildCommentCommand({ ...commentParams, os: 'windows', shell });
            assert.strictEqual(comment.command, buildCommentCommand({ ...commentParams, os: 'windows' }).command, `shell=${shell} comment builder must keep the PowerShell shape byte-identical`);
        }
        const parsed = JSON.parse(nativeDashDPayload(legacy.command));
        assert.strictEqual(parsed.title, title);
        assert.strictEqual(parsed.body, body);
    });

    test('windows + unresolved shell (empty string / undefined) keeps the PowerShell-dialect fallback unchanged', () => {
        const legacy = buildCreatePrCommand({ ...prParams, os: 'windows' });
        const withEmpty = buildCreatePrCommand({ ...prParams, os: 'windows', shell: '' });
        assert.strictEqual(withEmpty.command, legacy.command, 'an unresolved shell on Windows must degrade to the PowerShell dialect, not to POSIX');
        assert.ok(withEmpty.command.includes(`it''s`));
        assert.strictEqual(buildCommentCommand({ ...commentParams, os: 'windows', shell: '' }).command, buildCommentCommand({ ...commentParams, os: 'windows' }).command);
    });

    test('non-windows os stays POSIX regardless of shell', () => {
        const bare = buildCreatePrCommand({ ...prParams, os: 'linux' });
        assert.ok(bare.command.includes(`'\\''`));
        assert.strictEqual(buildCreatePrCommand({ ...prParams, os: 'linux', shell: '' }).command, bare.command);
        const parsed = JSON.parse(extractDashDArg(bare.command, 'posix'));
        assert.strictEqual(parsed.title, title);
    });
});

describe('VCSModule default export', () => {
    test('exposes the same builders as the named exports', () => {
        assert.strictEqual(VCSModule.buildCreatePrCommand, buildCreatePrCommand);
        assert.strictEqual(VCSModule.buildCommentCommand, buildCommentCommand);
        assert.strictEqual(VCSModule.resolveProvider, resolveProvider);
    });
});

// =============================================================================
// VCSModule.resolveProvider (apra-fleet-647.1.2.1) -- reads a member's
// persisted vcsProvider from the fleet member registry via an injected
// fleetApi.memberDetail(), with NO default and NO guessing. A dedicated
// [test]-typed sibling bead (apra-fleet-647.1.2.2) owns the full runner.js
// call-site coverage (both provision_vcs_auth callers going through this);
// this suite exercises resolveProvider() itself, directly and in isolation.
// =============================================================================
describe('VCSModule.resolveProvider', () => {
    function fleetApiReturning(vcsProvider) {
        return {
            memberDetail: async () => ({ content: [{ text: JSON.stringify({ vcsProvider }) }] }),
        };
    }

    test('a member registered with GitHub resolves to provider "github" and its GitHub App auth mode', async () => {
        const result = await resolveProvider('fleet-mac', { fleetApi: fleetApiReturning('github') });
        assert.deepEqual(result, { provider: 'github', authMode: 'github-app' });
    });

    test('an absent vcsProvider (member never provisioned) throws an ASCII "ERROR:" naming the member and the known providers -- never defaults to GitHub', async () => {
        await assert.rejects(
            () => resolveProvider('fleet-mac', { fleetApi: fleetApiReturning(undefined) }),
            (err) => {
                assert.match(err.message, /^ERROR:/);
                assert.match(err.message, /fleet-mac/);
                assert.match(err.message, /github, bitbucket, azure-devops/);
                return true;
            },
        );
    });

    test('an unrecognized provider string throws an ASCII "ERROR:" naming the member, never silently coerced to a known provider', async () => {
        await assert.rejects(
            () => resolveProvider('fleet-mac', { fleetApi: fleetApiReturning('gitlab') }),
            /ERROR:.*fleet-mac/,
        );
    });

    test('memberDetail() call failure (e.g. fleet server unreachable) propagates as a typed "ERROR:" rejection, not a silent GitHub default', async () => {
        const fleetApi = { memberDetail: async () => { throw new Error('fleet server unreachable'); } };
        await assert.rejects(
            () => resolveProvider('fleet-mac', { fleetApi }),
            (err) => {
                assert.match(err.message, /^ERROR:/);
                assert.match(err.message, /fleet server unreachable/);
                return true;
            },
        );
    });

    test('a non-JSON memberDetail() response (e.g. "no member found") surfaces that text verbatim, not a generic parse error', async () => {
        const fleetApi = { memberDetail: async () => ({ content: [{ text: 'no member found matching "ghost"' }] }) };
        await assert.rejects(
            () => resolveProvider('ghost', { fleetApi }),
            /no member found matching "ghost"/,
        );
    });

    test('requires an injected fleetApi.memberDetail() -- throws a clear "ERROR:" rather than crashing on a missing method', async () => {
        await assert.rejects(
            () => resolveProvider('fleet-mac', {}),
            /ERROR:.*memberDetail/,
        );
    });

    test('a non-GitHub known provider (bitbucket) resolves to that provider with a null auth mode (no separate mode axis)', async () => {
        const result = await resolveProvider('fleet-mac', { fleetApi: fleetApiReturning('bitbucket') });
        assert.deepEqual(result, { provider: 'bitbucket', authMode: null });
    });
});
