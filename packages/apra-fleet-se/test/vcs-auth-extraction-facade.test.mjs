import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Namespace imports on purpose: a STATIC named import of a moved symbol would
// turn a dropped re-export into a module-load SyntaxError that kills this whole
// file before assertion (1) can run and name the missing symbol. Reading the
// symbols off the namespace keeps the failure inside the assertion that
// diagnoses it. Every runner.js-sourced symbol below is therefore reached via
// `runner.<name>`.
import * as runner from '../fleet-sprint/runner.js';
import * as vcsAuth from '../fleet-sprint/vcs-auth.mjs';
import { classifyFailure, toGitVerdict, VCS_FAILURE_KINDS } from '../fleet-sprint/vcs-module.mjs';
import { SprintPlanRejectedError } from '../fleet-sprint/errors.mjs';

// =============================================================================
// apra-fleet-3swo.3.2 -- prove the vcs-auth.mjs extraction (apra-fleet-3swo.3.1)
// was behaviour-identical and that runner.js's facade over it is intact.
//
// The extraction was MOVE-ONLY: the VCS/LLM auth region left runner.js for
// fleet-sprint/vcs-auth.mjs with byte-identical bodies. Nothing observable was
// supposed to change, which is exactly the class of refactor that fails
// silently -- a dropped re-export only breaks at the importer, and a
// behaviour drift in the provider/credential chain only shows up on a live
// fleet. These tests pin the observable surface instead.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SE_DIR = path.join(__dirname, '..');
const REPO_ROOT = path.join(SE_DIR, '../..');
const VCS_AUTH_SRC = fs.readFileSync(path.join(SE_DIR, 'fleet-sprint/vcs-auth.mjs'), 'utf8');
const RUNNER_SRC = fs.readFileSync(path.join(SE_DIR, 'fleet-sprint/runner.js'), 'utf8');

// -----------------------------------------------------------------------------
// (1) EVERY symbol the extraction moved, enumerated explicitly -- not spot-checked.
//
// PUBLIC: exported by runner.js BEFORE the move, so every one of them must
// still be importable from fleet-sprint/runner.js under its original name, or
// an existing importer of runner.js breaks. PRIVATE: module-private inside the
// moved region before the move (raiseVcsPrForMember and
// PR_SKIPPED_NO_MCP_CLIENT are exported by vcs-auth.mjs only so runner.js can
// keep consuming them) -- they must NOT have become part of runner.js's public
// surface, and they must live in vcs-auth.mjs now.
//
// These lists are literal on purpose: deriving them from the module under test
// would make the assertion tautological (a symbol dropped from both sides would
// still "pass").
// -----------------------------------------------------------------------------
const MOVED_PUBLIC_SYMBOLS = [
    'parseOwnerRepoFromRemoteUrl',
    'parseRepoScopeFromRemoteUrl',
    'vcsCredentialLabelForProvider',
    'buildCredentialReadCommand',
    'createMemberVcsProviderResolver',
    'createVcsAuthSelfHealCallback',
    'createVcsAuthPreflightCallback',
    'createLlmAuthSelfHealCallback',
];

const MOVED_PRIVATE_SYMBOLS = [
    'listCredentialStoreNames',
    'buildProvisionArgsForProvider',
    'selfHealResultText',
    // apra-fleet-3swo.13: added after the move-only extraction, so it is not
    // one of the ORIGINALLY-moved symbols above -- but it is module-private
    // to vcs-auth.mjs (never exported by runner.js) exactly like its
    // MOVED_PRIVATE_SYMBOLS siblings, so it belongs in this list rather than
    // a third bucket.
    'provisionOutcome',
    // Landed on main (register-member VCS-provider self-heal) while this
    // branch had already moved provisionVcsAuthForMember out of runner.js;
    // the rebase carried main's dispatch-time self-heal into vcs-auth.mjs
    // alongside its caller. Like 'provisionOutcome' above it is module-private
    // to vcs-auth.mjs and never exported by runner.js.
    'detectVcsProviderFromRemote',
    'provisionVcsAuthForMember',
    'provisionPrCapableAuthForMember',
    'GITHUB_VCS_CREDENTIAL_LABEL',
    'PR_SKIPPED_NO_MCP_CLIENT',
    'readMemberVcsCredentialToken',
    'parseVcsCurlOutput',
    'PR_AUTH_404_TEXT_RE',
    'isPrAuthFailure',
    'raiseVcsPrForMember',
    'parseExpiresAtFromProvisionText',
    'VCS_AUTH_EXPIRY_PREFLIGHT_MS',
];

