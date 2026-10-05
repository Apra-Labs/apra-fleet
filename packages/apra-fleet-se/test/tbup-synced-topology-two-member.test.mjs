import { test, describe } from 'node:test';
import assert from 'node:assert';

import { checkMemberTopology, commandResultStdout } from '../fleet-sprint/git-topology.mjs';

// Synced-mode launch (POST /api/sprints {sync:true} -> --sync, pinned by
// supervisor-api-sync-argv.test.mjs) -> cli.mjs synced mode -> this test:
// two members on different HEADs and the same origin must pass the topology
// check even when one member is a Windows-like CRLF + stderr-warning member.

const URL_ = 'https://example.com/org/repo.git';
const WARN = 'warning: safe.directory ... not absolute';

const linuxOrigin = {
    content: [{ type: 'text', text: `Exit code: 0\n${URL_}\n` }],
    structuredContent: { exitCode: 0, stdout: `${URL_}\n`, stderr: '' },
};
const windowsOrigin = {
    content: [{ type: 'text', text: `Exit code: 0\r\n${URL_}\r\n${WARN}\r\n` }],
    structuredContent: { exitCode: 0, stdout: `${URL_}\r\n`, stderr: WARN },
};
const ok = (out) => ({
    content: [{ type: 'text', text: `Exit code: 0\n${out}\n` }],
    structuredContent: { exitCode: 0, stdout: `${out}\n`, stderr: '' },
});
const failed = {
    content: [{ type: 'text', text: 'Exit code: 128\nfatal: No such remote' }],
    structuredContent: { exitCode: 128, stdout: '', stderr: 'fatal: No such remote' },
};

// Mirrors cli.mjs's wiring: every probe goes through the helper.
function build(results, { raw = false } = {}) {
    const conv = raw ? (r) => r.content[0].text : commandResultStdout;
    const run = (member, cmd) => {
        const r = results[member][cmd];
        return conv(r);
    };
    return {
        members: ['lin', 'win'],
        getIdentity: async (m) => run(m, 'head'),
        getOriginUrl: async (m) => run(m, 'origin'),
        doltProbe: async (m) => run(m, 'dolt'),
    };
}
const base = () => ({
    lin: { head: ok('a'.repeat(40)), origin: linuxOrigin, dolt: ok('') },
    win: { head: ok('b'.repeat(40)), origin: windowsOrigin, dolt: ok('') },
});

describe('synced topology, two members, differing HEADs, same origin', () => {
    test('synced mode passes', async () => {
        const r = await checkMemberTopology({ ...build(base()), mode: 'synced' });
        assert.strictEqual(r.ok, true);
        assert.strictEqual(r.singleMember, false);
        assert.match(r.message, /\[Topology\] Synced mode: all 2 configured members share origin/);
    });

    test('legacy mode on the same inputs is refused', async () => {
        const r = await checkMemberTopology({ ...build(base()), mode: 'legacy' });
        assert.strictEqual(r.ok, false);
        assert.match(r.message, /legacy mode/);
    });

    test('non-zero exit on one member origin probe is refused, naming the member', async () => {
        const res = base();
        res.win.origin = failed;
        const r = await checkMemberTopology({ ...build(res), mode: 'synced' });
        assert.strictEqual(r.ok, false);
        assert.match(r.message, /win: origin URL unavailable/);
        assert.match(r.message, /128/);
    });

    test('feeding the raw envelope text instead of the helper output fails the synced pass', async () => {
        const r = await checkMemberTopology({ ...build(base(), { raw: true }), mode: 'synced' });
        assert.strictEqual(r.ok, false);
    });
});

describe('commandResultStdout', () => {
    test('LF and CRLF of one URL give the same trimmed string; stderr ignored', () => {
        assert.strictEqual(commandResultStdout(linuxOrigin), URL_);
        assert.strictEqual(commandResultStdout(windowsOrigin), URL_);
    });
    test('falls back to text minus Exit code line when no structuredContent', () => {
        assert.strictEqual(commandResultStdout({ content: [{ type: 'text', text: `Exit code: 0\r\n${URL_}\r\n` }] }), URL_);
    });
    test('throws naming the exit code (structured, parsed, isError)', () => {
        assert.throws(() => commandResultStdout(failed), /exit code 128/);
        assert.throws(() => commandResultStdout({ content: [{ type: 'text', text: 'Exit code: 3\nboom' }] }), /exit code 3/);
        assert.throws(() => commandResultStdout({ isError: true, content: [{ type: 'text', text: 'transport down' }] }), /transport down/);
    });
});
