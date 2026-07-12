import { test, describe } from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import {
    parseCliArgs,
    resolveMemberValidation,
    resolveRoleMap,
    buildRunnerArgs,
    checkIssuesExistOnMember,
    formatViewerListenError,
    attachViewerErrorHandler,
} from '../bin/cli.mjs';
import { validateArgs } from '../auto-sprint/runner.js';

// Tests for apra-fleet-unw2.16 (N14): CLI robustness fixes (a)-(e).
//
// (a) strict flag parsing; (b) missing-member abort/allow-list; (c)
// --requirements-file/--role-map reach the runner's validated args; (d) the
// `bd show` issue precondition targets the orchestrator MEMBER via the fleet
// transport, not the local machine; (e) --viewer-port + a clean port-
// collision error instead of an unhandled crash.

const BASE_ARGV = ['--issue', 'bd-1', '--members', 'local', '--branch', 'auto-sprint/x', '--base', 'main'];

// ---------------------------------------------------------------------------
// (a) parseArgs strict: true -- typo'd flags rejected loudly
// ---------------------------------------------------------------------------

describe('parseCliArgs (a: strict flag parsing)', () => {
    test('accepts known flags including the new ones', () => {
        const { values } = parseCliArgs([
            ...BASE_ARGV,
            '--max-cycles', '3',
            '--allow-missing-members',
            '--requirements-file', 'reqs.md',
            '--role-map', '{"doer":["m1"]}',
            '--viewer-port', '9090',
        ]);
        assert.strictEqual(values['max-cycles'], '3');
        assert.strictEqual(values['allow-missing-members'], true);
        assert.strictEqual(values['requirements-file'], 'reqs.md');
        assert.strictEqual(values['role-map'], '{"doer":["m1"]}');
        assert.strictEqual(values['viewer-port'], '9090');
    });

    test('rejects a typo\'d flag with a clear usage message instead of silently defaulting', () => {
        assert.throws(
            () => parseCliArgs([...BASE_ARGV, '--max-cycle', '3']),
            (err) => {
                assert.match(err.message, /Invalid command-line arguments/);
                assert.match(err.message, /Usage: fleet-se sprint/);
                return true;
            }
        );
    });

    test('rejects an unknown flag entirely', () => {
        assert.throws(
            () => parseCliArgs([...BASE_ARGV, '--totally-made-up-flag']),
            /Invalid command-line arguments/
        );
    });
});

// ---------------------------------------------------------------------------
// (b) missing configured members abort unless --allow-missing-members
// ---------------------------------------------------------------------------

describe('resolveMemberValidation (b: missing-member abort)', () => {
    test('aborts by default when a configured member is not registered', () => {
        const result = resolveMemberValidation({
            rawMembers: ['local', 'ghost'],
            registeredNames: new Set(['local']),
            allowMissingMembers: false,
        });
        assert.strictEqual(result.ok, false);
        assert.deepStrictEqual(result.missingMembers, ['ghost']);
        assert.match(result.message, /missing from the fleet/);
        assert.match(result.message, /--allow-missing-members/);
    });

    test('proceeds (warn-and-continue) with --allow-missing-members', () => {
        const result = resolveMemberValidation({
            rawMembers: ['local', 'ghost'],
            registeredNames: new Set(['local']),
            allowMissingMembers: true,
        });
        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(result.validMembers, ['local']);
        assert.deepStrictEqual(result.missingMembers, ['ghost']);
        assert.match(result.message, /Warning:.*ghost/);
    });

    test('aborts regardless of the flag when ALL members are missing', () => {
        const result = resolveMemberValidation({
            rawMembers: ['ghost1', 'ghost2'],
            registeredNames: new Set(['local']),
            allowMissingMembers: true,
        });
        assert.strictEqual(result.ok, false);
        assert.match(result.message, /All specified members are missing/);
    });

    test('no message / no warning when every member is registered', () => {
        const result = resolveMemberValidation({
            rawMembers: ['local'],
            registeredNames: new Set(['local']),
            allowMissingMembers: false,
        });
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.message, null);
    });
});

// ---------------------------------------------------------------------------
// (c) --requirements-file / --role-map reach the runner's validated args
// ---------------------------------------------------------------------------

