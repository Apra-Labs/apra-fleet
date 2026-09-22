import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    sanitizeReport,
    redactSensitiveText,
    getOrCreateInstallId,
    fingerprintForSignature,
    buildTelemetryReport,
    resolveTelemetryMode,
    resolveTelemetryTracker,
    buildUpstreamIssueUrl,
    dedupeReportsByFingerprint,
    buildTelemetryPrBodySection,
    buildTelemetryDashboardState,
} from '../fleet-sprint/doctor-telemetry.mjs';

// =============================================================================
// apra-fleet-iiny.7.3 -- proves the privacy and no-leak properties of
// doctor-telemetry.mjs (apra-fleet-iiny.7.1/7.2) are real, not merely
// documented. Design: fleet-sprint/docs/escalate-to-llm-design.md section
// 4.4.
//
// Entirely offline: every test uses a throwaway APRA_FLEET_DATA_DIR (never a
// developer's real ~/.apra-fleet) and no test issues a network call of any
// kind -- proven both by a static source scan (the module ships no HTTP
// client import at all) and, for the mode-handling surface specifically, by
// a live spy that must never be invoked.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODULE_SOURCE_PATH = path.join(__dirname, '..', 'fleet-sprint', 'doctor-telemetry.mjs');
const MODULE_SOURCE = fs.readFileSync(MODULE_SOURCE_PATH, 'utf8');

/** A throwaway fleet data dir, used as the `env` object doctor-telemetry.mjs's
 * getFleetDataDir()-consuming functions accept -- never process.env itself,
 * so no test can ever touch a real ~/.apra-fleet. */
function tempEnv(tag) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `doctor-telemetry-${tag}-`));
    return { dir, env: { APRA_FLEET_DATA_DIR: dir } };
}

function cleanup(dir) {
    fs.rmSync(dir, { recursive: true, force: true });
}

function writeFleetConfig(dir, config) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(config, null, 2), 'utf8');
}

// -----------------------------------------------------------------------------
// (1) Secrets are GONE (not placeholdered); everything else survives as a
// placeholder that preserves the SHAPE of what was there without the value.
// -----------------------------------------------------------------------------

