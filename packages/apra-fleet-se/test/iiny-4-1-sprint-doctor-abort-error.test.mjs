import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    isTypedAbortError,
    isTerminalSprintFailure,
    resolveTerminalReason,
    captureDoctorVerdictDump,
    finalizeAbort,
} from '../fleet-sprint/runner.js';
import { SprintDoctorAbortError, StalledSprintError } from '../fleet-sprint/errors.mjs';
import { formatDoctorVerdictLines } from '../fleet-sprint/sprint-report.mjs';
import { defaultMockCallTool, legacyCommandExecuteCommandAdapter } from './helpers/mock-sprint-harness.mjs';

// Minimal hermetic mock `command(cmd, opts)` for finalizeAbort()'s own git/PR
// call sites, same shape/rationale as mock-sprint-abort-pr.test.mjs's
// buildMockCommand() (that file's own doc comment explains the failSoft
// branching contract in full) -- duplicated locally here in miniature since
// that helper is not exported for reuse across test files.
function buildMockAbortCommand({ commitCount, prOutcome = 'created', prUrl = 'https://github.com/mock-org/mock-repo/pull/99' } = {}) {
    const log = [];
    const command = async (cmd, opts = {}) => {
        log.push(cmd);
        const failSoft = !!opts.failSoft;
        const ok = (output) => (failSoft ? { ok: true, output, error: null } : output);
        if (/^git fetch origin\b/.test(cmd)) return ok('');
        if (/^git rev-list --count\b/.test(cmd)) return ok(String(commitCount));
        if (/^git push\b/.test(cmd)) return ok('To mock-remote\n * [new branch] (mocked)');
        if (/^git remote get-url origin\b/.test(cmd)) return ok('https://github.com/mock-org/mock-repo.git');
        if (/^\$HOME\/\.fleet-git-credential-/.test(cmd)) {
            return ok('protocol=https\nhost=github.com\nusername=x-access-token\npassword=mock-vcs-module-token\n');
        }
        if (/^curl -sS -X POST\b/.test(cmd) && /\/pulls\b/.test(cmd)) {
            if (prOutcome === 'already-exists') {
                const body = JSON.stringify({
                    message: 'Validation Failed',
                    errors: [{ message: `A pull request already exists for this branch. ${prUrl}` }],
                });
                return ok(`${body}\n422`);
            }
            const body = JSON.stringify({ number: 401, html_url: prUrl });
            return ok(`${body}\n201`);
        }
        throw new Error(`buildMockAbortCommand: unexpected command dispatched in this scenario: '${cmd}'`);
    };
    return { command, log };
}

// Same callTool wiring as mock-sprint-abort-pr.test.mjs's mockAbortCallTool:
// member_detail/provision_vcs_auth answered directly, everything else
// (including vcs_credential_exec) delegated to the shared simulator via
// legacyCommandExecuteCommandAdapter so the PR-raising curl dispatch above
// reaches `command` correctly.
function mockAbortCallTool(command) {
    const base = defaultMockCallTool({ executeCommand: legacyCommandExecuteCommandAdapter(command) });
    return async (name, toolArgs) => {
        if (name === 'member_detail') {
            return { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };
        }
        if (name === 'provision_vcs_auth') {
            const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            return { content: [{ text: `[OK] Mock ${toolArgs && toolArgs.provider} credentials deployed on "${toolArgs && toolArgs.member_name}"\n  expiresAt: ${expiresAt}\n` }] };
        }
        return base(name, toolArgs);
    };
}

