import { test, describe } from 'node:test';
import assert from 'node:assert';
import path from 'node:path';
import os from 'node:os';

import { validateSandboxSeedPaths } from '../../../scripts/sandbox-seed-beads.mjs';

// Run-24 abort root cause, layer 2: the smoke-test beads seed step must be
// structurally unable to touch anything outside the sandbox root. These
// tests exercise the guard's pure validation with synthetic paths -- no
// filesystem mutation, no bd invocation.

const SB = path.join(os.tmpdir(), 'seed-guard-sandbox');
const HOST = path.join(os.tmpdir(), 'seed-guard-hostrepo');

describe('validateSandboxSeedPaths', () => {
    test('accepts a toy repo and dolt remote inside a disjoint sandbox root', () => {
        const r = validateSandboxSeedPaths({
            sandboxRoot: SB,
            toyRepo: path.join(SB, 'toy-repo'),
            doltRemote: path.join(SB, '.apra-fleet-toy-dolt-remote'),
            hostRepoRoot: HOST,
        });
        assert.ok(r.repo.endsWith('toy-repo'));
        assert.ok(r.remote.includes('.apra-fleet-toy-dolt-remote'));
    });

    test('defaults the dolt remote to a path inside the sandbox root', () => {
        const r = validateSandboxSeedPaths({
            sandboxRoot: SB,
            toyRepo: path.join(SB, 'toy-repo'),
            doltRemote: undefined,
            hostRepoRoot: HOST,
        });
        assert.strictEqual(r.remote, path.join(r.root, '.apra-fleet-toy-dolt-remote'));
    });

    test('refuses a toy repo outside the sandbox root (the run-24 leak shape)', () => {
        assert.throws(
            () => validateSandboxSeedPaths({
                sandboxRoot: SB,
                toyRepo: HOST, // the host product repo itself
                doltRemote: path.join(SB, '.apra-fleet-toy-dolt-remote'),
                hostRepoRoot: HOST,
            }),
            /\[sandbox-seed guard\] refusing/,
        );
    });

    test('refuses a dolt remote outside the sandbox root', () => {
        assert.throws(
            () => validateSandboxSeedPaths({
                sandboxRoot: SB,
                toyRepo: path.join(SB, 'toy-repo'),
                doltRemote: path.join(os.tmpdir(), 'elsewhere-remote'),
                hostRepoRoot: HOST,
            }),
            /\[sandbox-seed guard\] refusing: dolt remote/,
        );
    });

    test('refuses a sandbox root that overlaps the host repo, either direction', () => {
        assert.throws(
            () => validateSandboxSeedPaths({
                sandboxRoot: path.join(HOST, 'nested-sandbox'),
                toyRepo: path.join(HOST, 'nested-sandbox', 'toy-repo'),
                doltRemote: undefined,
                hostRepoRoot: HOST,
            }),
            /\[sandbox-seed guard\] refusing: sandbox root/,
        );
        assert.throws(
            () => validateSandboxSeedPaths({
                sandboxRoot: SB,
                toyRepo: path.join(SB, 'toy-repo'),
                doltRemote: undefined,
                hostRepoRoot: path.join(SB, 'host-inside-sandbox'),
            }),
            /\[sandbox-seed guard\] refusing: sandbox root/,
        );
    });

    test('refuses missing required inputs', () => {
        assert.throws(
            () => validateSandboxSeedPaths({ sandboxRoot: SB, toyRepo: '', hostRepoRoot: HOST }),
            /\[sandbox-seed guard\]/,
        );
    });
});