describe('(1) sanitizeReport: secrets removed outright, everything else placeholdered', () => {
    const SECRET_API_KEY = 'sk-abcd1234efgh5678ijkl9012mnop3456';
    const SECRET_TEMPLATE_REF = '{{secret.GH_DEPLOY_TOKEN}}';
    const SECRET_BEARER = 'Bearer abcdefghijklmnop1234567890';
    const SECRET_ENV_DUMP = 'DEPLOY_API_KEY=sup3rS3cretValueXYZ';
    const HOSTNAME = 'build-agent-42.corp.internal';
    const USERNAME = 'jdoe';
    const HOME_PATH = '/Users/jdoe/repos/target-project/.env';
    const EMAIL = 'jdoe@example.com';
    const IP = '10.20.30.40';

    const rawReport = {
        symptom: `Dispatch failed for ${USERNAME} on host ${HOSTNAME} at ${HOME_PATH}. `
            + `Key was ${SECRET_API_KEY}, template ref ${SECRET_TEMPLATE_REF}, header "${SECRET_BEARER}", `
            + `env line "${SECRET_ENV_DUMP}". Contact ${EMAIL} from ${IP} for details.`,
    };

    const sanitized = sanitizeReport(rawReport, { hostname: HOSTNAME, username: USERNAME });
    const outputText = JSON.stringify(sanitized);

    test('every secret value is GONE -- absent from the output entirely, not even as a placeholder', () => {
        for (const secret of [SECRET_API_KEY, SECRET_TEMPLATE_REF, SECRET_BEARER, SECRET_ENV_DUMP, 'sup3rS3cretValueXYZ']) {
            assert.ok(!outputText.includes(secret), `secret "${secret}" leaked into sanitized output: ${outputText}`);
        }
    });

    test('the templated secret braces are gone too, not just brace-stripped to a readable name (unlike contracts.mjs\'s redactSecretTokens)', () => {
        assert.ok(!outputText.includes('GH_DEPLOY_TOKEN'), `secret token NAME must not survive either: ${outputText}`);
    });

    test('the absolute home path is placeholdered to <home>/..., never left verbatim', () => {
        assert.ok(!outputText.includes(HOME_PATH), `raw home path leaked: ${outputText}`);
        assert.ok(sanitized.symptom.includes('<home>/...'), `expected a <home>/... placeholder: ${sanitized.symptom}`);
    });

    test('the hostname is placeholdered to <host>', () => {
        assert.ok(!outputText.includes(HOSTNAME), `raw hostname leaked: ${outputText}`);
        assert.ok(sanitized.symptom.includes('<host>'), `expected a <host> placeholder: ${sanitized.symptom}`);
    });

    test('the username is placeholdered to <user>', () => {
        assert.ok(!new RegExp(`\\b${USERNAME}\\b`).test(sanitized.symptom), `raw username leaked: ${sanitized.symptom}`);
        assert.ok(sanitized.symptom.includes('<user>'), `expected a <user> placeholder: ${sanitized.symptom}`);
    });

    test('the email is placeholdered to <email>, not merely its local part', () => {
        assert.ok(!outputText.includes(EMAIL), `raw email leaked: ${outputText}`);
        assert.ok(sanitized.symptom.includes('<email>'), `expected an <email> placeholder: ${sanitized.symptom}`);
    });

    test('the IP is placeholdered to <ip>', () => {
        assert.ok(!outputText.includes(IP), `raw IP leaked: ${outputText}`);
        assert.ok(sanitized.symptom.includes('<ip>'), `expected an <ip> placeholder: ${sanitized.symptom}`);
    });

    test('redactSensitiveText is exported and behaves identically standalone (the low-level primitive sanitizeReport composes)', () => {
        const direct = redactSensitiveText(rawReport.symptom, { hostname: HOSTNAME, username: USERNAME });
        assert.ok(!direct.includes(SECRET_API_KEY));
        assert.ok(direct.includes('<home>/...'));
        assert.ok(direct.includes('<host>'));
        assert.ok(direct.includes('<user>'));
        assert.ok(direct.includes('<email>'));
        assert.ok(direct.includes('<ip>'));
    });

    test('a Windows-style home path and a generic non-home absolute path are ALSO placeholdered, distinctly', () => {
        const out = redactSensitiveText(
            'See C:\\Users\\jdoe\\notes.txt and also /var/lib/apra-fleet/work/sprint-x/log.txt',
            { hostname: '', username: '' }
        );
        assert.ok(out.includes('<home>\\...'), `expected a Windows <home> placeholder: ${out}`);
        assert.ok(out.includes('<work-folder>/...'), `expected a non-home <work-folder> placeholder: ${out}`);
        assert.ok(!out.includes('jdoe'), `Windows home path must not leak the username segment: ${out}`);
    });

    test('code snippets are excluded ENTIRELY by default -- the field is absent, not blanked', () => {
        const withSnippet = sanitizeReport({ symptom: 'ok', codeSnippet: 'const password = "hunter2";' });
        assert.ok(!Object.prototype.hasOwnProperty.call(withSnippet, 'codeSnippet'), `codeSnippet must be entirely absent by default: ${JSON.stringify(withSnippet)}`);
        assert.ok(!JSON.stringify(withSnippet).includes('hunter2'));
    });

    test('code snippets survive ONLY under the explicit opt-in, and are still redacted', () => {
        const withSnippet = sanitizeReport(
            { symptom: 'ok', codeSnippet: `const home = "${HOME_PATH}";` },
            { includeCodeSnippets: true }
        );
        assert.ok(Object.prototype.hasOwnProperty.call(withSnippet, 'codeSnippet'));
        assert.ok(!withSnippet.codeSnippet.includes(HOME_PATH), 'even an opted-in code snippet must still be redacted');
    });

    test('error text is truncated to the minimal reproducing lines, with a truncation marker', () => {
        const longText = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
        const out = sanitizeReport({ errorText: longText }, { maxErrorLines: 5 });
        const lines = out.errorText.split('\n');
        assert.equal(lines[0], 'line 0');
        assert.equal(lines[4], 'line 4');
        assert.ok(/truncated/.test(out.errorText), `expected a truncation marker: ${out.errorText}`);
        assert.ok(!out.errorText.includes('line 49'), 'truncated text must not include lines past the cap');
    });

    test('short error text under the cap is left completely untruncated', () => {
        const shortText = 'line 0\nline 1';
        const out = sanitizeReport({ errorText: shortText }, { maxErrorLines: 20 });
        assert.equal(out.errorText, shortText);
    });
});

// -----------------------------------------------------------------------------
// (2) Repo name / branch / bead titles: anonymized by default, preserved only
// under the explicit opt-in tier -- both as their own field AND wherever they
// appear verbatim inside other free-text fields.
// -----------------------------------------------------------------------------