// =============================================================================
// apra-fleet-iiny.4.1 -- SprintDoctorAbortError gets its own terminal error so
// an aborted sprint explains itself (design doc `escalate-to-llm-design.md`
// sections 2.5, 3.3). Covers:
//   1. the new error extends the same base as the existing typed aborts and
//      is recognized by isTypedAbortError()/isTerminalSprintFailure();
//   2. captureDoctorVerdictDump() -- the terminal-record carry-forward,
//      mirroring captureDoltConflictDump() (k7b4-beads-sync-conflict-
//      terminal-reason.test.mjs is that function's own precedent);
//   3. formatDoctorVerdictLines() -- the pure PR-body text formatter;
//   4. finalizeAbort() actually embeds the rendered diagnosis in the
//      [ABORTED] PR body when the triggering error is a
//      SprintDoctorAbortError, exactly like mock-sprint-abort-pr.test.mjs's
//      existing "error evidence in body" case for SprintPlanRejectedError.
// No new terminal/abort path is introduced -- every case below reuses the
// EXISTING isTypedAbortError()/finalizeAbort()/resolveTerminalReason() surface.
// =============================================================================

function buildDoctorVerdict(overrides = {}) {
    return {
        classification: 'ENVIRONMENT',
        confidence: 'high',
        evidence: [
            '5 infra failures on one member across 3 unrelated beads, signatures all \'stalled\'',
            'a trivial CLI-version probe on that member timed out',
        ],
        matchedRegistryEntry: 'hung-remote-session',
        action: { kind: 'abort_sprint', reason: 'the member is unresponsive; nothing left to try' },
        humanActionRequired: {
            summary: 'The member does not respond to even trivial probes.',
            suggestedCommands: ['reach the member host directly and check the provider CLI process'],
            relevantFiles: [],
            relevantBeadIds: ['BD-1'],
            whyBeyondBounds: 'Repairs available are limited to the fleet\'s own verbs; all were attempted.',
        },
        notes: 'Nothing suggests an engine or task-shape problem.',
        ...overrides,
    };
}

describe('apra-fleet-iiny.4.1: SprintDoctorAbortError -- typed-abort registration', () => {
    test('isTypedAbortError() is true for SprintDoctorAbortError', () => {
        const err = new SprintDoctorAbortError('doctor gave up', { verdict: buildDoctorVerdict() });
        assert.equal(isTypedAbortError(err), true);
    });

    test('isTerminalSprintFailure() is true for SprintDoctorAbortError (broader predicate, same as every other typed abort)', () => {
        const err = new SprintDoctorAbortError('doctor gave up', { verdict: buildDoctorVerdict() });
        assert.equal(isTerminalSprintFailure(err), true);
    });

    test('extends the same WorkflowError base as the existing typed aborts', () => {
        const err = new SprintDoctorAbortError('doctor gave up', { verdict: buildDoctorVerdict() });
        const stalled = new StalledSprintError('no progress');
        assert.equal(Object.getPrototypeOf(Object.getPrototypeOf(err)), Object.getPrototypeOf(Object.getPrototypeOf(stalled)));
    });

    test('carries code SPRINT_DOCTOR_ABORT, the verdict on .verdict, and resolveTerminalReason() falls back to that code', () => {
        const verdict = buildDoctorVerdict();
        const err = new SprintDoctorAbortError('doctor gave up', { verdict, cycle: 3 });
        assert.equal(err.code, 'SPRINT_DOCTOR_ABORT');
        assert.deepEqual(err.verdict, verdict);
        assert.equal(err.details.verdict, verdict);
        assert.equal(err.details.cycle, 3);
        assert.equal(resolveTerminalReason(err), 'SPRINT_DOCTOR_ABORT');
    });
});

