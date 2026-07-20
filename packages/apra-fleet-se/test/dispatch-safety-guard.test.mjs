import { test } from 'node:test';
import assert from 'node:assert';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkPath } from '../auto-sprint/dispatch-safety-guard.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// apra-fleet-eft.3.1 (Plan Part 1.6) -- Dispatch-safety guard test.
//
// Invariant under test: EVERY `command(` / `agent(` call site in
// packages/apra-fleet-se/auto-sprint/runner.js must supply an explicit
// `member_name` (or `member_id`) in its options object. The workflow engine
// throws if neither is supplied, with no local-execution/"ambient member"
// fallback -- this test locks that invariant in at the source level so a
// future edit cannot silently introduce a call site that omits it (which
// would only surface at runtime, on a real fleet dispatch, in whatever
// heterogeneous-member topology happens to be running that day).
//
// This is a real (bracket-aware) call-site parse, not a naive line grep:
// each `command(`/`agent(` token is paired with its matching closing paren
// (skipping over string/template-literal contents so parens embedded in a
// shell command string, e.g. `${beadIds.join(' ')}`, can never be
// mis-attributed as call-site punctuation), and the resulting call-site
// text is checked for `member_name`/`member_id`. Full-line comments (a line
// whose trimmed text starts with `//` or `*`, i.e. JSDoc/line-comment
// bodies) are skipped so comments that merely MENTION `command()`/`agent()`
// prose-style (there are many in runner.js) are never counted as call
// sites.
//
// Baseline (verified against current HEAD by manual review of every site
// this parser finds, packages/apra-fleet-se/auto-sprint/runner.js as of
// apra-fleet-eft.3.1): 20 command() call sites and 9 agent() call sites,
// all 29 compliant. (The parent feature's description cites an earlier
// "12 command() / 9 agent()" audit figure; the file has grown call sites
// since that audit was written, e.g. finalizeAbort()'s two command() sites
// and bdListScoped()'s two command() sites. This test asserts the CURRENT,
// re-verified count so it passes on current HEAD, per its own acceptance
// criteria -- an out-of-date fixed number would defeat the test's purpose
// of catching real drift.) If this test's baseline counts need to change,
// that is a deliberate, reviewable signal: either a call site was added
// (bump the count, after confirming member_name/member_id is present) or
// one was silently dropped (an actual regression -- do NOT just bump the
// count without checking why).
//
// apra-fleet-eft.3.3: the checker itself (findCallSites/checkPath) now lives
// in ../auto-sprint/dispatch-safety-guard.mjs, exported and parameterizable
// by file path, so it can be pointed at a fixture that deliberately violates
// the invariant -- proving the guard actually fails on a non-compliant call
// site rather than vacuously passing -- WITHOUT mutating runner.js to
// manufacture that failure case. See the fixture-driven tests below, which
// exercise test/fixtures/dispatch-safety/{non-compliant,member-id-only}.mjs.
// =============================================================================

const RUNNER_PATH = path.join(__dirname, '../auto-sprint/runner.js');
// Branch-split convention (established when the three auto-sprint
// stabilization fixes -- auto-sprint-9's branch-adopt fix, auto-sprint-3's
// bdListScoped rewrite, and the failSoft-discrimination follow-up -- were
// moved to feat/fleet-reorg and this branch was rebased on top of it):
// feat/fleet-reorg carries only those stabilization fixes and has NO
// eft-feature-specific runner.js additions, so ITS copy of this test asserts
// 18 command() sites. THIS branch (auto-sprint/eft-service) additionally
// carries eft-feature work (e.g. finalizeAbort()'s two dispatch sites,
// supervisor-skeleton additions) on top of that same base. Do not resolve a
// future count mismatch between the two branches by just copying one
// branch's number into the other -- confirm which commits actually
// introduced the delta first.
//
// Bumped 21 -> 22 (2026-07-18): commit 6d348f1a (apra-fleet-eft.8.1,
// syncMemberBefore/syncMemberAfter G-pull/G-push helpers) added exactly one
// new real command() call site (the injected `command(cmd, { member_name:
// member, ... })` inside runGitStep()), verified compliant. That commit's
// two `throw new Error("... requires an injected command() in opts")`
// lines are NOT call sites -- they were a false-positive in this test's own
// parser (the literal text "command()" inside a plain string), fixed here
// via isInsideSameLineString().
// Bumped 22 -> 25 (2026-07-18, apra-fleet-eft.9.1 + eft.8.x sync helpers):
// three new real command() call sites, each verified to carry an explicit
// member_name (3.2): (1) runDoltStep()'s injected `command(cmd, { member_name:
// member, silent: true, failSoft: true, label })` -- the single site every
// D-pull/D-push bracket funnels through; (2) verifyDoerStreakClosed()'s
// post-D-pull `command(label, { member_name: orchestratorMember, silent:
// true })` verification read; and (3) the syncMemberAfter clean-state restore
// `command('git rebase --abort', { member_name: member, ... })` /
// `command('git status --porcelain', { member_name: member, ... })` pair
// (these two land on adjacent lines but the parser counts them as the two
// distinct call sites they are). The `throw new Error("... requires an
// injected command() in opts")` lines added alongside the dolt helpers are,
// as before, string-literal false positives excluded by
// isInsideSameLineString(), not call sites.
// Bumped 25 -> 26 (2026-07-19): finalizeAbort() gained a `git fetch origin
// ${baseBranch}` command() site (member_name: member) so its subsequent
// `git rev-list --count origin/${baseBranch}..${branch}` diffs against a
// remote-tracking ref instead of assuming `baseBranch` is a resolvable
// LOCAL ref on the abort-path member -- a real abort hit exit 128 ("unknown
// revision") when the member never had that base branch checked out
// locally under that exact name, verified compliant.
// 26 -> 28: Ensure Sprint Branch gained a dirty-tree recovery path
// (stabilization log Issue 11) -- one `git stash push -u` site and one
// post-stash checkout retry site, both with explicit member_name. The
// happy path issues neither.
// 28 -> 29 (apra-fleet-eft.9.7): per-bead work-claiming inside the D-pull/
// D-push brackets gained one new `command(claimLabel, { member_name:
// orchestratorMember, silent: true })` call site (the `bd update <id>
// --claim` issued per bead before a doer streak dispatch), verified
// compliant.
// 29 -> 28 (apra-fleet-eft.8.12, git conflict ladder Tier 2): the Tier 1
// scripted detect-and-abort helper (detectAndAbortRebaseConflict, with its
// `git rebase --abort` and post-abort `git status --porcelain` command()
// pair) moved out of runner.js entirely into ./conflict-ladder.mjs (-2 real
// sites from THIS file's count -- conflict-ladder.mjs is outside
// RUNNER_PATH's scan scope, not a regression); runner.js gained exactly one
// new real command() site in its place, the Tier 2 post-resolution
// clean-state check `command('git status --porcelain', { member_name:
// member, silent: true, failSoft: true, label })` inside syncMemberAfter
// (+1), net -1. Verified compliant (explicit member_name).
const EXPECTED_COMMAND_COUNT = 28;
// Bumped 9 -> 10 (2026-07-18): the doer max_turns-exhaustion resume path
// (dispatchDoerResume) adds one new agent() call site -- a resume-and-continue
// dispatch on the SAME session with an escalated max_turns, verified compliant
// with member_name.
// 10 -> 11: dispatchReview() gained a reviewer resume-and-continue agent()
// site (stabilization log Issue 9, mirrors the doer's dispatchDoerResume);
// member_name confirmed present via shared reviewerDispatchOpts.
// 11 -> 12 (stabilization log iteration 5): Final Review gained a
// resume-and-continue agent() site (dispatchFinalReviewResume), same
// shape as the doer/reviewer resume paths; member_name literal confirmed.
// 12 -> 13: Streak Assignment gained a bounded semantic-repair re-ask
// site (one corrective re-dispatch when the candidate is schema-valid but
// semantically rejected, e.g. run 8's suffix-stripped bead ids);
// member_name literal confirmed.
const EXPECTED_AGENT_COUNT = 14;

