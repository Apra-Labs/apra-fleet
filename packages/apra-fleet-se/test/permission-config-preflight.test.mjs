import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getSeCommands, FILE_PROBE_PRESENT, FILE_PROBE_ABSENT } from '../fleet-sprint/se-os-commands.mjs';
import { createPermissionConfigPreflight, composeRoleForRoles } from '../fleet-sprint/member-provisioning.mjs';
import { MemberPermissionConfigError } from '../fleet-sprint/errors.mjs';
import { runDevelopLoopScenario, withScenarioMarkers, mockCmdResult } from './helpers/mock-sprint-harness.mjs';

// Member-init check for a dispatch member's composed per-folder permission
// config: a re-cloned work folder (git clean -xdf, fresh worktree) loses it,
// and the member's role then has its tool calls (bd included) refused as
// "requires approval". The preflight probes the provider's config file(s)
// reported by member_detail, re-composes a missing one with exactly one
// compose_permissions call for the member's role, and fails before any
// dispatch when that does not bring it back.

const CLAUDE_CFG = '.claude/settings.local.json';
const posix = getSeCommands({ os: 'linux', shell: 'bash' });
const powershell = getSeCommands({ os: 'windows', shell: 'powershell' });
const gitbash = getSeCommands({ os: 'windows', shell: 'gitbash' });

function decodePs(command) {
    const m = /^powershell -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command);
    assert.ok(m, `not a PowerShell -EncodedCommand envelope: ${command}`);
    return Buffer.from(m[1], 'base64').toString('utf16le');
}

function hasExe(cmd, args) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' });
    return !r.error && r.status === 0;
}

const tmpRoots = [];
after(() => {
    for (const d of tmpRoots) fs.rmSync(d, { recursive: true, force: true });
});

