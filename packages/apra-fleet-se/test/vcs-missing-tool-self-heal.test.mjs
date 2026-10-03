import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { classifyFailure, toDoltVerdict, toGitVerdict } from '../fleet-sprint/vcs-module.mjs';
import { VCS_FAILURE_KINDS as K } from '../fleet-sprint/errors.mjs';
import {
    classifyDoltFailure,
    doltPullBefore,
    invalidateSyncRemoteCache,
    clearLastSyncedTip,
    clearTipProbeFailures,
    NEUTRAL_KIND_MAP,
} from '../fleet-sprint/dolt-sync.mjs';
import { classifyGitFailure, runGitStep } from '../fleet-sprint/git-topology.mjs';
import { createVcsAuthSelfHealCallback, selfHealMemoryKey, FUTILE_HEAL_TTL_MS } from '../fleet-sprint/vcs-auth.mjs';
import { DoltSyncError } from '../fleet-sprint/errors.mjs';

// GitHub #616: (a) a missing binary is its own failure kind, checked before
// every provider rule, never retried and never routed to the credential
// self-heal; (b) the self-heal logs say what actually happened; (c) a heal
// that did not recover is not repeated for the same member + error.

// Real wordings, Windows and POSIX.
const PWSH_MISSING_BD =
    "bd : The term 'bd' is not recognized as the name of a cmdlet, function, script file, or operable program. " +
    'Check the spelling of the name, or if a path was included, verify that the path is correct and try again.';
const CMD_MISSING_BD =
    "'bd' is not recognized as an internal or external command,\r\noperable program or batch file.";
const BASH_MISSING_BD = 'bash: line 1: bd: command not found';
const ZSH_MISSING_DOLT = 'zsh: command not found: dolt';
const SH_MISSING_BD = 'sh: 1: bd: not found';
const EXIT_127 = '[Command Failed] Exit code 127: ';
const SPAWN_ENOENT = 'spawn git ENOENT';

// [name, text, the step's binary, expected missingTool]
const CASES = [
    ['PowerShell', PWSH_MISSING_BD, 'bd', 'bd'],
    ['cmd.exe', CMD_MISSING_BD, 'bd', 'bd'],
    ['bash', BASH_MISSING_BD, 'bd', 'bd'],
    ['zsh', ZSH_MISSING_DOLT, 'dolt', 'dolt'],
    ['dash/sh', SH_MISSING_BD, 'bd', 'bd'],
    ['exit code 127', EXIT_127, 'bd', 'bd'],
    ['spawn ENOENT', SPAWN_ENOENT, 'git', 'git'],
];

describe('classifyFailure -- MISSING_TOOL', () => {
    for (const [name, text, tool, expected] of CASES) {
        test(`${name} wording for the step's own binary (${tool}) classifies MISSING_TOOL, not retryable, for every provider`, () => {
            for (const provider of [undefined, 'dolt', 'github', 'azure-devops']) {
                const r = classifyFailure(text, provider ? { provider, tool } : { tool });
                assert.equal(r.kind, K.MISSING_TOOL, `${name} / ${provider ?? 'default'}`);
                assert.equal(r.retryable, false);
                assert.equal(r.missingTool, expected);
            }
        });
    }

    test('the reporter\'s verbatim PowerShell text classifies MISSING_TOOL with and without step context', () => {
        assert.equal(classifyFailure(PWSH_MISSING_BD, { provider: 'dolt', tool: 'bd' }).kind, K.MISSING_TOOL);
        assert.equal(classifyDoltFailure(PWSH_MISSING_BD), 'missing-tool');
        assert.equal(classifyGitFailure(PWSH_MISSING_BD), 'missing-tool');
    });

    test('a step binary given as a path or with a Windows suffix still matches', () => {
        assert.equal(classifyFailure("The term 'C:\\tools\\bd.exe' is not recognized as the name of a cmdlet", { tool: 'bd' }).kind, K.MISSING_TOOL);
        assert.equal(classifyFailure(BASH_MISSING_BD, { tool: '/usr/local/bin/bd' }).kind, K.MISSING_TOOL);
    });

    test('a not-found for a DIFFERENT binary than the step ran is not MISSING_TOOL', () => {
        assert.notEqual(classifyFailure(BASH_MISSING_BD, { tool: 'git' }).kind, K.MISSING_TOOL);
        assert.notEqual(classifyFailure(ZSH_MISSING_DOLT, { tool: 'bd' }).kind, K.MISSING_TOOL);
    });

    test('exit code 127 counts only with step context, and never when the text names another binary', () => {
        assert.equal(classifyFailure('', { exitCode: 127, tool: 'bd' }).kind, K.MISSING_TOOL);
        assert.equal(classifyFailure('', { exitCode: 127 }).kind, K.UNKNOWN);
        assert.equal(classifyFailure('', { exitCode: 1, tool: 'bd' }).kind, K.UNKNOWN);
        assert.equal(classifyFailure(`/home/u/.bashrc: line 4: pyenv: command not found\n${EXIT_127}`, { tool: 'bd' }).kind, K.UNKNOWN);
    });
});