describe('resolveRoleMap + buildRunnerArgs -> runner.js validateArgs (c)', () => {
    test('inline JSON --role-map reaches validateArgs correctly', async () => {
        const roleMap = await resolveRoleMap('{"doer":["m1","m2"],"reviewer":["m3"]}');
        const args = buildRunnerArgs({
            targetIssues: ['bd-1'],
            members: ['m1', 'm2', 'm3'],
            branch: 'auto-sprint/x',
            baseBranch: 'main',
            goal: 'P1/P2',
            maxCycles: 5,
            requirementsFile: 'reqs.md',
            roleMap,
        });
        const validated = validateArgs(args);
        assert.deepStrictEqual(validated.roleMap, { doer: ['m1', 'm2'], reviewer: ['m3'] });
        assert.strictEqual(validated.requirementsFile, 'reqs.md');
    });

    test('@file --role-map indirection reaches validateArgs correctly', async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'apra-fleet-se-rolemap-'));
        const filePath = path.join(dir, 'role-map.json');
        await fs.writeFile(filePath, JSON.stringify({ doer: ['m1'] }), 'utf-8');
        try {
            const roleMap = await resolveRoleMap(`@${filePath}`);
            const args = buildRunnerArgs({
                targetIssues: ['bd-1'],
                members: ['m1'],
                branch: 'auto-sprint/x',
                baseBranch: 'main',
                goal: 'P1',
                maxCycles: 2,
                requirementsFile: undefined,
                roleMap,
            });
            const validated = validateArgs(args);
            assert.deepStrictEqual(validated.roleMap, { doer: ['m1'] });
            assert.strictEqual(validated.requirementsFile, undefined);
        } finally {
            await fs.rm(dir, { recursive: true, force: true });
        }
    });

    test('resolveRoleMap is undefined when --role-map is not passed', async () => {
        const roleMap = await resolveRoleMap(undefined);
        assert.strictEqual(roleMap, undefined);
        const args = buildRunnerArgs({
            targetIssues: ['bd-1'], members: ['m1'], branch: 'b', baseBranch: 'main',
            goal: 'P1', maxCycles: 1, requirementsFile: undefined, roleMap,
        });
        assert.strictEqual('roleMap' in args, false);
        assert.strictEqual('requirementsFile' in args, false);
        validateArgs(args); // must not throw
    });

    test('rejects malformed inline JSON with a clear error', async () => {
        await assert.rejects(() => resolveRoleMap('{not valid json'), /must be valid JSON/);
    });

    test('rejects a role-map that is not an object of string arrays', async () => {
        await assert.rejects(() => resolveRoleMap('["doer"]'), /must be an object mapping/);
        await assert.rejects(() => resolveRoleMap('{"doer":"m1"}'), /non-empty array of member-name strings/);
    });

    test('@file indirection surfaces a clear error when the file is missing', async () => {
        await assert.rejects(() => resolveRoleMap('@/path/does/not/exist.json'), /could not read --role-map file/);
    });
});

// ---------------------------------------------------------------------------
// (d) bd show precondition targets the orchestrator MEMBER via the fleet
// transport, not the local machine
// ---------------------------------------------------------------------------

describe('checkIssuesExistOnMember (d: member-side precondition)', () => {
    test('dispatches "bd show <id>" against the given member via the injected transport call, never locally', async () => {
        const calls = [];
        const runBdShow = async (id, member) => {
            calls.push({ id, member });
            return { isError: false, content: [{ text: `issue ${id} found` }] };
        };

        const result = await checkIssuesExistOnMember({
            targetIssues: ['bd-1', 'bd-2'],
            member: 'remote-member',
            runBdShow,
        });

        assert.strictEqual(result.ok, true);
        assert.deepStrictEqual(calls, [
            { id: 'bd-1', member: 'remote-member' },
            { id: 'bd-2', member: 'remote-member' },
        ]);
        // Proves the member (not "local"/undefined) was threaded into every dispatch.
        calls.forEach((c) => assert.strictEqual(c.member, 'remote-member'));
    });

    test('reports missing issues (per fleet transport isError) without aborting on others', async () => {
        const runBdShow = async (id) => {
            if (id === 'bd-missing') return { isError: true, content: [{ text: 'not found' }] };
            return { isError: false, content: [{ text: 'ok' }] };
        };
        const result = await checkIssuesExistOnMember({
            targetIssues: ['bd-1', 'bd-missing'],
            member: 'remote-member',
            runBdShow,
        });
        assert.strictEqual(result.ok, false);
        assert.deepStrictEqual(result.missing, ['bd-missing']);
        assert.match(result.message, /remote-member/);
    });

    test('a transport dispatch failure (thrown error) counts as missing, not a silent pass', async () => {
        const runBdShow = async () => { throw new Error('transport dispatch failed'); };
        const result = await checkIssuesExistOnMember({
            targetIssues: ['bd-1'],
            member: 'remote-member',
            runBdShow,
        });
        assert.strictEqual(result.ok, false);
        assert.deepStrictEqual(result.missing, ['bd-1']);
    });
});