describe('fileExistsProbe command shape (built per member OS/shell)', () => {
    test('POSIX and gitbash: a [ -e ] test on the literal path, no member environment reads', () => {
        for (const se of [posix, gitbash]) {
            const cmd = se.fileExistsProbe(CLAUDE_CFG);
            assert.equal(cmd, `if [ -e '${CLAUDE_CFG}' ]; then echo ${FILE_PROBE_PRESENT}; else echo ${FILE_PROBE_ABSENT}; fi`);
            assert.ok(!/\$|~|`/.test(cmd), cmd);
        }
    });

    test('PowerShell: an -EncodedCommand Test-Path -LiteralPath probe, no $env:/~ reads', () => {
        const cmd = powershell.fileExistsProbe(CLAUDE_CFG);
        const script = decodePs(cmd);
        assert.ok(script.includes(`if (Test-Path -LiteralPath '${CLAUDE_CFG}') { Write-Output '${FILE_PROBE_PRESENT}' } else { Write-Output '${FILE_PROBE_ABSENT}' }`), script);
        assert.ok(!/\$env:|~\//.test(script), script);
    });

    test('refuses unsafe paths in every dialect', () => {
        for (const se of [posix, powershell, gitbash]) {
            for (const bad of ['../x', '/etc/passwd', '-rf', "a'b", 'a b', '$HOME/x']) {
                assert.throws(() => se.fileExistsProbe(bad), /unsafe file path/, bad);
            }
        }
    });

    test('bash: answers absent, then present once the file exists', { skip: !hasExe('bash', ['-c', 'true']) && 'no bash on this host' }, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-file-probe-'));
        tmpRoots.push(dir);
        const run = () => spawnSync('bash', ['-c', posix.fileExistsProbe(CLAUDE_CFG)], { cwd: dir, encoding: 'utf8' });
        let r = run();
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout.trim(), FILE_PROBE_ABSENT);
        fs.mkdirSync(path.join(dir, '.claude'));
        fs.writeFileSync(path.join(dir, CLAUDE_CFG), '{}');
        r = run();
        assert.equal(r.status, 0, r.stderr);
        assert.equal(r.stdout.trim(), FILE_PROBE_PRESENT);
    });
});

test('composeRoleForRoles: reviewer only when every role is review-only, else the doer superset', () => {
    assert.equal(composeRoleForRoles(['reviewer']), 'reviewer');
    assert.equal(composeRoleForRoles(['reviewer', 'plan-reviewer']), 'reviewer');
    assert.equal(composeRoleForRoles(['reviewer', 'doer']), 'doer');
    assert.equal(composeRoleForRoles(['planner']), 'doer');
    assert.equal(composeRoleForRoles([]), 'doer');
});

// A fake fleet: member_detail reports `paths` (per member) and the member's
// config file appears when compose_permissions runs (unless `composeFixes` is
// false). The probe is answered from that state.
function fakeFleet({ paths = { m1: [CLAUDE_CFG] }, present = {}, composeResult, composeFixes = true, detailText } = {}) {
    const state = { ...present };
    const composeCalls = [];
    const probes = [];
    const callTool = async (name, args) => {
        if (name === 'member_detail') {
            if (detailText !== undefined) return { content: [{ text: detailText }] };
            return { content: [{ text: JSON.stringify({ os: 'linux', permissionConfigPaths: paths[args.member_name] }) }] };
        }
        if (name === 'compose_permissions') {
            composeCalls.push(args);
            if (composeResult) return composeResult();
            if (composeFixes) state[args.member_name] = true;
            return { content: [{ text: '[OK] Permissions composed' }] };
        }
        throw new Error(`unexpected tool ${name}`);
    };
    const command = async (cmd, opts) => {
        probes.push({ cmd, member: opts.member_name });
        assert.ok(opts.member_name, 'every probe names its member');
        return { ok: true, output: state[opts.member_name] ? FILE_PROBE_PRESENT : FILE_PROBE_ABSENT };
    };
    return { callTool, command, composeCalls, probes };
}

const memberShellFor = (target) => async () => getSeCommands(target);

describe('createPermissionConfigPreflight', () => {
    test('missing config -> exactly one compose_permissions call for the member role, re-probed present', async () => {
        const f = fakeFleet();
        const logs = [];
        const check = createPermissionConfigPreflight({ callTool: f.callTool, command: f.command, memberShell: memberShellFor({ os: 'linux', shell: '' }), log: (l) => logs.push(l) });
        const res = await check(new Map([['m1', ['reviewer']]]));
        assert.deepEqual(f.composeCalls, [{ member_name: 'm1', role: 'reviewer' }]);
        assert.deepEqual(res.composed, ['m1']);
        assert.equal(f.probes.length, 2, 'probe, then re-probe');
        assert.ok(logs.some((l) => l.includes("member 'm1' is missing its composed permission config (.claude/settings.local.json)")), JSON.stringify(logs));
    });

    test('config present -> no compose_permissions call', async () => {
        const f = fakeFleet({ present: { m1: true } });
        const check = createPermissionConfigPreflight({ callTool: f.callTool, command: f.command, memberShell: memberShellFor({ os: 'linux', shell: '' }) });
        const res = await check(new Map([['m1', ['doer']]]));
        assert.equal(f.composeCalls.length, 0);
        assert.deepEqual(res.composed, []);
        assert.equal(f.probes.length, 1);
    });

    test('compose fails -> MemberPermissionConfigError naming member, file and fix', async () => {
        const f = fakeFleet({ composeResult: () => ({ isError: true, content: [{ text: '[FAIL] could not deliver config' }] }) });
        const check = createPermissionConfigPreflight({ callTool: f.callTool, command: f.command, memberShell: memberShellFor({ os: 'linux', shell: '' }) });
        await assert.rejects(check(new Map([['m1', ['doer']]])), (err) => {
            assert.ok(err instanceof MemberPermissionConfigError, String(err));
            assert.equal(err.member, 'm1');
            assert.deepEqual(err.files, [CLAUDE_CFG]);
            assert.match(err.message, /member 'm1'/);
            assert.match(err.message, /\.claude\/settings\.local\.json/);
            assert.match(err.message, /could not deliver config/);
            assert.match(err.message, /To fix: run compose_permissions for m1 with role doer/);
            return true;
        });
        assert.equal(f.composeCalls.length, 1);
    });

    test('compose succeeds but the file is still missing -> MemberPermissionConfigError', async () => {
        const f = fakeFleet({ composeFixes: false });
        const check = createPermissionConfigPreflight({ callTool: f.callTool, command: f.command, memberShell: memberShellFor({ os: 'linux', shell: '' }) });
        await assert.rejects(check(new Map([['m1', ['doer']]])), (err) => err instanceof MemberPermissionConfigError
            && /still missing after compose_permissions/.test(err.message) && /To fix: run compose_permissions for m1 with role doer/.test(err.message));
    });

    test('the probe is built per member OS/shell: a PowerShell member gets the encoded Test-Path probe', async () => {
        const f = fakeFleet({ present: { m1: true } });
        const check = createPermissionConfigPreflight({ callTool: f.callTool, command: f.command, memberShell: memberShellFor({ os: 'windows', shell: 'powershell' }) });
        await check(new Map([['m1', ['doer']]]));
        assert.equal(f.probes.length, 1);
        assert.match(decodePs(f.probes[0].cmd), /Test-Path -LiteralPath '\.claude\/settings\.local\.json'/);
    });

    test('the probed file comes from member_detail (the provider), never assumed to be Claude', async () => {
        const f = fakeFleet({ paths: { m1: ['.codex/config.toml'] }, present: { m1: true } });
        const check = createPermissionConfigPreflight({ callTool: f.callTool, command: f.command, memberShell: memberShellFor({ os: 'linux', shell: '' }) });
        await check(new Map([['m1', ['doer']]]));
        assert.equal(f.probes[0].cmd, posix.fileExistsProbe('.codex/config.toml'));
    });

    test('home-anchored and empty path lists are not probed, and trigger no compose', async () => {
        const f = fakeFleet({ paths: { m1: ['~/.gemini/config/projects/p.json'], m2: [] } });
        const logs = [];
        const check = createPermissionConfigPreflight({ callTool: f.callTool, command: f.command, memberShell: memberShellFor({ os: 'linux', shell: '' }), log: (l) => logs.push(l) });
        await check(new Map([['m1', ['doer']], ['m2', ['doer']]]));
        assert.equal(f.probes.length, 0);
        assert.equal(f.composeCalls.length, 0);
        assert.ok(logs.some((l) => l.includes('home-anchored')), JSON.stringify(logs));
    });

    test('member_detail without permissionConfigPaths (older server) is a WARNING, not a failure', async () => {
        const f = fakeFleet({ detailText: JSON.stringify({ os: 'linux' }) });
        const logs = [];
        const check = createPermissionConfigPreflight({ callTool: f.callTool, command: f.command, memberShell: memberShellFor({ os: 'linux', shell: '' }), log: (l) => logs.push(l) });
        await check(new Map([['m1', ['doer']]]));
        assert.equal(f.probes.length, 0);
        assert.ok(logs.some((l) => l.startsWith('[permission-config] WARNING:') && l.includes("member 'm1'")), JSON.stringify(logs));
    });

    test('a probe that fails or answers garbage fails the preflight naming member and file', async () => {
        const f = fakeFleet();
        const check = createPermissionConfigPreflight({
            callTool: f.callTool,
            command: async () => ({ ok: false, error: 'Exit code: 127 sh: bash: not found' }),
            memberShell: memberShellFor({ os: 'linux', shell: '' }),
        });
        await assert.rejects(check(new Map([['m1', ['doer']]])), (err) => err instanceof MemberPermissionConfigError && /its probe failed/.test(err.message) && err.member === 'm1');
        const g = createPermissionConfigPreflight({
            callTool: f.callTool,
            command: async () => ({ ok: true, output: 'banner' }),
            memberShell: memberShellFor({ os: 'linux', shell: '' }),
        });
        await assert.rejects(g(new Map([['m1', ['doer']]])), (err) => err instanceof MemberPermissionConfigError && /its probe answered 'banner'/.test(err.message));
    });
});

// Runner-level: the check runs in the sprint member preflight, before the
// first dispatch.
function isPermissionProbe(cmd) {
    return String(cmd).includes(CLAUDE_CFG) && String(cmd).includes(FILE_PROBE_PRESENT);
}

function scenarioFleet({ composeResult } = {}) {
    const st = { present: false, composeCalls: [], events: [] };
    const callTool = async (name, args) => {
        if (name === 'member_detail') {
            return { content: [{ text: JSON.stringify({ os: 'linux', permissionConfigPaths: [CLAUDE_CFG] }) }] };
        }
        if (name === 'compose_permissions') {
            st.composeCalls.push(args);
            st.events.push('compose');
            if (composeResult) return composeResult();
            st.present = true;
            return { content: [{ text: '[OK] Permissions composed' }] };
        }
        return { content: [{ text: `mock ${name}` }] };
    };
    const onCommand = async ({ command }) => {
        if (!isPermissionProbe(command)) return undefined;
        st.events.push('probe');
        return mockCmdResult(0, st.present ? FILE_PROBE_PRESENT : FILE_PROBE_ABSENT, '');
    };
    return { st, callTool, onCommand };
}

test('mock sprint: a dispatch member missing its permission config gets exactly one compose_permissions call before any dispatch, and the sprint proceeds', async () => {
    await withScenarioMarkers('permcfg-recompose', async () => {
        const f = scenarioFleet();
        const r = await runDevelopLoopScenario('permcfg-recompose', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permission config re-compose' }],
            maxCycles: 1,
            callTool: f.callTool,
            onCommand: f.onCommand,
        });
        assert.equal(f.st.composeCalls.length, 1, `expected exactly one compose_permissions call, got ${JSON.stringify(f.st.composeCalls)}`);
        assert.equal(f.st.composeCalls[0].member_name, 'local');
        assert.equal(f.st.composeCalls[0].role, 'doer');
        assert.deepEqual(f.st.events, ['probe', 'compose', 'probe']);
        assert.ok(r.logs.some((l) => l.includes("member 'local': permission config re-composed")), 'expected the re-compose log line');
        assert.ok(r.dispatched.length > 0, 'the sprint dispatched after the re-compose');
    });
});

test('mock sprint: compose_permissions failing fails the sprint at preflight naming member, file and fix, with zero dispatches', async () => {
    await withScenarioMarkers('permcfg-fail', async () => {
        const f = scenarioFleet({ composeResult: () => ({ isError: true, content: [{ text: '[FAIL] member unreachable' }] }) });
        const r = await runDevelopLoopScenario('permcfg-fail', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permission config re-compose failure' }],
            maxCycles: 1,
            callTool: f.callTool,
            onCommand: f.onCommand,
        });
        assert.ok(r.error instanceof MemberPermissionConfigError, `expected MemberPermissionConfigError, got ${r.error && (r.error.constructor.name + ': ' + r.error.message)}`);
        assert.match(r.error.message, /member 'local'/);
        assert.match(r.error.message, /\.claude\/settings\.local\.json/);
        assert.match(r.error.message, /To fix: run compose_permissions for local with role doer/);
        assert.equal(r.dispatched.length, 0, `expected zero dispatches, got ${r.dispatched.length}`);
    });
});

test('mock sprint: a dispatch member whose permission config is present triggers no compose_permissions call', async () => {
    await withScenarioMarkers('permcfg-present', async () => {
        const f = scenarioFleet();
        f.st.present = true;
        const r = await runDevelopLoopScenario('permcfg-present', {
            members: ['local'],
            taskSpecs: [{ title: 'Task: permission config present' }],
            maxCycles: 1,
            callTool: f.callTool,
            onCommand: f.onCommand,
        });
        assert.equal(f.st.composeCalls.length, 0);
        assert.deepEqual(f.st.events, ['probe']);
        assert.ok(r.dispatched.length > 0);
    });
});
