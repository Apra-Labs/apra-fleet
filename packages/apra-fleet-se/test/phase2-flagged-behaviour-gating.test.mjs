import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
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
const REPO_ROOT = path.join(SE_DIR, '../..');
const GIT_SYNC_SRC = fs.readFileSync(path.join(SE_DIR, 'fleet-sprint/git-sync.mjs'), 'utf8');
const VCS_AUTH_SRC = fs.readFileSync(path.join(SE_DIR, 'fleet-sprint/vcs-auth.mjs'), 'utf8');

// -----------------------------------------------------------------------------
// Commit identification.
//
// Commits are located by SUBJECT LINE, not by SHA: a rebase of this long-lived
// refactor branch rewrites every SHA but preserves subjects. Bead ids are not
// usable as the key -- only some of these commits mention one in their body.
//
// apra-fleet-3swo.23: the lookup used to be a fixed depth-limited `git log`
// window (five hundred commits back from HEAD), which failed in two ways as
// this branch grew -- (1) after a squash merge every subject vanishes and ALL
// FIVE git-level checks below silently skip, silently losing the separation
// guarantee, and (2) once the phase scrolled past that fixed depth with only
// SOME of the six subjects still inside the window, the group stayed
// "enabled" and the per-subject `shas.length === 1` assertion hard-failed on
// whichever subjects had scrolled out -- a spurious red suite unrelated to
// the actual separation invariant.
//
// FIX DIRECTION CHOSEN: make the lookup UNBOUNDED (no depth limit at all; see
// shasForSubject() below) and gate the git-level checks on ALL SIX subjects
// resolving, not merely one. As long as these commits remain ancestors of
// HEAD in a normal (non-squashed, non-shallow) clone, an unbounded `git log`
// finds them regardless of how many further commits land on top -- there is
// no depth to scroll past, so failure mode (2) cannot recur. A squash merge
// or shallow clone still makes all six subjects unreachable, but now as a
// single named GROUP skip (see HISTORY_SKIP below) rather than a partial,
// misleading hard failure.
//
// REJECTED: (a) merge-base-anchored range -- this branch is itself
// periodically rebased onto its base (see role-policies-table.test.mjs's own
// rebase history notes), so pinning a merge-base ref here would need to name
// a specific, moving base and would still fail identically to the unbounded
// approach the moment these six commits are squashed away; it adds an anchor
// to maintain for no extra robustness. (b) a tree-level assertion -- section
// (1)'s SEPARATION guarantee is inherently a git-HISTORY property (which
// commit's diff touched which file); once history is squashed into one
// commit, that information is gone from the tree itself and cannot be
// recovered by inspecting the final files, so a tree-level check could not
// actually verify the same guarantee, only a different and weaker one. An
// explicit, named skip is the honest signal in that case, which is why AC3
// treats it as an acceptable alternative to a tree-level check.
// -----------------------------------------------------------------------------

// The flagged BEHAVIOUR changes of this phase. Items A and B shipped in ONE
// commit (they were authored together and both edit git-sync.mjs), which is
// exactly why the per-change probes above are surgical working-tree undos
// rather than `git revert`s: no commit-level revert can separate A from B.
const FLAGGED_CHANGE_SUBJECTS = [
    'feat(fleet-sprint): sync-bracket mutual-exclusion detection + route Final Review D-push through DoltSync.syncAfter',
    'feat(fleet-sprint): remove last two GitHub-shaped residues from shared VCS code',
    'docs(fleet-sprint): record why the sync bracket does not carry streak identity',
];

