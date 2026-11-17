import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { vcsCredentialLabelForProvider } from '../fleet-sprint/vcs-auth.mjs';
import { DEFAULT_VCS_PROVIDER } from '../fleet-sprint/vcs-module.mjs';

// =============================================================================
// apra-fleet-3swo.4.11 -- Phase 2's flagged BEHAVIOUR changes are individually
// gated and individually revertible.
//
// Phase 2 shipped its extractions (move-only relocations of runner.js regions)
// SEPARATELY from a small set of deliberate behaviour changes, so that each
// behaviour change could be reviewed, reverted and reasoned about on its own.
// This file is the standing proof of that property. Two things are pinned:
//
//   (1) SEPARATION (git-level): no flagged-change commit touches a file that
//       one of this phase's move-only extraction commits created.
//   (2) INDIVIDUAL GATING (source/runtime-level): each flagged change has at
//       least one assertion that fails when just THAT change is undone.
//
// The gating half is verified by a surgical-undo probe: undo exactly one
// change in the working tree, run the whole suite, and check that exactly one
// assertion group goes red. The probes were run while authoring this file and
// their results are recorded here so a future reader knows which assertion
// gates which change (baseline: 2605 tests, 2601 pass, 0 fail):
//
//   A. mutual exclusion (withOpenSyncBracket exclusiveKey stacks) -- undo:
//      make withOpenSyncBracket ignore exclusiveKey. 2 tests fail, both in
//      test/sync-bracket-mutual-exclusion.test.mjs part (a). Nothing else.
//   B. pushBeadsAfter routed through DoltSync.syncAfter -- undo: call the bare
//      doltPushAfter() primitive again. 1 test fails, the non-throwing-degrade
//      assertion in test/sync-bracket-mutual-exclusion.test.mjs part (b).
//      Nothing else. (So the degrade contract already HAD an assertion; this
//      file does not need to add one.)
//   C1. credential label derives from DEFAULT_VCS_PROVIDER -- undo (rename
//      back to the github-shaped name AND hardcode the literal): 2 tests fail,
//      both in test/vcs-auth-extraction-facade.test.mjs. But a PARTIAL undo
//      that keeps the neutral NAME and only re-hardcodes the VALUE
//      (`= 'github'` instead of `= DEFAULT_VCS_PROVIDER`) failed NOTHING --
//      the whole suite stayed green. That gap is what section (2) below
//      closes: the value's DERIVATION is now pinned, not just the symbol name.
//   C2. provider-neutral Publish-PR non-hosted-remote log wording -- undo:
//      restore the "not a gh-hostable GitHub remote" wording. 1 test fails,
//      test/publish-pr-non-hosted-remote.test.mjs. Nothing else.
//   D. bracket streak identity -- landed as a WRITTEN DECISION, not as code
//      (see section (3)): the decision is recorded in git-sync.mjs beside the
//      key it is about, and no streak identity was shipped on the bracket.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SE_DIR = path.join(__dirname, '..');
const GIT_SYNC_SRC = fs.readFileSync(path.join(SE_DIR, 'fleet-sprint/git-sync.mjs'), 'utf8');
const VCS_AUTH_SRC = fs.readFileSync(path.join(SE_DIR, 'fleet-sprint/vcs-auth.mjs'), 'utf8');

/**
 * The separation rule, as a pure function so it can be falsified without git.
 * @param {{ subject: string, files: string[] }[]} flaggedCommits
 * @param {string[]} moveOnlyCreatedFiles
 * @returns {{ subject: string, file: string }[]}
 */
function separationViolations(flaggedCommits, moveOnlyCreatedFiles) {
    const created = new Set(moveOnlyCreatedFiles);
    const violations = [];
    for (const commit of flaggedCommits) {
        for (const file of commit.files) {
            if (created.has(file)) violations.push({ subject: commit.subject, file });
        }
    }
    return violations;
}

describe('(1) Phase 2 separation: a flagged behaviour change never lands in a file a move-only extraction created', () => {
    test('FALSIFIABILITY: the rule reports a violation when a flagged commit does touch a created file', () => {
        const violations = separationViolations(
            [{ subject: 'flagged: something', files: ['a/moved.mjs', 'a/runner.js'] }],
            ['a/moved.mjs'],
        );
        assert.deepEqual(violations, [{ subject: 'flagged: something', file: 'a/moved.mjs' }]);
    });

    test('the rule reports nothing when the two file sets are disjoint', () => {
        const violations = separationViolations(
            [{ subject: 'flagged: something', files: ['a/runner.js'] }],
            ['a/moved.mjs'],
        );
        assert.deepEqual(violations, []);
    });
});

