import path from 'path';
import fs from 'fs/promises';
import os from 'os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBdJson, checkMemberTopology, computeBranchSlug, buildHarvesterPrompt } from '../auto-sprint/runner.js';
import { checkHarvesterContract, buildMockFleetApi, teardown, withScenarioMarkers } from './helpers/mock-sprint-harness.mjs';

const check = (cond, msg) => assert.ok(cond, msg);

// =============================================================================
// apra-fleet-unw.17 (A5) acceptance criterion 6: bd JSON noise produces a
// diagnostic error naming the command, not a bare SyntaxError
// =============================================================================
test('parseBdJson: noisy (non-JSON) bd output produces a diagnostic error, not a bare SyntaxError', () => {
    let bdJsonNoiseError = null;
    try {
        parseBdJson('WARN: some deprecation notice\n[]', 'bd list --parent bd-1 --ready --json');
    } catch (err) {
        bdJsonNoiseError = err;
    }
    check(!!bdJsonNoiseError, 'Expected parseBdJson() to throw on noisy (non-JSON) bd output');
    check(
        !(bdJsonNoiseError instanceof SyntaxError),
        `Expected a diagnostic Error, not a bare SyntaxError, got: ${bdJsonNoiseError ? bdJsonNoiseError.constructor.name : 'n/a'}`
    );
    check(
        bdJsonNoiseError && bdJsonNoiseError.message.includes("bd list --parent bd-1 --ready --json"),
        `Expected the diagnostic error to name the offending command, got: ${bdJsonNoiseError ? bdJsonNoiseError.message : 'n/a'}`
    );
    check(
        bdJsonNoiseError && bdJsonNoiseError.message.includes('WARN: some deprecation notice'),
        `Expected the diagnostic error to include a raw-output snippet, got: ${bdJsonNoiseError ? bdJsonNoiseError.message : 'n/a'}`
    );
});

// =============================================================================
// apra-fleet-unw2.4 (N4): the multi-member topology precondition
// (checkMemberTopology, the pure helper bin/cli.mjs wires to
// `git rev-parse HEAD` per member) refuses to start when the members'
// identity signals disagree, and trivially passes for a single member.
// =============================================================================
test('checkMemberTopology: single member trivially passes without calling getIdentity', async () => {
    const topoSingle = await checkMemberTopology({
        members: ['solo'],
        getIdentity: async () => { throw new Error('getIdentity must not be called for a single-member sprint'); },
    });
    check(topoSingle.ok && topoSingle.singleMember, `Single-member topology must trivially pass, got: ${JSON.stringify(topoSingle)}`);
});

test('checkMemberTopology: members sharing an identity signal pass and are not flagged single-member', async () => {
    const topoAgree = await checkMemberTopology({ members: ['m1', 'm2'], getIdentity: async () => 'deadbeef\n' });
    check(topoAgree.ok && !topoAgree.singleMember, `Members sharing an identity signal must pass, got: ${JSON.stringify(topoAgree)}`);
});

test('checkMemberTopology: disagreeing identity signals refuse to start, naming both members and signals', async () => {
    const topoMismatch = await checkMemberTopology({
        members: ['m1', 'm2'],
        getIdentity: async (m) => (m === 'm1' ? 'aaaaaaa' : 'bbbbbbb'),
    });
    check(!topoMismatch.ok, 'Topology check MUST refuse to start when member identity signals disagree');
    check(
        /refus/i.test(topoMismatch.message) && topoMismatch.message.includes('m1') && topoMismatch.message.includes('m2') &&
        topoMismatch.message.includes('aaaaaaa') && topoMismatch.message.includes('bbbbbbb'),
        `Topology mismatch message must clearly refuse and name the divergent members/signals, got: ${topoMismatch.message}`
    );
});

test('checkMemberTopology: an unresolvable identity signal refuses to start, naming the failing member', async () => {
    const topoErr = await checkMemberTopology({
        members: ['m1', 'm2'],
        getIdentity: async (m) => { if (m === 'm2') throw new Error('not a git repository'); return 'aaaaaaa'; },
    });
    check(!topoErr.ok, 'Topology check MUST refuse when a member identity signal cannot be obtained');
    check(
        topoErr.message.includes('m2') && /not a git repository/.test(topoErr.message),
        `Topology unresolved-signal message must name the failing member and reason, got: ${topoErr.message}`
    );
});