const declaresTopLevel = (src, name) =>
    new RegExp(`^(?:export )?(?:async )?(?:function|const) ${name}\\b`, 'm').test(src);

describe('(1) the runner.js facade re-exports every symbol the vcs-auth extraction moved', () => {
    for (const name of MOVED_PUBLIC_SYMBOLS) {
        test(`runner.js still exports '${name}', and it IS vcs-auth.mjs's implementation`, () => {
            assert.equal(
                typeof runner[name],
                'function',
                `'${name}' was exported by runner.js before the vcs-auth extraction and must still be importable from fleet-sprint/runner.js under that exact name -- deleting its re-export line breaks every existing importer.`,
            );
            assert.equal(
                runner[name],
                vcsAuth[name],
                `runner.js's '${name}' must be the SAME binding vcs-auth.mjs exports (a re-export), not a second copy left behind in runner.js.`,
            );
            assert.equal(runner[name].name, name, `'${name}' must keep its original name`);
        });
    }

    test('all 8 previously-exported symbols are covered by this enumeration', () => {
        assert.equal(MOVED_PUBLIC_SYMBOLS.length, 8);
        assert.equal(new Set(MOVED_PUBLIC_SYMBOLS).size, 8, 'no duplicates in the enumeration');
    });

    for (const name of MOVED_PRIVATE_SYMBOLS) {
        test(`'${name}' moved into vcs-auth.mjs and did not leak into runner.js's public surface`, () => {
            assert.ok(
                declaresTopLevel(VCS_AUTH_SRC, name),
                `'${name}' was part of the moved region and must be declared at the top level of vcs-auth.mjs`,
            );
            assert.ok(
                !declaresTopLevel(RUNNER_SRC, name),
                `'${name}' must NOT still be declared in runner.js -- a leftover copy means the extraction duplicated behaviour instead of moving it.`,
            );
            assert.equal(
                runner[name],
                undefined,
                `'${name}' was module-private before the move and must not become part of runner.js's public export surface.`,
            );
        });
    }

    test('every moved symbol is accounted for: the two lists cover all 24 top-level declarations in vcs-auth.mjs', () => {
        const declared = [...VCS_AUTH_SRC.matchAll(/^(?:export )?(?:async )?(?:function|const) ([A-Za-z_][A-Za-z0-9_]*)/gm)]
            .map((m) => m[1]);
        const enumerated = new Set([...MOVED_PUBLIC_SYMBOLS, ...MOVED_PRIVATE_SYMBOLS]);
        const unlisted = declared.filter((n) => !enumerated.has(n));
        assert.deepEqual(
            unlisted,
            [],
            `vcs-auth.mjs declares symbol(s) this test does not enumerate: ${unlisted.join(', ')}. Add them to MOVED_PUBLIC_SYMBOLS/MOVED_PRIVATE_SYMBOLS (and re-export them from runner.js if they were public before the move).`,
        );
        assert.equal(declared.length, enumerated.size, 'the enumeration and vcs-auth.mjs must agree symbol-for-symbol');
    });
});

