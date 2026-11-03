import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitSync, createSyncBrackets } from '../fleet-sprint/git-sync.mjs';
import { createVcsAuthPreflightCallback, createVcsAuthSelfHealCallback, VCS_CREDENTIAL_PROBE_FAILED, VCS_MEMBER_LOOKUP_FAILED } from '../fleet-sprint/vcs-auth.mjs';
import { getVcsProvider } from '../fleet-sprint/vcs-module.mjs';
import { getSeCommands } from '../fleet-sprint/se-os-commands.mjs';
import { preflightBeadsHealthGate, invalidateSyncRemoteCache, clearLastSyncedTip, clearTipProbeFailures } from '../fleet-sprint/dolt-sync.mjs';
import { DoltSyncError, UnpublishedSchemaMigrationsError } from '../fleet-sprint/errors.mjs';

// =============================================================================
// Three small contracts, all driven with a stubbed command()/callTool (no real
// bd or fleet server -- "recorded/stubbed command sequence" rather than a
// real-bd older-schema fixture, which the real-bd lane cannot produce cheaply):
//
//   A. every "needs a fresh VCS credential" preflight line (Plan-style
//      beads-only dispatch AND Develop-style code dispatch) is followed by
//      exactly one outcome line: provisioned / skipped(reason) / failed.
//   B. the backlog member's beads D-pull/D-push (createGitSync.syncBeadsBefore
//      / syncBeadsAfter / pushBeadsAfter, which bypass withGitSync) run
//      ensureVcsAuthFresh first and heal an auth failure via onAuthFailure.
//   C. preflightBeadsHealthGate publishes unpushed local schema migrations
//      ("local changes would be stomped by merge: events") and retries once,
//      or fails with a typed error naming the cause and the fix.
// =============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OK = { ok: true, output: '', error: null };
const fail = (error) => ({ ok: false, output: '', error });

beforeEach(() => {
    invalidateSyncRemoteCache();
    clearLastSyncedTip();
    clearTipProbeFailures();
});

function makeCommandMock(script = {}) {
    const calls = [];
    const queues = new Map(Object.entries(script).map(([k, v]) => [k, [...v]]));
    const command = async (cmd, opts = {}) => {
        calls.push({ cmd, opts });
        for (const [key, queue] of queues) {
            if (cmd.includes(key)) return queue.length > 1 ? queue.shift() : queue[0];
        }
        if (cmd.includes('bd config get sync.remote')) return { ok: true, output: '{"value":"origin"}', error: null };
        return OK;
    };
    return { command, calls };
}

const MEMBER_DETAIL_GITHUB = { content: [{ text: JSON.stringify({ vcsProvider: 'github' }) }] };
const remoteCommand = async (cmd) => (cmd === 'git remote get-url origin'
    ? { ok: true, output: 'https://github.com/acme/widgets.git', error: null }
    : OK);
const expiryIn = (ms) => new Date(Date.now() + ms).toISOString();
const provisioned = (expiresAt) => ({ content: [{ text: 'ok' }], structuredContent: { ok: true, reason: 'ok', expiresAt } });

function makeSync({ callTool, withEnsure = true } = {}) {
    const logs = [];
    const log = (m) => logs.push(m);
    const { command, calls } = makeCommandMock();
    const ensureVcsAuthFresh = createVcsAuthPreflightCallback({ callTool, command: remoteCommand, log });
    const gitSync = createGitSync({
        brackets: createSyncBrackets({ setPauseGuard: () => {} }),
        command, log, branch: 'b', baseBranch: 'main', args: {},
        agent: async () => ({}), doltPushMutex: undefined, sprintId: 's',
        onAuthFailure: undefined, resolveMemberProvider: undefined,
        ensureVcsAuthFresh: withEnsure ? ensureVcsAuthFresh : undefined,
        syncMemberBefore: async () => {}, syncMemberAfter: async () => {},
        syncMemberAfterOrdered: async () => {}, isNoMutationDispatchFailure: () => false,
    });
    return { gitSync, logs, calls };
}