// This phase's MOVE-ONLY extraction commits -- the ones whose whole reviewable
// claim is "these bodies moved verbatim, nothing observable changed".
//
// Deliberately NOT in this list: "extract git-sync.mjs so withGitSync owns the
// pause-bracket counter". That commit is an extraction, but it is not a
// move-only one: its task exists to CLOSE two unbracketed-push holes by
// construction (a pause could previously land mid-push), it therefore has its
// own dedicated behaviour [test] sibling, and it rewrote the expectations of
// three pre-existing test files -- none of which a move-only relocation does.
// It is the module the later flagged sync-layer changes are built ON, so
// counting it here would make the separation check below unsatisfiable by
// construction rather than meaningful.
const MOVE_ONLY_EXTRACTION_SUBJECTS = [
    'feat(fleet-sprint): extract coordination.mjs and kb.mjs move-only from runner.js',
    'feat(fleet-sprint): extract beads-scope.mjs with an explicit snapshot invalidation contract',
    'feat(fleet-sprint): extract beads-transitions.mjs and close the unguarded Re-Review verdict site',
];

const git = (args) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });

/** @returns {string[]} every commit SHA whose subject is exactly `subject`. */
function shasForSubject(subject) {
    // Unbounded: no `-N` depth limit (apra-fleet-3swo.23 -- see the header
    // comment above for why a fixed window is wrong here). `git log` with no
    // depth argument walks the FULL history reachable from HEAD in a normal,
    // non-shallow clone, so a commit already an ancestor of HEAD is found
    // regardless of how many commits have landed on top of it since.
    const out = git(['log', '--format=%H%x1f%s']);
    return out
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('\x1f'))
        .filter(([, s]) => s === subject)
        .map(([sha]) => sha);
}

const filesTouchedBy = (sha) => git(['show', '--name-only', '--format=', sha]).split('\n').filter(Boolean);
const filesCreatedBy = (sha) => git(['show', '--name-only', '--diff-filter=A', '--format=', sha]).split('\n').filter(Boolean);

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