// =============================================================================
// apra-fleet-unw2.22 (N12 follow-up) regression 1: the harvester
// contract check must genuinely fail when analysisText/costAnalysis/
// analysisArtifactFile are blank, not merely check for the STATIC
// instructional label text buildHarvesterPrompt() always emits. This
// is a scratch-edit-and-revert proof against the REAL, exported
// buildHarvesterPrompt() from runner.js (not a hand-rolled
// reimplementation of its format in the test) -- mirroring how the
// original finding proved the pre-fix regex was weak by forcing
// costAnalysis = '' in runner.js and observing the mock still reported
// OK.
// =============================================================================
test('checkHarvesterContract: hardened check catches blank analysisText/costAnalysis/analysisArtifactFile', async () => {
    await withScenarioMarkers('harvester-contract-check hardening regression', async () => {
        console.log('Running harvester-contract-check hardening regression (blank analysisText/costAnalysis/analysisArtifactFile)...');
        const realArgs = {
            branch: 'auto-sprint/regression-check',
            baseBranch: 'main',
            targetIssues: ['bd-1'],
            analysisArtifactFile: 'docs/sprint-analysis-auto-sprint-regression-check-deadbeef.md',
            analysisText: '# Sprint Analysis: auto-sprint/regression-check\n\nCycles run: 3.\n\nFinal verdict: PASS.',
            costAnalysis: 'Budget ceiling: $5.0000. Tracked spend: $1.2500. Remaining budget: $3.7500.',
        };

        // "Revert" case first (real, non-trivial content): the hardened check
        // must still pass a genuinely well-formed prompt.
        const realPrompt = buildHarvesterPrompt(realArgs);
        check(
            checkHarvesterContract(realPrompt).length === 0,
            `Hardened harvester contract check must PASS a real, non-blank prompt, got missing: ${JSON.stringify(checkHarvesterContract(realPrompt))}`
        );

        // Scratch-edit: force costAnalysis blank, as the original finding did
        // directly in runner.js. Everything else stays real/non-trivial.
        const blankCostAnalysis = buildHarvesterPrompt({ ...realArgs, costAnalysis: '' });
        const blankCostAnalysisMissing = checkHarvesterContract(blankCostAnalysis);
        check(
            blankCostAnalysisMissing.includes('costAnalysis'),
            `Hardened harvester contract check must report 'costAnalysis' as missing when runner.js emits a blank costAnalysis, got: ${JSON.stringify(blankCostAnalysisMissing)}`
        );

        // Scratch-edit: force analysisText blank.
        const blankAnalysisText = buildHarvesterPrompt({ ...realArgs, analysisText: '' });
        const blankAnalysisTextMissing = checkHarvesterContract(blankAnalysisText);
        check(
            blankAnalysisTextMissing.includes('analysisText'),
            `Hardened harvester contract check must report 'analysisText' as missing when runner.js emits a blank analysisText, got: ${JSON.stringify(blankAnalysisTextMissing)}`
        );

        // Scratch-edit: force a near-blank (whitespace-only) analysisText --
        // proves the check is a real content-length assertion, not just a
        // non-empty-string check.
        const whitespaceOnlyAnalysisText = buildHarvesterPrompt({ ...realArgs, analysisText: '   \n  ' });
        const whitespaceOnlyMissing = checkHarvesterContract(whitespaceOnlyAnalysisText);
        check(
            whitespaceOnlyMissing.includes('analysisText'),
            `Hardened harvester contract check must report 'analysisText' as missing when it is whitespace-only, got: ${JSON.stringify(whitespaceOnlyMissing)}`
        );

        // Scratch-edit: force analysisArtifactFile blank. This specifically
        // regression-tests the unanchored-\s* bug: the pre-fix regex
        // (/analysisArtifactFile:\s*\S+/) would skip over the blank value AND
        // the following blank-line paragraph break, matching into the next
        // paragraph's "analysisText" word instead -- silently passing.
        const blankArtifactFile = buildHarvesterPrompt({ ...realArgs, analysisArtifactFile: '' });
        const blankArtifactFileMissing = checkHarvesterContract(blankArtifactFile);
        check(
            blankArtifactFileMissing.includes('analysisArtifactFile'),
            `Hardened harvester contract check must report 'analysisArtifactFile' as missing when runner.js emits a blank analysisArtifactFile (regression test for the unanchored \\s* bug), got: ${JSON.stringify(blankArtifactFileMissing)}`
        );

        // "Revert": build the prompt again with everything real -- confirms the
        // hardened check passes again once the values are restored, exactly
        // like the scratch-edit-and-revert methodology used to prove the
        // original bug.
        const revertedPrompt = buildHarvesterPrompt(realArgs);
        check(
            checkHarvesterContract(revertedPrompt).length === 0,
            `Hardened harvester contract check must PASS again once all inputs are reverted to real content, got missing: ${JSON.stringify(checkHarvesterContract(revertedPrompt))}`
        );

        // Also confirm the LIVE mock (buildMockFleetApi's 'harvester' branch, as
        // actually wired into a real sprint dispatch) reports FAILED -- not
        // OK -- for a blank costAnalysis. This is the literal "mock now reports
        // FAILED" acceptance criterion, driven through buildMockFleetApi rather
        // than the checkHarvesterContract() helper directly.
        const regressionTempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-harvester-regression-'));
        try {
            const dispatched = [];
            const mockFleetApi = buildMockFleetApi(regressionTempDir, { id: 'bd-1' }, dispatched, []);
            const harvesterResult = await mockFleetApi.executePrompt({ agent: 'harvester', label: 'Harvest', prompt: blankCostAnalysis });
            const parsed = JSON.parse(harvesterResult.content[0].text);
            check(
                parsed.status === 'FAILED',
                `Expected the live mock's harvester branch to report status FAILED for a blank costAnalysis, got: ${JSON.stringify(parsed)}`
            );
            check(
                typeof parsed.notes === 'string' && parsed.notes.includes('costAnalysis'),
                `Expected the live mock's FAILED notes to name costAnalysis as the missing input, got: ${JSON.stringify(parsed)}`
            );

            // "Revert": the same live mock must report OK for the real,
            // non-blank prompt.
            const okResult = await mockFleetApi.executePrompt({ agent: 'harvester', label: 'Harvest', prompt: realPrompt });
            const okParsed = JSON.parse(okResult.content[0].text);
            check(
                okParsed.status === 'OK',
                `Expected the live mock's harvester branch to report status OK once reverted to a real, non-blank prompt, got: ${JSON.stringify(okParsed)}`
            );
        } finally {
            await teardown(regressionTempDir);
        }
    });
});