// Review finding on #616: shell-profile / hook / server-side "not found" noise
// printed ahead of the real failure must not outrank the real classification.
describe('classifyFailure -- not-found noise for other binaries does not win', () => {
    const NOISE = [
        ['bash rc + DNS failure -> TRANSIENT', "/home/u/.bashrc: line 12: pyenv: command not found\nfatal: unable to access 'https://github.com/a/b.git/': Could not resolve host: github.com", 'git', undefined, K.TRANSIENT],
        ['zsh rc + auth -> AUTH_EXPIRED', '/Users/u/.zshenv:3: command not found: pyenv\nfatal: Authentication failed for \'https://github.com/a/b.git/\'', 'git', undefined, K.AUTH_EXPIRED],
        ['PowerShell profile + auth prompt -> AUTH_EXPIRED', "conda : The term 'conda' is not recognized as the name of a cmdlet, function, script file, or operable program.\nfatal: could not read Username for 'https://github.com': terminal prompts disabled", 'git', undefined, K.AUTH_EXPIRED],
        ['bash rc + dolt lock -> TRANSIENT', '/home/u/.bashrc: line 3: nvm: command not found\nerror: database is locked', 'bd', 'dolt', K.TRANSIENT],
    ];
    for (const [name, text, tool, provider, expected] of NOISE) {
        test(name, () => {
            const r = classifyFailure(text, provider ? { provider, tool } : { tool });
            assert.equal(r.kind, expected);
            assert.equal(r.missingTool, null);
        });
    }

    test('a git hook\'s "npx: command not found" during git push is not a missing tool for the member', () => {
        const text = '.husky/pre-push: line 4: npx: command not found\nerror: failed to push some refs to \'https://github.com/a/b.git\'';
        assert.notEqual(classifyFailure(text, { tool: 'git' }).kind, K.MISSING_TOOL);
        assert.notEqual(classifyGitFailure(text), 'missing-tool');
    });

    test('a server-side "git-receive-pack: command not found" is not a missing tool for the member', () => {
        const text = 'bash: git-receive-pack: command not found\nfatal: Could not read from remote repository.';
        assert.notEqual(classifyFailure(text, { tool: 'git' }).kind, K.MISSING_TOOL);
        assert.notEqual(classifyGitFailure(text), 'missing-tool');
    });

    test('a diverged D-pull behind rc noise still throws the divergence, not missing-tool', async () => {
        const diverged = '/home/u/.bashrc: line 3: nvm: command not found\nerror: failed to push some refs to origin/main\nhint: Updates were rejected because the remote contains work that you do not have locally.';
        assert.equal(classifyDoltFailure(diverged), 'diverged');
        assert.equal(toDoltVerdict(classifyFailure(diverged, { provider: 'dolt', tool: 'bd' }).kind), 'diverged');
    });

    test('the verdict adapters map it to missing-tool; ordinary texts are unchanged', () => {
        assert.equal(toDoltVerdict(K.MISSING_TOOL), 'missing-tool');
        assert.equal(toGitVerdict(K.MISSING_TOOL), 'missing-tool');
        assert.equal(classifyFailure('fatal: Authentication failed').kind, K.AUTH_EXPIRED);
        assert.equal(classifyFailure('something nobody recognizes').kind, K.UNKNOWN);
        assert.equal(classifyFailure('something nobody recognizes').missingTool, null);
    });
});

beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
});

function scriptedCommand(byKey) {
    const calls = [];
    const command = async (cmd) => {
        calls.push(cmd);
        for (const [key, queue] of Object.entries(byKey)) {
            if (cmd.includes(key)) return queue.length > 1 ? queue.shift() : queue[0];
        }
        return { ok: true, output: '', error: null };
    };
    return { command, calls };
}
const fail = (error) => ({ ok: false, output: '', error });
const OK = { ok: true, output: '', error: null };

describe('missing tool never reaches the self-heal and is not retried', () => {
    for (const [name, text] of [['Windows PowerShell', PWSH_MISSING_BD], ['POSIX bash', BASH_MISSING_BD]]) {
        test(`D-pull (${name}): one attempt, no self-heal, error names the binary and the member`, async () => {
            const { command, calls } = scriptedCommand({ 'bd dolt pull': [fail(text)] });
            let heals = 0;
            const logs = [];
            await assert.rejects(
                () => doltPullBefore('mem-1', {
                    command, log: (m) => logs.push(m), sleep: async () => {},
                    checkSyncRemoteConfigured: async () => true, remoteTipFingerprint: false,
                    onAuthFailure: async () => { heals += 1; },
                }),
                (err) => {
                    assert.ok(err instanceof DoltSyncError);
                    assert.match(err.message, /'bd' is not installed or not on PATH on member 'mem-1'/);
                    assert.match(err.message, /credentials were not re-provisioned/);
                    return true;
                },
            );
            assert.equal(heals, 0, 'a missing binary must never trigger the credential self-heal');
            assert.equal(calls.filter((c) => c.includes('bd dolt pull')).length, 1, 'never retried');
            assert.ok(logs.some((l) => l.includes('FAILED (missing-tool)') && l.includes("'bd' was not found on member 'mem-1'")), JSON.stringify(logs));
        });

        test(`git step (${name}): one attempt, no self-heal, kind missing-tool`, async () => {
            const gitText = text.replace(/\bbd\b/g, 'git');
            const { command, calls } = scriptedCommand({ 'git fetch': [fail(gitText)] });
            let heals = 0;
            const logs = [];
            const res = await runGitStep({
                command, member: 'mem-2', cmd: 'git fetch origin', label: 'G-pull', log: (m) => logs.push(m),
                maxTransientRetries: 3, onAuthFailure: async () => { heals += 1; },
            });
            assert.equal(res.ok, false);
            assert.equal(res.kind, 'missing-tool');
            assert.equal(res.missingTool, 'git');
            assert.equal(heals, 0);
            assert.equal(calls.length, 1);
            assert.ok(logs.some((l) => l.includes("'git' was not found on member 'mem-2'")), JSON.stringify(logs));
        });
    }
});

describe('self-heal hand-off and honest logs', () => {
    test('the step passes the real classification (source + failureKind) to the self-heal', async () => {
        const seen = [];
        const { command } = scriptedCommand({ 'git push': [fail('fatal: Authentication failed'), OK] });
        const res = await runGitStep({
            command, member: 'm', cmd: 'git push', label: 'G-push', log: () => {}, maxTransientRetries: 0,
            onAuthFailure: async (info) => { seen.push(info); },
        });
        assert.equal(res.ok, true);
        assert.equal(seen.length, 1);
        assert.equal(seen[0].source, 'git');
        assert.equal(seen[0].failureKind, 'auth');
        assert.equal(seen[0].kind, undefined, 'the old misleading kind: \'git\' field is gone');
    });

    test('recovery after the heal is logged; a failed retry logs "did not recover" and is recorded', async () => {
        const logs = [];
        const recorded = [];
        const heal = async () => {};
        heal.recordHealOutcome = async (info) => { recorded.push(info); };

        const ok = scriptedCommand({ 'git push': [fail('weird failure 1'), OK] });
        await runGitStep({ command: ok.command, member: 'm', cmd: 'git push', label: 'G-push', log: (l) => logs.push(l), maxTransientRetries: 0, onAuthFailure: heal });
        assert.ok(logs.some((l) => l.includes('self-heal recovered')), JSON.stringify(logs));
        assert.equal(recorded.length, 0);

        logs.length = 0;
        const bad = scriptedCommand({ 'git push': [fail('weird failure 2')] });
        await runGitStep({ command: bad.command, member: 'm', cmd: 'git push', label: 'G-push', log: (l) => logs.push(l), maxTransientRetries: 0, onAuthFailure: heal });
        assert.ok(logs.some((l) => l.includes('self-heal did not recover')), JSON.stringify(logs));
        assert.equal(recorded.length, 1);
        assert.equal(recorded[0].recovered, false);
        assert.equal(recorded[0].failureKind, 'unknown');
    });
});