describe('apra-fleet-iiny.4.1: captureDoctorVerdictDump() -- terminal-record carry-forward', () => {
    test('extracts classification/confidence/evidence/matchedRegistryEntry/humanActionRequired/engineFlawReport verbatim', () => {
        const verdict = buildDoctorVerdict();
        const err = new SprintDoctorAbortError('doctor gave up', { verdict });
        assert.deepEqual(captureDoctorVerdictDump(err), {
            classification: 'ENVIRONMENT',
            confidence: 'high',
            evidence: verdict.evidence,
            matchedRegistryEntry: 'hung-remote-session',
            humanActionRequired: verdict.humanActionRequired,
            engineFlawReport: null,
        });
    });

    test('carries engineFlawReport verbatim when classification is ENGINE_FLAW', () => {
        const engineFlawReport = {
            symptom: 'stall detector kills healthy dispatches',
            suspectedComponent: 'stall-timeout config',
            reproEvidence: ['three identical kills at the same offset'],
            proposedBeadTitle: 'stall threshold not tier-aware',
        };
        const verdict = buildDoctorVerdict({ classification: 'ENGINE_FLAW', engineFlawReport });
        const err = new SprintDoctorAbortError('doctor gave up', { verdict });
        const dump = captureDoctorVerdictDump(err);
        assert.deepEqual(dump.engineFlawReport, engineFlawReport);
        assert.equal(dump.classification, 'ENGINE_FLAW');
    });

    test('returns null (never throws) for a non-doctor error', () => {
        assert.equal(captureDoctorVerdictDump(new StalledSprintError('no progress')), null);
        assert.equal(captureDoctorVerdictDump(new Error('plain')), null);
        assert.equal(captureDoctorVerdictDump(null), null);
        assert.equal(captureDoctorVerdictDump(undefined), null);
    });

    test('returns null for a SprintDoctorAbortError constructed with no verdict', () => {
        const err = new SprintDoctorAbortError('doctor gave up with no verdict attached');
        assert.equal(captureDoctorVerdictDump(err), null);
    });

    test('defaults evidence to an empty array and optional blocks to null when absent from the verdict', () => {
        const verdict = { classification: 'TASK_SHAPE', confidence: 'medium' };
        const err = new SprintDoctorAbortError('doctor gave up', { verdict });
        assert.deepEqual(captureDoctorVerdictDump(err), {
            classification: 'TASK_SHAPE',
            confidence: 'medium',
            evidence: [],
            matchedRegistryEntry: null,
            humanActionRequired: null,
            engineFlawReport: null,
        });
    });
});

describe('apra-fleet-iiny.4.1: formatDoctorVerdictLines() -- pure PR-body text formatter', () => {
    test('renders classification+confidence headline, evidence bullets and the human-referral block', () => {
        const lines = formatDoctorVerdictLines(buildDoctorVerdict());
        assert.ok(lines.includes('Doctor diagnosis: ENVIRONMENT (confidence: high)'), `expected a classification headline, got: ${JSON.stringify(lines)}`);
        assert.ok(lines.includes('Evidence:'), `expected an Evidence: heading, got: ${JSON.stringify(lines)}`);
        assert.ok(lines.includes('- 5 infra failures on one member across 3 unrelated beads, signatures all \'stalled\''), `expected the first evidence bullet verbatim, got: ${JSON.stringify(lines)}`);
        assert.ok(lines.includes('Human action required: The member does not respond to even trivial probes.'), `expected the human-referral summary, got: ${JSON.stringify(lines)}`);
        assert.ok(lines.includes('Suggested commands:'), `expected a Suggested commands: heading, got: ${JSON.stringify(lines)}`);
        assert.ok(lines.includes('- reach the member host directly and check the provider CLI process'), `expected the suggested command verbatim, got: ${JSON.stringify(lines)}`);
        assert.ok(lines.includes('Why beyond bounds: Repairs available are limited to the fleet\'s own verbs; all were attempted.'), `expected the whyBeyondBounds line, got: ${JSON.stringify(lines)}`);
    });

    test('omits the human-referral block entirely when absent', () => {
        const lines = formatDoctorVerdictLines({ classification: 'TASK_SHAPE', confidence: 'medium', evidence: ['one bullet'] });
        assert.ok(!lines.some((l) => l.startsWith('Human action required')), `expected no human-referral lines, got: ${JSON.stringify(lines)}`);
        assert.ok(!lines.some((l) => l === 'Suggested commands:'), `expected no Suggested commands heading, got: ${JSON.stringify(lines)}`);
    });

    test('omits the evidence heading when evidence is empty/absent', () => {
        const lines = formatDoctorVerdictLines({ classification: 'UNCLEAR', confidence: 'low' });
        assert.ok(!lines.includes('Evidence:'), `expected no Evidence: heading, got: ${JSON.stringify(lines)}`);
        assert.deepEqual(lines, ['Doctor diagnosis: UNCLEAR (confidence: low)']);
    });

    test('returns an empty array for a null/undefined/malformed verdict', () => {
        assert.deepEqual(formatDoctorVerdictLines(null), []);
        assert.deepEqual(formatDoctorVerdictLines(undefined), []);
        assert.deepEqual(formatDoctorVerdictLines('not an object'), []);
    });
});