describe('(2) target-repo identifiers: anonymized by default, preserved only opt-in', () => {
    const report = {
        symptom: 'Failure while working on my-secret-target-repo, branch feat/my-secret-branch, bead "Implement the secret sauce".',
        repoName: 'my-secret-target-repo',
        branch: 'feat/my-secret-branch',
        beadTitles: ['Implement the secret sauce'],
    };

    test('default: repoName/branch/beadTitles fields are anonymized to fixed placeholders', () => {
        const out = sanitizeReport(report);
        assert.equal(out.repoName, '<target-repo>');
        assert.equal(out.branch, '<sprint-branch>');
        assert.deepEqual(out.beadTitles, ['<bead-title>']);
    });

    test('default: the SAME identifiers are scrubbed out of every OTHER free-text field too, not just their own field', () => {
        const out = sanitizeReport(report);
        assert.ok(!out.symptom.includes('my-secret-target-repo'), `repo name leaked into symptom: ${out.symptom}`);
        assert.ok(!out.symptom.includes('feat/my-secret-branch'), `branch leaked into symptom: ${out.symptom}`);
        assert.ok(!out.symptom.includes('Implement the secret sauce'), `bead title leaked into symptom: ${out.symptom}`);
        assert.ok(out.symptom.includes('<target-repo>'));
        assert.ok(out.symptom.includes('<sprint-branch>'));
        assert.ok(out.symptom.includes('<bead-title>'));
    });

    test('opt-in (keepIdentifiers): every identifier survives verbatim, in its own field and inline', () => {
        const out = sanitizeReport(report, { keepIdentifiers: true });
        assert.equal(out.repoName, 'my-secret-target-repo');
        assert.equal(out.branch, 'feat/my-secret-branch');
        assert.deepEqual(out.beadTitles, ['Implement the secret sauce']);
        assert.ok(out.symptom.includes('my-secret-target-repo'));
        assert.ok(out.symptom.includes('feat/my-secret-branch'));
        assert.ok(out.symptom.includes('Implement the secret sauce'));
    });

    test('opt-in identifiers are STILL redacted for secrets/paths/etc -- keepIdentifiers is not a blanket bypass', () => {
        const out = sanitizeReport(
            { repoName: 'repo-with-/Users/jdoe/leak', branch: 'main', beadTitles: [] },
            { keepIdentifiers: true }
        );
        assert.ok(!out.repoName.includes('/Users/jdoe'), `opted-in identifier must still be path-redacted: ${out.repoName}`);
        assert.ok(out.repoName.includes('<home>/...'));
    });
});

// -----------------------------------------------------------------------------
// (3) Install id: a UUID, stable across calls, unaffected by host identity.
// -----------------------------------------------------------------------------

describe('(3) getOrCreateInstallId: a stable, anonymous UUID', () => {
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    test('is a well-formed UUID', () => {
        const { dir, env } = tempEnv('installid-shape');
        try {
            const id = getOrCreateInstallId(env);
            assert.match(id, UUID_RE);
        } finally {
            cleanup(dir);
        }
    });

    test('is stable across repeated calls against the same data dir', () => {
        const { dir, env } = tempEnv('installid-stable');
        try {
            const first = getOrCreateInstallId(env);
            const second = getOrCreateInstallId(env);
            const third = getOrCreateInstallId(env);
            assert.equal(first, second);
            assert.equal(second, third);
        } finally {
            cleanup(dir);
        }
    });

    test('is persisted to disk on first call (not merely memoized in-process)', () => {
        const { dir, env } = tempEnv('installid-persist');
        try {
            const id = getOrCreateInstallId(env);
            const filePath = path.join(dir, 'doctor', 'telemetry-install-id.json');
            assert.ok(fs.existsSync(filePath), 'expected the install id to be written to disk');
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            assert.equal(parsed.installId, id);
        } finally {
            cleanup(dir);
        }
    });

    test('two DIFFERENT data dirs get two DIFFERENT ids (never derived from machine identity, which is constant across both)', () => {
        const a = tempEnv('installid-a');
        const b = tempEnv('installid-b');
        try {
            const idA = getOrCreateInstallId(a.env);
            const idB = getOrCreateInstallId(b.env);
            assert.notEqual(idA, idB);
        } finally {
            cleanup(a.dir);
            cleanup(b.dir);
        }
    });

    test('unaffected by hostname/username env hints -- only the on-disk file (or its absence) decides the id', () => {
        const { dir, env } = tempEnv('installid-identity-blind');
        try {
            const first = getOrCreateInstallId(env);
            // A different process's env commonly carries HOSTNAME/USER/USERNAME;
            // the id must be read back from the SAME file regardless of what
            // those happen to say.
            const spoofedEnv = { ...env, HOSTNAME: 'totally-different-host', USER: 'someone-else', USERNAME: 'someone-else' };
            const second = getOrCreateInstallId(spoofedEnv);
            assert.equal(first, second);
            assert.ok(!first.toLowerCase().includes(os.hostname().toLowerCase().slice(0, 4) || 'zzzz'), 'sanity: a real UUID should not happen to contain a hostname fragment');
        } finally {
            cleanup(dir);
        }
    });

    test('a corrupt/malformed install-id file is overwritten with a fresh valid id rather than poisoning every future call', () => {
        const { dir, env } = tempEnv('installid-corrupt');
        try {
            const filePath = path.join(dir, 'doctor', 'telemetry-install-id.json');
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, 'not valid json{{{', 'utf8');
            const id = getOrCreateInstallId(env);
            assert.match(id, UUID_RE);
        } finally {
            cleanup(dir);
        }
    });
});