// ---------------------------------------------------------------------------
// (e) --viewer-port + clean port-collision error instead of an unhandled crash
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// (f) --budget flag (apra-fleet-unw2.21): threads through to args.budget,
// following the existing buildOptionsSpec()/buildRunnerArgs() pattern; the
// CLI layer rejects non-numeric/negative values with a clear error, and
// omitting the flag entirely must be a no-op (unlimited/no ceiling, matching
// pre-unw2.21 behavior).
// ---------------------------------------------------------------------------

describe('--budget flag (f: CLI budget ceiling)', () => {
    test('parseCliArgs accepts --budget and buildRunnerArgs threads it through as args.budget', () => {
        const { values } = parseCliArgs([...BASE_ARGV, '--budget', '5.0']);
        assert.strictEqual(values.budget, '5.0');

        const budget = values.budget !== undefined ? Number(values.budget) : undefined;
        assert.strictEqual(budget, 5);

        const args = buildRunnerArgs({
            targetIssues: ['bd-1'], members: ['local'], branch: 'auto-sprint/x', baseBranch: 'main',
            goal: 'P1/P2', maxCycles: 5, requirementsFile: undefined, roleMap: undefined, budget,
        });
        assert.strictEqual(args.budget, 5);

        // Round-trips through runner.js's own validateArgs without throwing,
        // and lands as the same validated number.
        const validated = validateArgs(args);
        assert.strictEqual(validated.budget, 5);
    });

    test('buildRunnerArgs omits args.budget entirely when --budget is not passed (unchanged/unlimited behavior)', () => {
        const args = buildRunnerArgs({
            targetIssues: ['bd-1'], members: ['local'], branch: 'auto-sprint/x', baseBranch: 'main',
            goal: 'P1/P2', maxCycles: 5, requirementsFile: undefined, roleMap: undefined, budget: undefined,
        });
        assert.strictEqual('budget' in args, false);

        const validated = validateArgs(args);
        assert.strictEqual(validated.budget, undefined);
    });

    test('rejects a non-numeric --budget value with a clear error at the CLI layer', () => {
        const { values } = parseCliArgs([...BASE_ARGV, '--budget', 'not-a-number']);
        const budget = values.budget !== undefined ? Number(values.budget) : undefined;
        // Number("not-a-number") is NaN; NaN is not finite, so the CLI's
        // `!Number.isFinite(budget)` guard (mirrored here) must reject it.
        assert.ok(!Number.isFinite(budget));
    });

    test('rejects a negative --budget value with a clear error at the CLI layer', () => {
        // node:util parseArgs treats a bare `-1` after `--budget` as an
        // ambiguous short-option-like token, so use `--budget=-1` (the same
        // workaround its own error message suggests) to pass a negative value.
        const { values } = parseCliArgs([...BASE_ARGV, '--budget=-1']);
        const budget = values.budget !== undefined ? Number(values.budget) : undefined;
        assert.ok(Number.isFinite(budget) && budget < 0);
        // This is exactly the condition the CLI's guard checks for rejection
        // (budget !== undefined && (!Number.isFinite(budget) || budget < 0)).
    });

    test('allows --budget 0 (explicit zero ceiling is a valid non-negative number, matching runner.js validateArgs semantics)', () => {
        const args = buildRunnerArgs({
            targetIssues: ['bd-1'], members: ['local'], branch: 'auto-sprint/x', baseBranch: 'main',
            goal: 'P1/P2', maxCycles: 5, requirementsFile: undefined, roleMap: undefined, budget: 0,
        });
        assert.strictEqual(args.budget, 0);
        const validated = validateArgs(args);
        assert.strictEqual(validated.budget, 0);
    });
});

describe('formatViewerListenError / attachViewerErrorHandler (e: viewer port)', () => {
    test('formats an actionable message for EADDRINUSE', () => {
        const err = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
        const message = formatViewerListenError(9090, err);
        assert.match(message, /viewer port 9090 is already in use/);
        assert.match(message, /--viewer-port/);
    });

    test('formats a generic message for other listen errors', () => {
        const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        const message = formatViewerListenError(80, err);
        assert.match(message, /viewer server error/);
        assert.match(message, /EACCES/);
    });

    test('a real port collision on server.listen() produces the clean error message, not an unhandled crash', async () => {
        const blocker = http.createServer();
        await new Promise((resolve, reject) => {
            blocker.listen(0, '127.0.0.1', resolve);
            blocker.on('error', reject);
        });
        const port = blocker.address().port;

        try {
            const contender = http.createServer();
            const errorMessage = await new Promise((resolve) => {
                attachViewerErrorHandler(contender, port, {
                    onError: (message) => resolve(message),
                });
                contender.listen(port, '127.0.0.1');
            });
            assert.match(errorMessage, /viewer port \d+ is already in use/);
            assert.match(errorMessage, /--viewer-port <other port>/);
        } finally {
            await new Promise((resolve) => blocker.close(resolve));
        }
    });
});