describe('apra-fleet-iiny.4.1: finalizeAbort() -- the [ABORTED] PR body embeds the doctor diagnosis', () => {
    test('a SprintDoctorAbortError trigger renders classification, evidence and the human-referral block into the PR body', async () => {
        const branch = 'auto-sprint/doctor-abort-with-diagnosis';
        const { command, log } = buildMockAbortCommand({
            commitCount: 1,
            prOutcome: 'created',
            prUrl: 'https://github.com/mock-org/mock-repo/pull/401',
        });
        const verdict = buildDoctorVerdict();
        const error = new SprintDoctorAbortError('Sprint doctor gave up: environment unrecoverable', { verdict, cycle: 4 });

        const result = await finalizeAbort({
            error,
            branch,
            baseBranch: 'main',
            member: 'local',
            command,
            callTool: mockAbortCallTool(command),
        });

        assert.equal(result.reason, 'aborted-pr-created');

        const prCmd = log.find((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls'));
        assert.ok(prCmd, `expected a create-pull-request command to be dispatched, command log: ${JSON.stringify(log)}`);
        assert.ok(prCmd.includes('Error code: SPRINT_DOCTOR_ABORT'), `expected the error code embedded, got: ${prCmd}`);
        assert.ok(prCmd.includes('Doctor diagnosis: ENVIRONMENT (confidence: high)'), `expected the doctor diagnosis headline embedded, got: ${prCmd}`);
        assert.ok(prCmd.includes('a trivial CLI-version probe on that member timed out'), `expected an evidence bullet embedded, got: ${prCmd}`);
        assert.ok(prCmd.includes('Human action required: The member does not respond to even trivial probes.'), `expected the human-referral summary embedded, got: ${prCmd}`);
        assert.ok(prCmd.includes('reach the member host directly and check the provider CLI process'), `expected a suggested command embedded, got: ${prCmd}`);
        assert.ok(prCmd.includes('Do NOT auto-merge'), `expected the standing do-not-auto-merge notice to still be present, got: ${prCmd}`);
    });

    test('an ordinary typed abort (no doctor verdict) renders no doctor-diagnosis section in the PR body', async () => {
        const branch = 'auto-sprint/non-doctor-abort';
        const { command, log } = buildMockAbortCommand({
            commitCount: 1,
            prOutcome: 'created',
            prUrl: 'https://github.com/mock-org/mock-repo/pull/402',
        });
        const error = new StalledSprintError('no progress across 2 cycles', { staleCycles: 2 });

        await finalizeAbort({
            error,
            branch,
            baseBranch: 'main',
            member: 'local',
            command,
            callTool: mockAbortCallTool(command),
        });

        const prCmd = log.find((c) => c.startsWith('curl -sS -X POST') && c.includes('/pulls'));
        assert.ok(prCmd, `expected a create-pull-request command to be dispatched, command log: ${JSON.stringify(log)}`);
        assert.ok(!prCmd.includes('Doctor diagnosis:'), `expected NO doctor-diagnosis section for a non-doctor abort, got: ${prCmd}`);
    });
});