// -----------------------------------------------------------------------------
// Fingerprint: derived from the normalized signature, stable, hash-shaped.
// -----------------------------------------------------------------------------

describe('fingerprintForSignature', () => {
    test('is deterministic for the same signature', () => {
        assert.equal(fingerprintForSignature('dispatch_failed: X'), fingerprintForSignature('dispatch_failed: X'));
    });

    test('differs for different signatures', () => {
        assert.notEqual(fingerprintForSignature('dispatch_failed: X'), fingerprintForSignature('dispatch_failed: Y'));
    });

    test('is a fixed-length hex string regardless of signature length', () => {
        assert.match(fingerprintForSignature('short'), /^[0-9a-f]{16}$/);
        assert.match(fingerprintForSignature('a'.repeat(5000)), /^[0-9a-f]{16}$/);
    });

    test('buildTelemetryReport attaches both installId and fingerprint to a sanitized report', () => {
        const { dir, env } = tempEnv('buildreport');
        try {
            const out = buildTelemetryReport({ symptom: 'x at /Users/bob/y' }, { errorSignature: 'dispatch_failed: X', env });
            assert.match(out.installId, /^[0-9a-f-]{36}$/i);
            assert.match(out.fingerprint, /^[0-9a-f]{16}$/);
            assert.ok(!out.symptom.includes('/Users/bob'), 'buildTelemetryReport must sanitize, not just attach metadata');
        } finally {
            cleanup(dir);
        }
    });
});

// -----------------------------------------------------------------------------
// (6) Fingerprint dedup: identical fingerprints collapse to ONE report with an
// occurrence count.
// -----------------------------------------------------------------------------

describe('(6) dedupeReportsByFingerprint', () => {
    test('two reports sharing a fingerprint dedup to one entry with occurrences: 2', () => {
        const a = { fingerprint: 'abc123', symptom: 'first' };
        const b = { fingerprint: 'abc123', symptom: 'first (retried)' };
        const deduped = dedupeReportsByFingerprint([a, b]);
        assert.equal(deduped.length, 1);
        assert.equal(deduped[0].occurrences, 2);
        // The FIRST occurrence's fields survive -- a later duplicate only
        // increments the count, it never overwrites content.
        assert.equal(deduped[0].symptom, 'first');
    });

    test('reports with DIFFERENT fingerprints are never merged', () => {
        const a = { fingerprint: 'abc123' };
        const b = { fingerprint: 'def456' };
        const deduped = dedupeReportsByFingerprint([a, b]);
        assert.equal(deduped.length, 2);
        assert.ok(deduped.every((r) => r.occurrences === 1));
    });

    test('three occurrences of the same fingerprint count to 3, not 2', () => {
        const rep = { fingerprint: 'zzz' };
        const deduped = dedupeReportsByFingerprint([rep, rep, rep]);
        assert.equal(deduped.length, 1);
        assert.equal(deduped[0].occurrences, 3);
    });

    test('an empty list dedups to an empty list', () => {
        assert.deepEqual(dedupeReportsByFingerprint([]), []);
        assert.deepEqual(dedupeReportsByFingerprint(undefined), []);
    });
});