const needsIdx = (logs) => logs.map((l, i) => (/needs a fresh VCS credential/.test(l) ? i : -1)).filter((i) => i >= 0);
const OUTCOME = /provision_vcs_auth (succeeded|skipped|failed) for member/;
/** Lines after the "needs" line at `i` (up to the next "needs" line) that are outcome lines. */
const outcomesAfter = (logs, i) => {
    const next = needsIdx(logs).find((n) => n > i) ?? logs.length;
    return logs.slice(i + 1, next).filter((l) => OUTCOME.test(l));
};

describe('A. needsVcsAuth preflight always states an outcome', () => {
    const dispatches = [
        ['Plan-style (beads-only)', false, true],
        ['Develop-style (code)', true, true],
    ];
    for (const [label, pushCode, pushBeads] of dispatches) {
        test(`${label}: provisions on first call, then skips with the cached-fresh reason`, async () => {
            const provisionCalls = [];
            const callTool = async (name, a) => {
                if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
                provisionCalls.push(a);
                return provisioned(expiryIn(60 * 60 * 1000));
            };
            const { gitSync, logs } = makeSync({ callTool });
            await gitSync.withGitSync('m1', pushCode, async () => 'r', { pushBeads });
            await gitSync.withGitSync('m1', pushCode, async () => 'r', { pushBeads });
            assert.equal(provisionCalls.length, 1, 'provision_vcs_auth called exactly once');
            const needs = needsIdx(logs);
            assert.equal(needs.length, 2);
            const first = outcomesAfter(logs, needs[0]);
            const second = outcomesAfter(logs, needs[1]);
            assert.equal(first.length, 1, `exactly one outcome after first needs line: ${JSON.stringify(first)}`);
            assert.match(first[0], /succeeded/);
            assert.equal(second.length, 1, `exactly one outcome after second needs line: ${JSON.stringify(second)}`);
            assert.match(second[0], /skipped.*cached credential fresh until/);
        });
    }

    test('PAT/no-expiry: second call skips and says PAT mode', async () => {
        const callTool = async (name) => (name === 'member_detail' ? MEMBER_DETAIL_GITHUB : provisioned(null));
        const { gitSync, logs } = makeSync({ callTool });
        await gitSync.withGitSync('m1', true, async () => 'r');
        await gitSync.withGitSync('m1', true, async () => 'r');
        const needs = needsIdx(logs);
        assert.match(outcomesAfter(logs, needs[1])[0], /skipped.*PAT mode/);
        assert.equal(outcomesAfter(logs, needs[1]).length, 1);
    });

    test('provision failure: one failed outcome line with the error, dispatch still runs', async () => {
        const callTool = async (name) => {
            if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
            throw new Error('fleet server unreachable (injected)');
        };
        const { gitSync, logs } = makeSync({ callTool });
        let ran = false;
        await gitSync.withGitSync('m1', true, async () => { ran = true; });
        assert.ok(ran);
        const out = outcomesAfter(logs, needsIdx(logs)[0]);
        assert.equal(out.length, 1);
        assert.match(out[0], /failed.*fleet server unreachable/);
    });

    test('no-callTool wiring: runner.js fallback logs a skip reason instead of returning silently', () => {
        const src = fs.readFileSync(path.join(__dirname, '../fleet-sprint/runner.js'), 'utf8');
        assert.match(src, /provision_vcs_auth skipped for member '\$\{member\}': no callTool wired/);
    });
});