// -----------------------------------------------------------------------------
// (2) The golden transcripts still reproduce byte-for-byte, WITHOUT UPDATE_GOLDEN.
//
// Run as a child process on purpose: UPDATE_GOLDEN is read from the
// environment by golden-transcript.test.mjs, so the only way to prove the
// fixtures are not being rewritten is to run those tests in an environment
// where that variable is provably absent, then check the fixture directory is
// still clean in git.
// -----------------------------------------------------------------------------
describe('(2) golden transcripts reproduce with the fixture directory untouched', () => {
    test('both golden transcript suites pass without UPDATE_GOLDEN and leave test/fixtures/golden-transcript clean', () => {
        const before = execFileSync('git', ['status', '--porcelain', '--', 'packages/apra-fleet-se/test/fixtures/golden-transcript'], { cwd: REPO_ROOT, encoding: 'utf8' });
        assert.equal(
            before.trim(),
            '',
            `the golden fixture directory must be clean BEFORE this test runs, otherwise the after-check proves nothing. Dirty entries:\n${before}`,
        );

        const env = { ...process.env };
        delete env.UPDATE_GOLDEN;
        assert.equal(env.UPDATE_GOLDEN, undefined, 'UPDATE_GOLDEN must be unset for the child run');

        execFileSync(
            process.execPath,
            ['--test', 'test/golden-transcript.test.mjs', 'test/golden-transcript-3bead.test.mjs'],
            { cwd: SE_DIR, env, encoding: 'utf8', stdio: 'pipe' },
        );

        const after = execFileSync('git', ['status', '--porcelain', '--', 'packages/apra-fleet-se/test/fixtures/golden-transcript'], { cwd: REPO_ROOT, encoding: 'utf8' });
        assert.equal(
            after.trim(),
            '',
            `running the golden transcript suites must not rewrite any fixture file. git reported:\n${after}`,
        );
    });
});

// -----------------------------------------------------------------------------
// (3) The PR-skip path still returns the exact typed marker string.
//
// finalizeAbort() degrades to this marker when no MCP client is wired to mint
// a push+pr credential. Tests (and callers) discriminate this BENIGN skip from
// a genuine PR failure by the exact string, so it is pinned as a literal here
// rather than compared against the constant it is built from.
// -----------------------------------------------------------------------------
describe('(3) the no-MCP-client PR skip still returns pr-skipped-no-mcp-client', () => {
    test('finalizeAbort with no callTool returns the exact typed marker, with the branch still pushed', async () => {
        const dispatched = [];
        const command = async (cmd, opts = {}) => {
            dispatched.push(cmd);
            const ok = (output) => (opts.failSoft ? { ok: true, output, error: null } : output);
            if (/^git fetch origin\b/.test(cmd)) return ok('');
            if (/^git rev-list --count\b/.test(cmd)) return ok('2');
            if (/^git push\b/.test(cmd)) return ok('To mock-remote\n * [new branch] (mocked)');
            if (/^git remote get-url origin\b/.test(cmd)) return ok('https://github.com/mock-org/mock-repo.git');
            throw new Error(`unexpected command dispatched in this scenario: '${cmd}'`);
        };

        const result = await runner.finalizeAbort({
            error: new SprintPlanRejectedError('Plan rejected after 3 rounds', { cycle: 1 }),
            branch: 'auto-sprint/vcs-auth-extraction-skip',
            baseBranch: 'main',
            member: 'mock-member',
            command,
            log: () => {},
            // callTool deliberately omitted: this IS the degradation path.
        });

        assert.equal(result.reason, 'pr-skipped-no-mcp-client');
        assert.equal(result.prUrl, null);
        assert.equal(result.pushed, true);
        assert.ok(
            dispatched.some((c) => /^git push\b/.test(c)),
            'the abort branch must still be pushed even though the PR was skipped',
        );
    });
});