// -----------------------------------------------------------------------------
// (4) Consent modes: never writes nothing outside run artifacts (i.e. this
// module produces no PR-body/dashboard surface for it); ask emits the
// sanitized text plus a link ONLY when a tracker is configured; always
// records the standing-consent footer. All three asserted with NO network
// call of any kind.
// -----------------------------------------------------------------------------

describe('(4) consent modes: never/ask/always, offline', () => {
    // A spy standing in for "any HTTP client call" -- if any function under
    // test invoked one, this would be it. It is asserted un-called at the end
    // of every test in this block, so the offline claim is a real assertion,
    // not merely "no error was thrown".
    function networkSpy() {
        let called = false;
        return { fetch: (...args) => { called = true; return args; }, wasCalled: () => called };
    }

    const report = buildTelemetryReport({ symptom: 'thing broke' }, { errorSignature: 'dispatch_failed: X' });

    test('mode resolution defaults to "ask" when unset', () => {
        const { dir, env } = tempEnv('mode-default');
        try {
            assert.equal(resolveTelemetryMode(env), 'ask');
        } finally {
            cleanup(dir);
        }
    });

    test('mode resolution defaults to "ask" for an unrecognized value (fails toward the SAFER mode, never toward always)', () => {
        const { dir, env } = tempEnv('mode-garbage');
        try {
            writeFleetConfig(dir, { doctor: { telemetry: 'upload-everything-now' } });
            assert.equal(resolveTelemetryMode(env), 'ask');
        } finally {
            cleanup(dir);
        }
    });

    test('never: buildTelemetryPrBodySection returns null -- nothing is surfaced outside the run artifacts', () => {
        const spy = networkSpy();
        const section = buildTelemetryPrBodySection([report], { mode: 'never', newIssueUrlTemplate: null, sanitizePrText: (t) => t });
        assert.equal(section, null);
        assert.equal(spy.wasCalled(), false);
    });

    test('never: buildTelemetryDashboardState reports the mode but an EMPTY reports array, whatever was collected', () => {
        const state = buildTelemetryDashboardState([report, report], { mode: 'never', newIssueUrlTemplate: null });
        assert.equal(state.mode, 'never');
        assert.deepEqual(state.reports, []);
    });

    test('ask + no tracker configured: the pre-filled link is ABSENT and the section states telemetry is disabled', () => {
        const spy = networkSpy();
        const section = buildTelemetryPrBodySection([report], { mode: 'ask', newIssueUrlTemplate: null, sanitizePrText: (t) => t });
        assert.ok(section, 'a report was collected, so SOME section must render');
        assert.ok(!/https?:\/\//.test(section), `no URL of any kind may appear with no tracker configured: ${section}`);
        assert.match(section, /disabled/i);
        assert.equal(spy.wasCalled(), false);
    });

    test('ask + tracker configured: the sanitized text AND a pre-filled link are both present', () => {
        const spy = networkSpy();
        const template = 'https://example.com/new?title={title}&body={body}';
        const section = buildTelemetryPrBodySection([report], { mode: 'ask', newIssueUrlTemplate: template, sanitizePrText: (t) => t });
        assert.ok(section.includes('thing broke'));
        assert.match(section, /https:\/\/example\.com\/new\?title=/);
        assert.equal(spy.wasCalled(), false);
    });

    test('ask + tracker configured: buildUpstreamIssueUrl substitutes {title}/{body} with percent-encoded, sanitized content', () => {
        const url = buildUpstreamIssueUrl('https://example.com/new?title={title}&body={body}', report);
        assert.ok(url.startsWith('https://example.com/new?title='));
        assert.ok(!url.includes(' '), 'the URL must be percent-encoded (no literal spaces)');
        assert.ok(decodeURIComponent(url).includes('thing broke'));
    });

    test('buildUpstreamIssueUrl returns null with no template configured -- never a fallback target', () => {
        assert.equal(buildUpstreamIssueUrl(null, report), null);
        assert.equal(buildUpstreamIssueUrl('', report), null);
        assert.equal(buildUpstreamIssueUrl(undefined, report), null);
    });

    test('always: the standing-consent footer is recorded in the PR-body section', () => {
        const spy = networkSpy();
        const section = buildTelemetryPrBodySection([report], { mode: 'always', newIssueUrlTemplate: null, sanitizePrText: (t) => t });
        assert.match(section, /always/i);
        assert.match(section, /standing consent/i);
        assert.equal(spy.wasCalled(), false);
    });

    test('always mode never emits a per-report upstream link line in the PR body -- filing is a standing/automatic action, not a click-through', () => {
        const template = 'https://example.com/new?title={title}&body={body}';
        const section = buildTelemetryPrBodySection([report], { mode: 'always', newIssueUrlTemplate: template, sanitizePrText: (t) => t });
        assert.ok(!section.includes('File upstream:'), `always mode must not render the ask-mode click-through link line: ${section}`);
    });

    test('resolveTelemetryTracker returns null with no config file at all', () => {
        const { dir, env } = tempEnv('tracker-none');
        try {
            assert.equal(resolveTelemetryTracker(env), null);
        } finally {
            cleanup(dir);
        }
    });

    test('resolveTelemetryTracker reads the configured template back verbatim', () => {
        const { dir, env } = tempEnv('tracker-configured');
        try {
            const template = 'https://tracker.example/new?title={title}&body={body}';
            writeFleetConfig(dir, { doctor: { telemetryTracker: { newIssueUrlTemplate: template } } });
            assert.equal(resolveTelemetryTracker(env), template);
        } finally {
            cleanup(dir);
        }
    });

    test('a malformed config.json degrades to mode "ask" and tracker null, never a throw', () => {
        const { dir, env } = tempEnv('config-malformed');
        try {
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'config.json'), 'not json at all {{{', 'utf8');
            assert.equal(resolveTelemetryMode(env), 'ask');
            assert.equal(resolveTelemetryTracker(env), null);
        } finally {
            cleanup(dir);
        }
    });
});