// =============================================================================
// apra-fleet-unw2.22 (N12 follow-up) regression 2: computeBranchSlug()
// must disambiguate branch names that collide under a naive
// slash-to-hyphen replacement, e.g. `feat/fleet-reorg` (which naively
// slugs to `feat-fleet-reorg`) vs. the literal branch name
// `feat-fleet-reorg` (which naively slugs to itself, identically).
// =============================================================================
test('computeBranchSlug: disambiguates branch names that collide under naive slash-to-hyphen replacement', () => {
    console.log('Running branchSlug collision-disambiguation regression (computeBranchSlug)...');
    const collidingBranchA = 'feat/fleet-reorg';
    const collidingBranchB = 'feat-fleet-reorg';
    const naiveSlugA = collidingBranchA.replace(/[\\/]+/g, '-');
    const naiveSlugB = collidingBranchB.replace(/[\\/]+/g, '-');
    check(
        naiveSlugA === naiveSlugB,
        `Test premise broken: expected '${collidingBranchA}' and '${collidingBranchB}' to collide under a naive slash-to-hyphen replacement (both -> '${naiveSlugA}'/'${naiveSlugB}')`
    );
    const slugA = computeBranchSlug(collidingBranchA);
    const slugB = computeBranchSlug(collidingBranchB);
    check(
        slugA !== slugB,
        `computeBranchSlug() must disambiguate colliding branch names, got identical slugs for '${collidingBranchA}' and '${collidingBranchB}': '${slugA}'`
    );
    check(
        `docs/sprint-analysis-${slugA}.md` !== `docs/sprint-analysis-${slugB}.md`,
        `The two colliding branches must now produce two different analysisArtifactFile paths, got identical: docs/sprint-analysis-${slugA}.md`
    );
    // Determinism: the same branch name must always produce the same slug
    // (required for idempotent re-runs and the golden-transcript test).
    check(
        computeBranchSlug(collidingBranchA) === computeBranchSlug(collidingBranchA),
        'computeBranchSlug() must be deterministic for the same input branch name'
    );
    // Human-readable prefix is preserved (debuggability -- the slug should
    // still be recognizable, not just an opaque hash).
    check(
        slugA.startsWith(naiveSlugA + '-') && slugB.startsWith(naiveSlugB + '-'),
        `Expected computeBranchSlug() to preserve the human-readable slash-to-hyphen prefix ahead of the disambiguating suffix, got slugA='${slugA}' slugB='${slugB}'`
    );
});