// findCallSites/extractBalancedCall/skipStringLiteral/isInsideSameLineString
// and the path-parameterized checkPath() checker now live in
// ../auto-sprint/dispatch-safety-guard.mjs (apra-fleet-eft.3.3), imported
// above, so they can be reused against fixture files below without
// duplicating the parser here.

test('every command()/agent() call site in runner.js passes member_name or member_id', () => {
    const { sites, violations } = checkPath(RUNNER_PATH);

    const commandSites = sites.filter((s) => s.fnName === 'command');
    const agentSites = sites.filter((s) => s.fnName === 'agent');

    // Baseline counts asserted explicitly: a future edit that silently
    // DROPS a call site (e.g. a refactor that inlines a dispatch behind a
    // helper this parser can no longer see) changes these counts even
    // though every remaining site is individually compliant, and must be
    // caught rather than passing silently.
    assert.strictEqual(
        commandSites.length,
        EXPECTED_COMMAND_COUNT,
        `Expected ${EXPECTED_COMMAND_COUNT} command() call site(s) in runner.js, found ${commandSites.length}. ` +
        `If a call site was intentionally added or removed, update EXPECTED_COMMAND_COUNT after confirming ` +
        `every site still passes member_name/member_id.`
    );
    assert.strictEqual(
        agentSites.length,
        EXPECTED_AGENT_COUNT,
        `Expected ${EXPECTED_AGENT_COUNT} agent() call site(s) in runner.js, found ${agentSites.length}. ` +
        `If a call site was intentionally added or removed, update EXPECTED_AGENT_COUNT after confirming ` +
        `every site still passes member_name/member_id.`
    );

    assert.deepStrictEqual(
        violations,
        [],
        `Found ${violations.length} dispatch-safety violation(s):\n${violations.join('\n')}`
    );
});

// =============================================================================
// apra-fleet-eft.3.3 -- prove the guard can actually FAIL, not just pass
// vacuously against a hand-verified-compliant runner.js. These tests point
// the same checkPath() checker at fixtures under test/fixtures/dispatch-
// safety/ instead of runner.js.
// =============================================================================

const NON_COMPLIANT_FIXTURE = path.join(__dirname, 'fixtures/dispatch-safety/non-compliant.mjs');
const MEMBER_ID_ONLY_FIXTURE = path.join(__dirname, 'fixtures/dispatch-safety/member-id-only.mjs');

test('checker reports a violation naming the fixture and its line for a member_name-less call site', () => {
    const { sites, violations } = checkPath(NON_COMPLIANT_FIXTURE);

    assert.strictEqual(sites.length, 1, 'expected exactly one call site in the fixture');
    assert.strictEqual(sites[0].fnName, 'command');

    assert.strictEqual(violations.length, 1, `expected exactly one violation, got: ${JSON.stringify(violations)}`);
    assert.match(violations[0], /^non-compliant\.mjs:13 \(command\(\)\) is missing member_name\/member_id$/);
});

test('checker accepts a call site carrying member_id only (not a violation)', () => {
    const { sites, violations } = checkPath(MEMBER_ID_ONLY_FIXTURE);

    assert.strictEqual(sites.length, 1, 'expected exactly one call site in the fixture');
    assert.deepStrictEqual(violations, [], `expected no violations, got: ${JSON.stringify(violations)}`);
});