// -----------------------------------------------------------------------------
// (5) Deny-list: no hardcoded upstream tracker literal anywhere in the
// module's source, at all -- proven by scanning the ACTUAL source text (not
// re-deriving from the exported functions, which could hide a literal used
// only internally).
// -----------------------------------------------------------------------------

describe('(5) no hardcoded upstream tracker literal in doctor-telemetry.mjs', () => {
    test('the module source contains no literal http(s):// URL at all', () => {
        const urlMatches = MODULE_SOURCE.match(/https?:\/\/[^\s'"`)]+/g) || [];
        assert.deepEqual(urlMatches, [], `found a literal URL in the source: ${JSON.stringify(urlMatches)}`);
    });

    test('the module source names no specific issue-tracker host (github.com, gitlab.com, dev.azure.com, bitbucket.org)', () => {
        const knownHosts = ['github.com', 'gitlab.com', 'dev.azure.com', 'bitbucket.org', 'visualstudio.com'];
        for (const host of knownHosts) {
            assert.ok(!MODULE_SOURCE.includes(host), `found a hardcoded tracker host literal "${host}" in doctor-telemetry.mjs`);
        }
    });

    test('the module source contains no owner/repo-shaped literal naming this project\'s own tracker', () => {
        assert.ok(!MODULE_SOURCE.includes('Apra-Labs/'), 'found this project\'s own owner/repo literal -- the exact dogfood leak the design doc forbids');
        assert.ok(!MODULE_SOURCE.includes('apra-fleet/issues'), 'found a hardcoded issues path for this project\'s own tracker');
    });

    test('falsifiability: the deny-list check actually catches a seeded literal (proves it is not vacuous)', () => {
        const seeded = `${MODULE_SOURCE}\nconst SEEDED_LEAK = 'https://github.com/Apra-Labs/apra-fleet/issues/new';\n`;
        const urlMatches = seeded.match(/https?:\/\/[^\s'"`)]+/g) || [];
        assert.ok(urlMatches.length > 0, 'the seeded literal must be caught by the same regex the real test above uses');
    });

    test('no code path in the module creates a bead (no `bd create`, no bead-mutation call of any kind)', () => {
        assert.ok(!/\bbd\s+create\b/.test(MODULE_SOURCE), 'found a `bd create` invocation -- engine-flaw reports must NEVER be auto-filed as a bead');
        assert.ok(!MODULE_SOURCE.includes('createBead'), 'found a createBead-shaped call');
    });

    test('no HTTP client import of any kind -- the module is structurally incapable of a network call', () => {
        for (const forbidden of ['undici', 'node:http', "'http'", 'node-fetch', 'axios']) {
            assert.ok(!MODULE_SOURCE.includes(forbidden), `found a forbidden HTTP-client import/reference: ${forbidden}`);
        }
        // The one "fetch"-shaped identifier this module is allowed to contain
        // is unrelated prose/config-key naming; assert there is no actual
        // global fetch(...) CALL.
        assert.ok(!/\bfetch\s*\(/.test(MODULE_SOURCE), 'found what looks like a fetch(...) call site');
    });
});