describe('B. backlog member beads sync refreshes its credential', () => {
    test('ensureVcsAuthFresh precedes the readiness-gate D-pull (first beads sync of the sprint)', async () => {
        const order = [];
        const { command } = makeCommandMock();
        const tracked = async (cmd, o) => { order.push(`cmd:${cmd}`); return command(cmd, o); };
        const gitSync = createGitSync({
            brackets: createSyncBrackets({ setPauseGuard: () => {} }),
            command: tracked, log: () => {}, branch: 'b', args: {}, doltPushMutex: undefined, sprintId: 's',
            ensureVcsAuthFresh: async (m) => { order.push(`ensure:${m}`); },
        });
        await gitSync.syncBeadsBefore('backlog', { readinessGate: true });
        assert.equal(order[0], 'ensure:backlog');
        assert.ok(order.some((c) => c.startsWith('cmd:') && c.includes('bd dolt pull')));
    });

    test('expired-token D-push is classified auth, provisions, retries once, no DEGRADED record', async () => {
        const AUTH = 'Error 1105: could not read Username for \'https://github.com\': terminal prompts disabled';
        const { command, calls } = makeCommandMock({ 'bd dolt push': [fail(AUTH), OK] });
        let healed = 0;
        const onAuthFailure = async () => { healed += 1; };
        const gitSync = createGitSync({
            brackets: createSyncBrackets({ setPauseGuard: () => {} }),
            command, log: () => {}, branch: 'b', args: {}, doltPushMutex: undefined, sprintId: 's',
            onAuthFailure, ensureVcsAuthFresh: async () => {},
        });
        const res = await gitSync.syncBeadsAfter('backlog', { pushBeads: true });
        assert.equal(healed, 1, 'onAuthFailure heal ran once');
        assert.equal(calls.filter((c) => c.cmd.includes('bd dolt push')).length, 2, 'one retry');
        assert.ok(!res || !res.degraded, `not degraded: ${JSON.stringify(res)}`);
    });

    test('while fresh, repeated backlog syncs make no extra provision_vcs_auth calls', async () => {
        let provisions = 0;
        const callTool = async (name) => {
            if (name === 'member_detail') return MEMBER_DETAIL_GITHUB;
            provisions += 1;
            return provisioned(expiryIn(60 * 60 * 1000));
        };
        const { gitSync } = makeSync({ callTool });
        await gitSync.syncBeadsBefore('backlog', { readinessGate: true });
        await gitSync.syncBeadsBefore('backlog', { fatal: true });
        await gitSync.syncBeadsAfter('backlog', { pushBeads: true });
        await gitSync.pushBeadsAfter('backlog', { pushBeads: true });
        assert.equal(provisions, 1);
    });
});

describe('C. migrated-but-unpushed beads clone at the preflight D-pull', () => {
    const STOMPED = 'Error: merge origin/main: Error 1105: error: local changes would be stomped by merge: events';

    test('stomped-by-merge on first pull -> one push under the mutex, second pull, gate passes', async () => {
        const { command, calls } = makeCommandMock({ 'bd dolt pull': [fail(STOMPED), OK], 'bd dolt push': [OK] });
        const mutexEvents = [];
        const mutex = {
            acquire: async () => { mutexEvents.push('acquire'); return { token: 't' }; },
            release: async () => { mutexEvents.push('release'); },
        };
        const res = await preflightBeadsHealthGate('backlog', { command, mutex, sprintId: 's', remoteTipFingerprint: false });
        assert.equal(res.ok, true);
        const seq = calls.map((c) => c.cmd).filter((c) => /bd dolt (pull|push)/.test(c));
        assert.deepEqual(seq.map((c) => c.match(/bd dolt (pull|push)/)[1]), ['pull', 'push', 'pull']);
        assert.ok(mutexEvents.includes('acquire') && mutexEvents.includes('release'), 'publish took the push mutex');
    });

    test('push fails -> UnpublishedSchemaMigrationsError naming cause and fix, not a bare D-pull message', async () => {
        const { command } = makeCommandMock({
            'bd dolt pull': [fail(STOMPED)],
            'bd dolt push': [fail('Error 1105: could not read Username for \'https://github.com\': terminal prompts disabled')],
        });
        await assert.rejects(
            () => preflightBeadsHealthGate('backlog', { command, remoteTipFingerprint: false }),
            (err) => {
                assert.ok(err instanceof UnpublishedSchemaMigrationsError, String(err));
                assert.ok(err instanceof DoltSyncError);
                assert.match(err.message, /unpublished local schema migrations/);
                assert.match(err.message, /bd dolt push/);
                assert.match(err.message, /provision_vcs_auth/);
                return true;
            },
        );
    });

    test('other D-pull failures keep their handling (no publish attempted)', async () => {
        const { command, calls } = makeCommandMock({ 'bd dolt pull': [fail('Error 1105: some unrelated failure')] });
        await assert.rejects(
            () => preflightBeadsHealthGate('backlog', { command, remoteTipFingerprint: false, maxTransientRetries: 0 }),
            (err) => err instanceof DoltSyncError && !(err instanceof UnpublishedSchemaMigrationsError),
        );
        assert.equal(calls.filter((c) => c.cmd.includes('bd dolt push')).length, 0);
    });

    test('syncBeadsBefore readinessGate: auth precedes the first pull and a stomped pull is healed (3 ordering)', async () => {
        const order = [];
        const { command } = makeCommandMock({ 'bd dolt pull': [fail(STOMPED), OK] });
        const tracked = async (cmd, o) => { order.push(cmd.includes('bd dolt') ? cmd : null); return command(cmd, o); };
        const gitSync = createGitSync({
            brackets: createSyncBrackets({ setPauseGuard: () => {} }),
            command: tracked, log: () => {}, branch: 'b', args: {}, doltPushMutex: undefined, sprintId: 's',
            ensureVcsAuthFresh: async () => { order.push('ensure'); },
        });
        await gitSync.syncBeadsBefore('backlog', { readinessGate: true });
        const flat = order.filter(Boolean);
        assert.equal(flat[0], 'ensure');
        assert.ok(flat.filter((c) => c.includes('bd dolt push')).length === 1);
    });
});