// A callTool fake good enough for createVcsAuthSelfHealCallback: member_detail
// resolves a GitHub member and provision_vcs_auth succeeds.
function fakeCallTool(counter) {
    return async (name) => {
        if (name === 'member_detail') return { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };
        if (name === 'provision_vcs_auth') counter.provisions += 1;
        return { status: 'ok' };
    };
}
const remoteCommand = async (cmd) => (cmd === 'git remote get-url origin'
    ? { ok: true, output: 'https://github.com/acme/widgets.git', error: null }
    : { ok: true, output: '', error: null });

describe('createVcsAuthSelfHealCallback -- honest logs and no repeated futile heal', () => {
    test('auth vs unclassified wording, and "credentials re-provisioned" instead of "succeeded"', async () => {
        const counter = { provisions: 0 };
        const logs = [];
        const heal = createVcsAuthSelfHealCallback({ callTool: fakeCallTool(counter), command: remoteCommand, log: (l) => logs.push(l) });

        await heal({ member: 'm', label: 'D-pull', error: 'e1', source: 'dolt', failureKind: 'auth' });
        await heal({ member: 'm', label: 'D-pull', error: 'e2', source: 'dolt', failureKind: 'unknown' });

        assert.ok(logs.some((l) => l.includes('auth failure detected') && l.includes(': e1')), JSON.stringify(logs));
        assert.ok(logs.some((l) => l.includes('unclassified failure') && l.includes('re-provisioning credentials as a last resort') && l.includes(': e2')), JSON.stringify(logs));
        assert.ok(!logs.some((l) => l.includes('auth failure detected') && l.includes(': e2')), 'an unclassified failure must not be called an auth failure');
        assert.ok(logs.some((l) => l.includes('credentials re-provisioned for member')));
        assert.ok(!logs.some((l) => /succeeded/.test(l)), JSON.stringify(logs));
        assert.equal(counter.provisions, 2);
    });

    test('a heal that did not recover is not repeated for the same member + normalised error this run', async () => {
        const counter = { provisions: 0 };
        const heal = createVcsAuthSelfHealCallback({ callTool: fakeCallTool(counter), command: remoteCommand, log: () => {} });
        const info = { member: 'm', label: 'D-pull 1', error: 'Error 1105: lock held by pid 4242', source: 'dolt', failureKind: 'unknown' };

        await heal(info);
        await heal.recordHealOutcome({ ...info, recovered: false });
        assert.equal(counter.provisions, 1);

        // Same failure on a later D-pull, different pid: same normalised key.
        await assert.rejects(
            () => heal({ ...info, label: 'D-pull 2', error: 'Error 1105: lock held by pid 777' }),
            /skipping self-heal for member 'm'.*already failed to recover this same unclassified failure earlier in this run \(D-pull 1\)/,
        );
        assert.equal(counter.provisions, 1, 'no second provision_vcs_auth call');

        // A different member, or a different error, still heals.
        await heal({ ...info, member: 'other' });
        await heal({ ...info, error: 'a different failure' });
        assert.equal(counter.provisions, 3);

        // A recovered heal is never remembered.
        await heal.recordHealOutcome({ ...info, error: 'transient thing', recovered: true });
        await heal({ ...info, error: 'transient thing' });
        assert.equal(counter.provisions, 4);
    });

    test('end to end: the second D-pull failing the same way does not re-provision', async () => {
        const counter = { provisions: 0 };
        const heal = createVcsAuthSelfHealCallback({ callTool: fakeCallTool(counter), command: remoteCommand, log: () => {} });
        const odd = 'Error: something dolt said that nobody classifies (run 1)';
        for (let i = 0; i < 2; i += 1) {
            invalidateSyncRemoteCache();
            const { command } = scriptedCommand({ 'bd dolt pull': [fail(odd.replace('1', String(i + 2)))] });
            await assert.rejects(() => doltPullBefore('mem-3', {
                command, log: () => {}, sleep: async () => {}, checkSyncRemoteConfigured: async () => true,
                remoteTipFingerprint: false, onAuthFailure: heal,
            }));
        }
        assert.equal(counter.provisions, 1, 'the futile heal runs once per run, not once per D-pull');
    });

    test('selfHealMemoryKey normalises numbers and hex ids but keeps member and wording', () => {
        assert.equal(selfHealMemoryKey('a', 'lock 12 at deadbeef01'), selfHealMemoryKey('a', 'lock 99 at 0123abcdef'));
        assert.notEqual(selfHealMemoryKey('a', 'x'), selfHealMemoryKey('b', 'x'));
        assert.notEqual(selfHealMemoryKey('a', 'lock held'), selfHealMemoryKey('a', 'auth failed'));
    });

    // Review follow-ups (GitHub #616).
    test('a genuine AUTH heal is never suppressed, even after an auth heal did not recover', async () => {
        const counter = { provisions: 0 };
        const heal = createVcsAuthSelfHealCallback({ callTool: fakeCallTool(counter), command: remoteCommand, log: () => {} });
        const info = { member: 'm', label: 'D-pull 1', error: 'fatal: Authentication failed', source: 'dolt', failureKind: 'auth' };
        await heal(info);
        await heal.recordHealOutcome({ ...info, recovered: false });
        await heal({ ...info, label: 'D-pull 2' });
        assert.equal(counter.provisions, 2);
    });

    test('a remembered futile unclassified heal expires after the TTL', async () => {
        const counter = { provisions: 0 };
        let t = 1_000_000;
        const heal = createVcsAuthSelfHealCallback({ callTool: fakeCallTool(counter), command: remoteCommand, log: () => {}, now: () => t });
        const info = { member: 'm', label: 'D-pull 1', error: 'Error: weird', source: 'dolt', failureKind: 'unknown' };
        await heal(info);
        await heal.recordHealOutcome({ ...info, recovered: false });
        t += FUTILE_HEAL_TTL_MS - 1;
        await assert.rejects(() => heal(info), /skipping self-heal/);
        t += 1;
        await heal(info);
        assert.equal(counter.provisions, 2);
        assert.equal(FUTILE_HEAL_TTL_MS, 30 * 60 * 1000);
    });

    test('selfHealMemoryKey keys on the decisive lines, not a shared long prefix', () => {
        const banner = `${'warning: some very long shell profile banner line that repeats on every command\n'.repeat(12)}`;
        assert.notEqual(
            selfHealMemoryKey('a', `${banner}fatal: unable to access 'https://h/': Could not resolve host`),
            selfHealMemoryKey('a', `${banner}fatal: Authentication failed`),
        );
        // hint/warning lines alone do not change the key
        assert.equal(
            selfHealMemoryKey('a', 'hint: try again\nerror: database is locked'),
            selfHealMemoryKey('a', 'warning: noise\nerror: database is locked'),
        );
    });

    test('selfHealMemoryKey keeps distinct exit codes distinct', () => {
        assert.notEqual(selfHealMemoryKey('a', '[Command Failed] Exit code 1: boom'), selfHealMemoryKey('a', '[Command Failed] Exit code 2: boom'));
        assert.equal(selfHealMemoryKey('a', 'exit status 3 at pid 10'), selfHealMemoryKey('a', 'exit status 3 at pid 99'));
    });

    test('every verdict classifyDoltFailure can return has an explicit neutral degraded kind', () => {
        for (const k of Object.values(K)) {
            const verdict = toDoltVerdict(k);
            assert.ok(Object.prototype.hasOwnProperty.call(NEUTRAL_KIND_MAP, verdict), `NEUTRAL_KIND_MAP lacks '${verdict}'`);
        }
        assert.equal(NEUTRAL_KIND_MAP['missing-tool'], 'unknown');
    });
});