// Resolved once: a checkout that squash-merged or shallow-cloned this phase
// has none of these commits, and the git-level assertions below say so
// explicitly instead of passing vacuously.
//
// apra-fleet-3swo.23 (AC2): gated on ALL SIX subjects resolving, not on ANY
// resolving. With the window now unbounded, a normal clone either finds every
// one of the six (they are all ancestors of HEAD, full stop) or a history
// rewrite (squash merge, shallow clone) has made every one of them
// unreachable together -- there is no longer a "some found, some not" state
// that a fixed depth window used to produce. The group therefore runs
// entirely or skips entirely: no reachable state fires the per-subject
// `shas.length === 1` assertion against a subject that is simply missing.
const flaggedShas = new Map(FLAGGED_CHANGE_SUBJECTS.map((s) => [s, shasForSubject(s)]));
const moveOnlyShas = new Map(MOVE_ONLY_EXTRACTION_SUBJECTS.map((s) => [s, shasForSubject(s)]));
const allSubjectShas = [...flaggedShas, ...moveOnlyShas];
const TOTAL_SUBJECTS = allSubjectShas.length;
const foundCount = allSubjectShas.filter(([, shas]) => shas.length > 0).length;
const HISTORY_AVAILABLE = foundCount === TOTAL_SUBJECTS;
const HISTORY_SKIP = HISTORY_AVAILABLE
    ? null
    : foundCount === 0
        ? "the Phase 2 commit-level SEPARATION guarantee (section 1 below) was not evaluated: none of this phase's " +
          `${TOTAL_SUBJECTS} flagged-change/move-only commits are reachable from HEAD (a squash merge, shallow ` +
          'clone, or history rewrite made them all unreachable), so the commit-level checks cannot run here'
        : "the Phase 2 commit-level SEPARATION guarantee (section 1 below) was not evaluated: only " +
          `${foundCount}/${TOTAL_SUBJECTS} of this phase's flagged-change/move-only commits are reachable from ` +
          `HEAD (missing: ${allSubjectShas.filter(([, shas]) => shas.length === 0).map(([s]) => `'${s}'`).join(', ')}) ` +
          '-- the group either runs in full or skips in full, so a partial match never fires the per-subject assertion below';

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

    test('every flagged-change and move-only commit of this phase is present exactly once in history', (t) => {
        if (!HISTORY_AVAILABLE) return t.skip(HISTORY_SKIP);
        for (const [subject, shas] of [...flaggedShas, ...moveOnlyShas]) {
            assert.equal(
                shas.length,
                1,
                `expected exactly one commit with subject '${subject}', found ${shas.length}. Partial presence means the phase history drifted (a commit was reworded, dropped or duplicated) -- update the subject tables at the top of this file to match.`,
            );
        }
    });

    test('the move-only extraction commits really did create new modules (guards against a vacuous empty set)', (t) => {
        if (!HISTORY_AVAILABLE) return t.skip(HISTORY_SKIP);
        const created = [...moveOnlyShas.values()].flat().flatMap(filesCreatedBy);
        const createdModules = created.filter((f) => /^packages\/apra-fleet-se\/fleet-sprint\/[^/]+\.mjs$/.test(f));
        assert.ok(
            createdModules.length >= 4,
            `expected this phase's move-only extractions to have created at least 4 fleet-sprint modules, got: ${JSON.stringify(createdModules)}`,
        );
    });

    test('no flagged-change commit touches any file the move-only extractions created', (t) => {
        if (!HISTORY_AVAILABLE) return t.skip(HISTORY_SKIP);
        const moveOnlyCreated = [...moveOnlyShas.values()].flat().flatMap(filesCreatedBy);
        const flaggedCommits = [...flaggedShas].flatMap(([subject, shas]) => shas.map((sha) => ({ subject, files: filesTouchedBy(sha) })));
        assert.ok(flaggedCommits.every((c) => c.files.length > 0), 'each flagged commit must touch at least one file');
        const violations = separationViolations(flaggedCommits, moveOnlyCreated);
        assert.deepEqual(
            violations,
            [],
            `a flagged behaviour change landed inside a file a move-only extraction of this same phase created, which destroys the "the move PR is a pure move" review property: ${JSON.stringify(violations, null, 2)}`,
        );
    });

    test('and no flagged-change commit is itself an extraction (none of them creates a fleet-sprint module)', (t) => {
        if (!HISTORY_AVAILABLE) return t.skip(HISTORY_SKIP);
        for (const [subject, shas] of flaggedShas) {
            for (const sha of shas) {
                const createdModules = filesCreatedBy(sha).filter((f) => /^packages\/apra-fleet-se\/fleet-sprint\/.+\.mjs$/.test(f));
                assert.deepEqual(
                    createdModules,
                    [],
                    `flagged behaviour commit '${subject}' also performed an extraction (created ${JSON.stringify(createdModules)}) -- behaviour changes and moves must ship apart`,
                );
            }
        }
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

    test('the streak-identity commit shipped documentation only -- no behaviour, in one file', (t) => {
        if (!HISTORY_AVAILABLE) return t.skip(HISTORY_SKIP);
        const shas = flaggedShas.get('docs(fleet-sprint): record why the sync bracket does not carry streak identity');
        assert.equal(shas.length, 1, 'expected exactly one commit recording the streak-identity decision');
        const files = filesTouchedBy(shas[0]);
        assert.deepEqual(files, ['packages/apra-fleet-se/fleet-sprint/git-sync.mjs']);
        const diff = git(['show', '--format=', '--unified=0', shas[0]]);
        const changed = diff
            .split('\n')
            .filter((line) => /^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line));
        const removed = changed.filter((line) => line.startsWith('-'));
        assert.deepEqual(removed, [], 'a written decision must not remove any line of code');
        const nonComment = changed
            .map((line) => line.slice(1))
            .filter((line) => line.trim() !== '' && !/^\s*(\/\/|\*|\/\*)/.test(line));
        assert.deepEqual(
            nonComment,
            [],
            `the streak-identity decision landed as a written decision, so its commit must add comment lines only -- these added lines are not comments: ${JSON.stringify(nonComment)}`,
        );
    });
});