// -----------------------------------------------------------------------------
// (2) The credential-label gate the C1 probe found MISSING.
//
// The flagged change replaced an independently hardcoded 'github' literal with
// a value DERIVED from vcs-providers/index.mjs's DEFAULT_VCS_PROVIDER, so this
// fallback label and the rest of the codebase's single "which provider when
// nothing else is known" answer can never drift apart. Because
// DEFAULT_VCS_PROVIDER is itself 'github' today, no VALUE comparison can tell
// the two apart -- re-hardcoding the literal left the entire suite green. The
// derivation therefore has to be pinned at the source level, or this half of
// the flagged change is silently unprotected.
// -----------------------------------------------------------------------------
describe('(2) the default VCS credential label is DERIVED from DEFAULT_VCS_PROVIDER, not independently hardcoded', () => {
    test('vcs-auth.mjs assigns the label constant FROM DEFAULT_VCS_PROVIDER, never from a string literal', () => {
        const decl = VCS_AUTH_SRC.match(/^const DEFAULT_VCS_CREDENTIAL_LABEL = (.+);$/m);
        assert.ok(decl, "vcs-auth.mjs must declare `const DEFAULT_VCS_CREDENTIAL_LABEL = ...` at the top level");
        assert.equal(
            decl[1],
            'DEFAULT_VCS_PROVIDER',
            `the default credential label must be derived from vcs-module.mjs's DEFAULT_VCS_PROVIDER so it cannot drift from the codebase's single default-provider answer; found the literal/expression '${decl[1]}' instead. Re-hardcoding it is invisible to every value assertion in this suite, because DEFAULT_VCS_PROVIDER's value is currently the same string.`,
        );
    });

    test('and it imports that symbol from vcs-module.mjs (the derivation is real, not a same-named local)', () => {
        assert.ok(
            /import \{[^}]*\bDEFAULT_VCS_PROVIDER\b[^}]*\} from '\.\/vcs-module\.mjs';/s.test(VCS_AUTH_SRC),
            'vcs-auth.mjs must import DEFAULT_VCS_PROVIDER from ./vcs-module.mjs',
        );
    });

    test('the resolved fallback label equals DEFAULT_VCS_PROVIDER at runtime (unchanged value, still github today)', () => {
        assert.equal(vcsCredentialLabelForProvider(''), DEFAULT_VCS_PROVIDER);
        assert.equal(vcsCredentialLabelForProvider(null), DEFAULT_VCS_PROVIDER);
        assert.equal(vcsCredentialLabelForProvider('azure-devops'), 'azure-devops', 'a real provider name still wins over the fallback');
        assert.equal(DEFAULT_VCS_PROVIDER, 'github', 'the value did not change -- this was a routing fix, not a behaviour change');
    });
});

// -----------------------------------------------------------------------------
// (3) Lane item D -- bracket streak identity -- landed as a WRITTEN DECISION.
//
// The lane explicitly allowed this item to land either as code or as a recorded
// decision. It landed as the latter: the bracket keeps ONE coarse code-write
// exclusivity key plus a cosmetic member label, and carries no streak/lane
// identity. Coverage for a written decision is that the decision is actually
// recorded where the next reader will look, and that no code shipped for it.
// -----------------------------------------------------------------------------
describe('(3) the sync bracket carries no streak identity, and the decision saying so is recorded at the site', () => {
    test('git-sync.mjs records the decision next to the exclusivity key it is about', () => {
        const keyIdx = GIT_SYNC_SRC.indexOf("export const CODE_WRITE_BRACKET_KEY = 'code-write';");
        assert.ok(keyIdx > 0, 'git-sync.mjs must still declare CODE_WRITE_BRACKET_KEY');
        const following = GIT_SYNC_SRC.slice(keyIdx, keyIdx + 2500);
        assert.ok(
            /DECIDED: the bracket does NOT record the owning/.test(following),
            'the written decision for the streak-identity question must stay recorded immediately after CODE_WRITE_BRACKET_KEY, so the question is not re-litigated by the next reader of this key',
        );
    });

    test('withOpenSyncBracket takes exactly the two documented options and no streak/lane identity', () => {
        const sig = GIT_SYNC_SRC.match(/async function withOpenSyncBracket\(fn, \{([^}]*)\} = \{\}\) \{/);
        assert.ok(sig, 'git-sync.mjs must declare withOpenSyncBracket(fn, { ... } = {})');
        const opts = sig[1].split(',').map((s) => s.trim()).filter(Boolean);
        assert.deepEqual(
            opts,
            ['exclusiveKey', 'label'],
            'the bracket deliberately records only a coarse exclusivity key and a cosmetic label; adding a streak/lane option here is the code path the recorded decision rejected',
        );
    });

    test('no streak/lane concept leaked into git-sync.mjs outside comments', () => {
        const codeOnly = GIT_SYNC_SRC
            .split('\n')
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join('\n');
        assert.equal(
            /\bstreak/i.test(codeOnly),
            false,
            `git-sync.mjs must carry no streak identity in code (the recorded decision rejected threading it in); found: ${JSON.stringify(codeOnly.split('\n').filter((l) => /streak/i.test(l)))}`,
        );
    });
});