// -----------------------------------------------------------------------------
// (4) resolveMemberProvider survived the move with its provider-chain
// resolution (and its per-member caching) intact.
//
// A BARE TF401019 -- no generic git-auth tail -- so the verdict can only come
// from azure-devops.mjs's own rule, reached because the member's provider was
// resolved through the moved resolver rather than defaulting to github.
// -----------------------------------------------------------------------------
describe('(4) an Azure DevOps failure classified through the member provider chain maps TF401019 to AUTH_DENIED', () => {
    const TF401019_BARE = "remote: TF401019: The Git repository with name or identifier 'core' does not exist, or you do not have permission to perform this operation.";

    test('the moved resolver resolves the member to azure-devops, and that provider classifies TF401019 as AUTH_DENIED', async () => {
        const calls = [];
        const callTool = async (name, args) => {
            calls.push({ name, args });
            if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'azure-devops' }) }] };
            throw new Error(`unexpected callTool: ${name}`);
        };

        const resolveMemberProvider = runner.createMemberVcsProviderResolver({ callTool });
        const provider = await resolveMemberProvider('azdo-member');
        assert.equal(provider, 'azure-devops');

        const classified = classifyFailure(TF401019_BARE, { provider });
        assert.equal(classified.kind, VCS_FAILURE_KINDS.AUTH_DENIED);
        assert.equal(toGitVerdict(classified.kind), 'auth');

        // The same text WITHOUT the member's resolved provider falls back to
        // the default chain and does NOT reach the rule -- which is what makes
        // the resolution above load-bearing rather than incidental.
        assert.notEqual(classifyFailure(TF401019_BARE).kind, VCS_FAILURE_KINDS.AUTH_DENIED);

        // Caching is part of the moved contract: a repeat lookup must not
        // issue a second member_detail round trip.
        await resolveMemberProvider('azdo-member');
        assert.equal(calls.length, 1, `expected exactly one member_detail call for a repeated lookup, got: ${JSON.stringify(calls)}`);
    });
});

// -----------------------------------------------------------------------------
// (5) No moved symbol assumes a Claude-specific (or any single-provider)
// credential shape.
//
// getProvider() defaults to claude only for a null/undefined argument, and
// there is no gemini adapter -- so anything in this module that branched on an
// LLM provider's credential shape would be a live bug. The credential label is
// the one place a provider name reaches the filesystem, so it is exercised
// with non-github, non-claude providers end to end.
// -----------------------------------------------------------------------------
describe('(5) the moved credential helpers stay provider-generic', () => {
    for (const provider of ['azure-devops', 'bitbucket', 'gitlab']) {
        test(`vcsCredentialLabelForProvider('${provider}') yields that provider's own label, and the read command targets its own helper file`, () => {
            const label = runner.vcsCredentialLabelForProvider(provider);
            assert.equal(label, provider);

            const posix = runner.buildCredentialReadCommand({ os: 'linux', shell: 'bash' }, label);
            assert.match(posix.descriptor, new RegExp(`\\.fleet-git-credential-${provider}$`));
            assert.ok(posix.command.includes(`.fleet-git-credential-${provider}`), `the POSIX read command must target the '${provider}' helper, got: ${posix.command}`);
        });
    }

    test("only a missing/blank provider falls back to the historical 'github' default", () => {
        assert.equal(runner.vcsCredentialLabelForProvider(undefined), 'github');
        assert.equal(runner.vcsCredentialLabelForProvider(null), 'github');
        assert.equal(runner.vcsCredentialLabelForProvider('   '), 'github');
        assert.equal(runner.vcsCredentialLabelForProvider('github'), 'github');
    });

    test('vcs-auth.mjs names no LLM provider at all -- no claude/gemini-specific credential shape survived the move', () => {
        const offenders = ['claude', 'gemini', 'codex', 'copilot', 'opencode']
            .filter((name) => new RegExp(name, 'i').test(VCS_AUTH_SRC));
        assert.deepEqual(
            offenders,
            [],
            `vcs-auth.mjs must stay agnostic of LLM provider adapters; found reference(s) to: ${offenders.join(', ')}`,
        );
    });
});