// apra-fleet-d1pk.4: probe-first VCS preflight for members whose credential
// the fleet cannot mint (provider authRemedy.serverSideReMintable === false,
// e.g. Bitbucket). Driven through the REAL createVcsAuthPreflightCallback and
// the REAL createGitSync beads brackets (syncBeadsBefore/After), so a revert
// of the probe-first branch in vcs-auth.mjs turns these red.
describe('D. probe-first preflight for non-re-mintable members (Bitbucket)', () => {
    const BB_REMOTE = { ok: true, output: 'https://bitbucket.org/acme/widgets.git', error: null };
    const BITBUCKET_HINT = getVcsProvider('bitbucket').authRemedy.hint;
    const isProbe = (cmd) => cmd.includes('git ls-remote origin');

    function makeProbeSync({ record, probe, store = ['bitbucket_api_token'], provisionResult = provisioned(null), remote = BB_REMOTE }) {
        const tools = [];
        const callTool = async (name, args) => {
            tools.push({ name, args });
            if (name === 'member_detail') return { content: [{ text: JSON.stringify(record) }] };
            if (name === 'credential_store_list') return { content: [{ text: JSON.stringify(store.map((n) => ({ name: n }))) }] };
            return provisionResult;
        };
        const logs = [];
        const log = (m) => logs.push(m);
        const { command, calls } = makeCommandMock({ 'git ls-remote origin': [probe], 'git remote get-url origin': [remote] });
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({ callTool, command, log });
        const gitSync = createGitSync({
            brackets: createSyncBrackets({ setPauseGuard: () => {} }),
            command, log, branch: 'b', baseBranch: 'main', args: {},
            agent: async () => ({}), doltPushMutex: undefined, sprintId: 's',
            onAuthFailure: undefined, resolveMemberProvider: undefined, ensureVcsAuthFresh,
            syncMemberBefore: async () => {}, syncMemberAfter: async () => {},
            syncMemberAfterOrdered: async () => {}, isNoMutationDispatchFailure: () => false,
        });
        const threeBrackets = async (member) => {
            await gitSync.syncBeadsBefore(member, { readinessGate: true });
            await gitSync.syncBeadsBefore(member, { fatal: true });
            await gitSync.syncBeadsAfter(member, { pushBeads: true });
        };
        return { gitSync, threeBrackets, ensureVcsAuthFresh, tools, logs, calls };
    }

    const LOCAL_BB = { type: 'local', os: 'linux', vcsProvider: 'bitbucket' };
    const provisionCalls = (tools) => tools.filter((t) => t.name === 'provision_vcs_auth');

    test('local Bitbucket member, probe ok: three brackets -> zero provision_vcs_auth calls, exactly one probe', async () => {
        const { threeBrackets, tools, calls } = makeProbeSync({ record: LOCAL_BB, probe: OK });
        await threeBrackets('backlog');
        assert.equal(provisionCalls(tools).length, 0, `provision_vcs_auth called: ${JSON.stringify(provisionCalls(tools))}`);
        assert.equal(calls.filter((c) => isProbe(c.cmd)).length, 1, 'exactly one credential probe per run');
        assert.ok(calls.some((c) => c.cmd.includes('bd dolt pull')), 'the brackets still ran their beads sync');
    });

    test('local Bitbucket member, probe fails: three brackets -> exactly one typed ASCII error with the Bitbucket remedy, no provisioning', async () => {
        // A non-ASCII char in git's output must not reach the log line.
        const probe = fail("fatal: Authentication failed for 'https://bitbucket.org/acme/widgets.git/' \u2014 denied");
        const { threeBrackets, tools, logs, calls } = makeProbeSync({ record: LOCAL_BB, probe });
        await threeBrackets('backlog');
        const errors = logs.filter((l) => l.includes(VCS_CREDENTIAL_PROBE_FAILED));
        assert.equal(errors.length, 1, `expected one typed error line, got:\n${errors.join('\n')}`);
        const line = errors[0];
        assert.ok([...line].every((ch) => ch.charCodeAt(0) < 128), `non-ASCII in: ${line}`);
        assert.match(line, /ERROR vcs_credential_probe_failed: local member 'backlog' \(provider 'bitbucket'\)/);
        assert.ok(line.includes(BITBUCKET_HINT), 'names the Bitbucket remedy hint');
        assert.match(line, /Authentication failed/, 'carries the probe detail');
        assert.equal(provisionCalls(tools).length, 0, 'a local member is never provisioned (would overwrite the host credential)');
        assert.equal(calls.filter((c) => isProbe(c.cmd)).length, 1, 'never re-probed this run');
    });

    test('local member probe failure names the by-hand re-provision a 0.4.4-provisioned local member needs', async () => {
        const { threeBrackets, logs } = makeProbeSync({ record: LOCAL_BB, probe: fail('fatal: Authentication failed') });
        await threeBrackets('backlog');
        const line = logs.find((l) => l.includes(VCS_CREDENTIAL_PROBE_FAILED));
        assert.ok(line, logs.join('\n'));
        assert.match(line, /provisioned by fleet 0\.4\.4/);
        assert.match(line, /re-provisioned by hand/);
        assert.ok(
            line.includes('provision_vcs_auth member_name=MEMBER provider=bitbucket workspace=WORKSPACE api_token={{secret.bitbucket_api_token}}'),
            'gives the exact re-provision command',
        );
    });

    test('probe command sets GIT_TERMINAL_PROMPT=0 and GCM_INTERACTIVE=never, no credential.helper override, posix and powershell', async () => {
        const decode = (cmd) => {
            const m = /^powershell -EncodedCommand (\S+)$/.exec(cmd);
            assert.ok(m, `expected an encoded PowerShell envelope, got: ${cmd}`);
            return Buffer.from(m[1], 'base64').toString('utf16le');
        };
        const posix = getSeCommands({ os: 'linux' }).gitLsRemoteProbe();
        const gitbash = getSeCommands({ os: 'windows', shell: 'gitbash' }).gitLsRemoteProbe();
        const ps = decode(getSeCommands({ os: 'windows', shell: '' }).gitLsRemoteProbe());
        for (const script of [posix, gitbash]) {
            assert.ok(script.includes('GIT_TERMINAL_PROMPT=0'), script);
            assert.ok(script.includes('GCM_INTERACTIVE=never'), script);
            assert.ok(script.includes('git ls-remote origin'), script);
            assert.ok(!script.includes('credential.helper'), script);
        }
        assert.match(ps, /\$env:GIT_TERMINAL_PROMPT='0'/);
        assert.match(ps, /\$env:GCM_INTERACTIVE='never'/);
        assert.ok(ps.includes('git ls-remote origin') && !ps.includes('credential.helper'), ps);

        // And the callback actually dispatches the member's own dialect.
        const { ensureVcsAuthFresh, calls } = makeProbeSync({ record: { ...LOCAL_BB, os: 'windows', shell: 'powershell5' }, probe: OK });
        // The command mock's key match cannot see inside the encoding, so
        // every non-matching command (the probe included) answers OK.
        await ensureVcsAuthFresh('win-backlog');
        const issued = calls.map((c) => c.cmd).filter((c) => c.startsWith('powershell -EncodedCommand '));
        assert.equal(issued.length, 1, `expected one PowerShell probe, got: ${JSON.stringify(calls.map((c) => c.cmd))}`);
        assert.equal(decode(issued[0]), ps);
    });

    test('remote Bitbucket member, failed probe: one non-interactive provision with workspace and api_token placeholder, no email; not repeated', async () => {
        const { threeBrackets, tools, logs } = makeProbeSync({
            record: { type: 'ssh', os: 'linux', vcsProvider: 'bitbucket' },
            probe: fail('fatal: Authentication failed'),
        });
        await threeBrackets('bb-remote');
        const provs = provisionCalls(tools);
        assert.equal(provs.length, 1, 'exactly one provisioning attempt per run');
        assert.deepEqual(provs[0].args, {
            member_name: 'bb-remote',
            provider: 'bitbucket',
            git_access: 'push',
            repos: ['acme/widgets'],
            workspace: 'acme',
            api_token: '{{secret.bitbucket_api_token}}',
            non_interactive: true,
        });
        assert.ok(!JSON.stringify(provs[0].args).includes('email'), 'no email field / missing-email path');
        assert.equal(logs.filter((l) => l.includes(VCS_CREDENTIAL_PROBE_FAILED)).length, 0, 'a successful provision logs no error');
    });

    test('remote Bitbucket member whose provision also fails: one typed error, provision attempted once, non-interactive', async () => {
        const { threeBrackets, tools, logs } = makeProbeSync({
            record: { type: 'ssh', os: 'linux', vcsProvider: 'bitbucket' },
            probe: fail('fatal: Authentication failed'),
            provisionResult: { content: [{ text: '[FAIL] api_token missing' }], structuredContent: { ok: false, reason: 'credential_missing' } },
        });
        await threeBrackets('bb-remote');
        const provs = provisionCalls(tools);
        assert.equal(provs.length, 1);
        assert.equal(provs[0].args.non_interactive, true);
        const errors = logs.filter((l) => l.includes(VCS_CREDENTIAL_PROBE_FAILED));
        assert.equal(errors.length, 1, errors.join('\n'));
        assert.ok(errors[0].includes(BITBUCKET_HINT));
    });

    test('regression: GitHub-App local backlog member with an expiring cached credential still calls provision_vcs_auth, never probes', async () => {
        const { ensureVcsAuthFresh, tools, calls } = makeProbeSync({
            record: { type: 'local', os: 'linux', vcsProvider: 'github' },
            probe: OK,
            remote: { ok: true, output: 'https://github.com/acme/widgets.git', error: null },
            // Inside the 10-minute expiring-soon window, so every call refreshes.
            provisionResult: provisioned(expiryIn(5 * 60 * 1000)),
        });
        await ensureVcsAuthFresh('gh-backlog');
        await ensureVcsAuthFresh('gh-backlog');
        const provs = provisionCalls(tools);
        assert.equal(provs.length, 2, 'expiring credential re-provisioned on the second call');
        assert.equal(provs[0].args.github_mode, 'github-app');
        assert.equal(provs[0].args.non_interactive, true);
        assert.equal(calls.filter((c) => isProbe(c.cmd)).length, 0, 'a GitHub-App member is never probed');
    });

    test('reactive self-heal refuses to re-provision a LOCAL Bitbucket member (would overwrite the host credential)', async () => {
        const tools = [];
        const callTool = async (name, args) => {
            tools.push({ name, args });
            if (name === 'member_detail') return { content: [{ text: JSON.stringify(LOCAL_BB) }] };
            return provisioned(null);
        };
        const onAuthFailure = createVcsAuthSelfHealCallback({ callTool, command: async () => BB_REMOTE, log: () => {} });
        await assert.rejects(
            () => onAuthFailure({ member: 'backlog', label: 'D-push', error: 'fatal: Authentication failed' }),
            /local member on 'bitbucket': not re-provisioning it/,
        );
        assert.equal(provisionCalls(tools).length, 0);
    });

    // The local-member guard must fail CLOSED: when member_detail cannot say
    // whether the member is local, nothing is provisioned (a local member's
    // provision would overwrite the host's own credential helper).
    // `failFirst` rejects the first N member_detail calls, then answers LOCAL_BB,
    // so a later lookup inside the provisioning path could succeed.
    function flakyMemberDetail(failFirst) {
        const tools = [];
        let detailCalls = 0;
        const callTool = async (name, args) => {
            tools.push({ name, args });
            if (name === 'member_detail') {
                detailCalls += 1;
                if (detailCalls <= failFirst) throw new Error('fleet server transiently unreachable');
                return { content: [{ text: JSON.stringify(LOCAL_BB) }] };
            }
            if (name === 'credential_store_list') return { content: [{ text: JSON.stringify([{ name: 'bitbucket_api_token' }]) }] };
            return provisioned(null);
        };
        return { tools, callTool };
    }
    const isAscii = (s) => [...s].every((ch) => ch.charCodeAt(0) < 128);

    test('preflight: member_detail fails -> no provisioning, one typed ASCII error naming the member', async () => {
        const { tools, callTool } = flakyMemberDetail(1);
        const logs = [];
        const { command } = makeCommandMock({ 'git ls-remote origin': [OK], 'git remote get-url origin': [BB_REMOTE] });
        const ensureVcsAuthFresh = createVcsAuthPreflightCallback({ callTool, command, log: (m) => logs.push(m) });
        await ensureVcsAuthFresh('bb-local');
        assert.equal(provisionCalls(tools).length, 0, `provisioned despite an unknown member type: ${JSON.stringify(provisionCalls(tools))}`);
        const errors = logs.filter((l) => l.includes(VCS_MEMBER_LOOKUP_FAILED));
        assert.equal(errors.length, 1, `expected one typed error line, got:\n${logs.join('\n')}`);
        assert.match(errors[0], /ERROR vcs_member_lookup_failed: .*member 'bb-local'/);
        assert.ok(isAscii(errors[0]), `non-ASCII in: ${errors[0]}`);
    });

    test('self-heal: provider resolves but the local-member lookup fails -> typed error naming the member, no provisioning', async () => {
        // Call 1 (resolveProvider) succeeds, call 2 (the local check) fails.
        const tools = [];
        let detailCalls = 0;
        const callTool = async (name, args) => {
            tools.push({ name, args });
            if (name === 'member_detail') {
                detailCalls += 1;
                if (detailCalls === 2) throw new Error('fleet server transiently unreachable');
                return { content: [{ text: JSON.stringify(LOCAL_BB) }] };
            }
            return provisioned(null);
        };
        const onAuthFailure = createVcsAuthSelfHealCallback({ callTool, command: async () => BB_REMOTE, log: () => {} });
        await assert.rejects(
            () => onAuthFailure({ member: 'bb-local', label: 'D-push', error: 'fatal: Authentication failed' }),
            (err) => err.code === VCS_MEMBER_LOOKUP_FAILED && /member 'bb-local'/.test(err.message) && isAscii(err.message),
        );
        assert.equal(provisionCalls(tools).length, 0);
    });

    test('self-heal: provider resolution fails, a later lookup says local Bitbucket -> refused, no provisioning', async () => {
        const { tools, callTool } = flakyMemberDetail(1);
        const onAuthFailure = createVcsAuthSelfHealCallback({ callTool, command: async () => BB_REMOTE, log: () => {} });
        await assert.rejects(
            () => onAuthFailure({ member: 'bb-local', label: 'D-push', error: 'fatal: Authentication failed' }),
            /local member on 'bitbucket': not re-provisioning it/,
        );
        assert.equal(provisionCalls(tools).length, 0);
    });
});
