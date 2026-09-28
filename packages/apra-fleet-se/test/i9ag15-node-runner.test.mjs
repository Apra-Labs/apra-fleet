// apra-fleet-i9ag.15.1 -- resolveSprintRunnerCommand() (node-runner.mjs):
// resolves which Node.js binary the supervisor should spawn a sprint's
// fleet-sprint CLI child process with. See node-runner.mjs's file-level doc
// comment for the fixed 3-tier resolution order this exercises.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveSprintRunnerCommand,
    SprintRunnerResolutionError,
    SPRINT_RUNNER_SOURCE,
    MIN_NODE_VERSION,
} from '../src/supervisor/node-runner.mjs';

/** A fake `exec(file, args, options)` -- `versions` maps file -> version
 * string (parsed by the module's own parseVersionString(), so 'vX.Y.Z' or
 * 'X.Y.Z' both work) or `null` to simulate a spawn failure (e.g. ENOENT). */
function fakeExec(versions) {
    return (file) => {
        if (!Object.prototype.hasOwnProperty.call(versions, file) || versions[file] === null) {
            throw new Error(`spawn ENOENT: ${file}`);
        }
        return versions[file];
    };
}

/**
 * A fake `exec` that also records every call it received (file, args,
 * options) -- apra-fleet-i9ag.15.4's win32-quoting tests need to assert
 * exactly what string node-runner.mjs's probeVersion() handed to `exec`,
 * not just what it returns. `versions` is keyed on the (possibly quoted)
 * file string exec actually receives, mirroring how cmd.exe would only ever
 * see the already-quoted candidate.
 */
function fakeExecCapturing(versions) {
    const calls = [];
    const exec = (file, args, options) => {
        calls.push({ file, args, options });
        if (!Object.prototype.hasOwnProperty.call(versions, file) || versions[file] === null) {
            throw new Error(`spawn ENOENT: ${file}`);
        }
        return versions[file];
    };
    return { exec, calls };
}

describe('apra-fleet-i9ag.15.1: resolveSprintRunnerCommand()', () => {
    test('isSea() false + a probeable execPath: returns execPath, source identifies the current runtime', () => {
        const result = resolveSprintRunnerCommand({
            env: {},
            execPath: '/usr/bin/node-under-test',
            isSea: () => false,
            exec: fakeExec({ '/usr/bin/node-under-test': 'v22.16.0' }),
            platform: 'linux',
        });
        assert.deepEqual(result, {
            command: '/usr/bin/node-under-test',
            source: SPRINT_RUNNER_SOURCE.CURRENT_RUNTIME,
            version: '22.16.0',
        });
    });

    test('isSea() true: resolves the PATH node, NEVER the injected execPath', () => {
        const result = resolveSprintRunnerCommand({
            env: {},
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true,
            exec: fakeExec({ node: 'v22.17.1', '/opt/apra-fleet/apra-fleet': 'v99.99.99' }),
            platform: 'linux',
        });
        assert.equal(result.command, 'node');
        assert.equal(result.source, SPRINT_RUNNER_SOURCE.PATH);
        assert.equal(result.version, '22.17.1');
    });

    test('isSea() true + no usable node anywhere: throws naming every candidate and the Node.js 22.16+ fix line', () => {
        assert.throws(
            () => resolveSprintRunnerCommand({
                env: {},
                execPath: '/opt/apra-fleet/apra-fleet',
                isSea: () => true,
                exec: fakeExec({}),
                platform: 'linux',
            }),
            (err) => {
                assert.ok(err instanceof SprintRunnerResolutionError);
                assert.ok(err.isSprintRunnerResolutionError, 'discriminating property must be set');
                assert.ok(err.message.includes('/opt/apra-fleet/apra-fleet'), 'names the skipped current-runtime candidate');
                assert.ok(err.message.includes('PATH'), 'names the PATH candidate');
                assert.ok(err.message.includes('Node.js 22.16+'), 'carries the operator fix line');
                return true;
            },
        );
    });

    test('a PATH node older than the minimum throws instead of being used, naming the version found', () => {
        assert.throws(
            () => resolveSprintRunnerCommand({
                env: {},
                execPath: '/opt/apra-fleet/apra-fleet',
                isSea: () => true,
                exec: fakeExec({ node: 'v22.9.0' }),
                platform: 'linux',
            }),
            (err) => {
                assert.ok(err instanceof SprintRunnerResolutionError);
                assert.ok(err.message.includes('22.9.0'), 'names the too-old version actually found');
                assert.ok(err.message.includes(MIN_NODE_VERSION), 'names the required minimum');
                return true;
            },
        );
    });

    test('version comparison is numeric: 22.9.0 is OLDER than 22.16.0, not "greater" by a string compare', () => {
        // A naive string compare treats '22.9.0' > '22.16.0' (since '9' > '1'
        // lexically) -- this asserts the PATH tier actually rejects it as too
        // old, proving the comparison is numeric.
        assert.throws(() => resolveSprintRunnerCommand({
            env: {},
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true,
            exec: fakeExec({ node: 'v22.9.0' }),
            platform: 'linux',
        }), SprintRunnerResolutionError);

        // A version at (or above) the minimum is accepted.
        const ok = resolveSprintRunnerCommand({
            env: {},
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true,
            exec: fakeExec({ node: MIN_NODE_VERSION }),
            platform: 'linux',
        });
        assert.equal(ok.version, MIN_NODE_VERSION);
    });

    test('FLEET_SE_NODE wins over both other tiers, even when they would also resolve', () => {
        const result = resolveSprintRunnerCommand({
            env: { FLEET_SE_NODE: '/custom/node' },
            execPath: '/usr/bin/node-under-test',
            isSea: () => false,
            exec: fakeExec({
                '/custom/node': 'v20.0.0',
                '/usr/bin/node-under-test': 'v22.16.0',
                node: 'v22.16.0',
            }),
            platform: 'linux',
        });
        assert.deepEqual(result, {
            command: '/custom/node',
            source: SPRINT_RUNNER_SOURCE.OVERRIDE,
            version: '20.0.0',
        });
    });

    test('FLEET_SE_NODE set but unusable is a hard error -- never a silent fall-through to PATH/execPath', () => {
        assert.throws(
            () => resolveSprintRunnerCommand({
                env: { FLEET_SE_NODE: '/bad/node' },
                execPath: '/usr/bin/node-under-test',
                isSea: () => false,
                exec: fakeExec({ '/usr/bin/node-under-test': 'v22.16.0', node: 'v22.16.0' }),
                platform: 'linux',
            }),
            (err) => {
                assert.ok(err instanceof SprintRunnerResolutionError);
                assert.ok(err.message.includes('/bad/node'), 'names the unusable override');
                return true;
            },
        );
    });

    test('an empty/whitespace-only FLEET_SE_NODE is treated as unset, not an override', () => {
        const result = resolveSprintRunnerCommand({
            env: { FLEET_SE_NODE: '   ' },
            execPath: '/usr/bin/node-under-test',
            isSea: () => false,
            exec: fakeExec({ '/usr/bin/node-under-test': 'v22.16.0' }),
            platform: 'linux',
        });
        assert.equal(result.source, SPRINT_RUNNER_SOURCE.CURRENT_RUNTIME);
    });

    test('nothing in node-runner.mjs imports from outside packages/apra-fleet-se', async () => {
        const fs = await import('node:fs/promises');
        const url = await import('node:url');
        const path = await import('node:path');
        const filePath = path.default.join(
            path.default.dirname(url.default.fileURLToPath(import.meta.url)),
            '../src/supervisor/node-runner.mjs',
        );
        const src = await fs.default.readFile(filePath, 'utf-8');
        const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));
        for (const line of importLines) {
            assert.ok(
                /from\s+'node:/.test(line),
                `expected only node: built-in imports, found: ${line}`,
            );
        }
    });

    test('win32: a current-runtime execPath containing a space is quoted before the shell probe, so it resolves', () => {
        const spacedPath = 'C:\\Program Files\\nodejs\\node.exe';
        const quoted = `"${spacedPath}"`;
        const { exec, calls } = fakeExecCapturing({ [quoted]: 'v22.16.0' });

        const result = resolveSprintRunnerCommand({
            env: {},
            execPath: spacedPath,
            isSea: () => false,
            exec,
            platform: 'win32',
        });

        assert.deepEqual(result, {
            command: spacedPath,
            source: SPRINT_RUNNER_SOURCE.CURRENT_RUNTIME,
            version: '22.16.0',
        }, 'the resolved command returned to the caller is the ORIGINAL unquoted path');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].file, quoted, 'the probe itself was quoted for the win32 shell');
        assert.equal(calls[0].options.shell, true);
    });

    test('win32: an unquoted spaced execPath is never resolvable -- proves the fix is necessary, not just harmless', () => {
        const spacedPath = 'C:\\Program Files\\nodejs\\node.exe';
        // Only the UNQUOTED literal resolves here -- simulates the pre-fix
        // behaviour where cmd.exe would split the spaced path.
        const { exec } = fakeExecCapturing({ [spacedPath]: 'v22.16.0' });

        assert.throws(
            () => resolveSprintRunnerCommand({
                env: {},
                execPath: spacedPath,
                isSea: () => false,
                exec,
                platform: 'win32',
                // no PATH node available either, so a regression surfaces as a
                // hard resolution failure rather than a silent PATH fall-through
            }),
            SprintRunnerResolutionError,
        );
    });

    test('win32: FLEET_SE_NODE override containing a space is quoted before the shell probe, so it resolves', () => {
        const spacedOverride = 'C:\\Users\\Some User\\.nvm\\node.exe';
        const quoted = `"${spacedOverride}"`;
        const { exec, calls } = fakeExecCapturing({ [quoted]: 'v20.0.0' });

        const result = resolveSprintRunnerCommand({
            env: { FLEET_SE_NODE: spacedOverride },
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true,
            exec,
            platform: 'win32',
        });

        assert.deepEqual(result, {
            command: spacedOverride,
            source: SPRINT_RUNNER_SOURCE.OVERRIDE,
            version: '20.0.0',
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].file, quoted, 'the override probe itself was quoted for the win32 shell');
    });

    test('win32: PATH tier probes the bare "node" literal unquoted (no whitespace to quote)', () => {
        const { exec, calls } = fakeExecCapturing({ node: 'v22.17.1' });

        const result = resolveSprintRunnerCommand({
            env: {},
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true,
            exec,
            platform: 'win32',
        });

        assert.equal(result.command, 'node');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].file, 'node', 'no quoting applied to a token with no whitespace');
        assert.equal(calls[0].options.shell, true);
    });

    test('non-win32: a spaced execPath is probed unquoted and without a shell (quoting is win32-shell-only)', () => {
        const spacedPath = '/usr/local/my node/bin/node';
        const { exec, calls } = fakeExecCapturing({ [spacedPath]: 'v22.16.0' });

        const result = resolveSprintRunnerCommand({
            env: {},
            execPath: spacedPath,
            isSea: () => false,
            exec,
            platform: 'linux',
        });

        assert.equal(result.command, spacedPath);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].file, spacedPath, 'linux/darwin never quote -- no shell is used there');
        assert.equal(calls[0].options.shell, false);
    });

    test('the real defaults (no injected deps) resolve without throwing on this test host', () => {
        // Sanity check that the real execFileSync/node:sea/process.env/
        // process.execPath/process.platform defaults are wired correctly --
        // this test host itself satisfies MIN_NODE_VERSION (fleet-se's own
        // documented prerequisite), so resolution must succeed.
        const result = resolveSprintRunnerCommand();
        assert.ok(result.command);
        assert.ok(result.version);
        assert.ok(Object.values(SPRINT_RUNNER_SOURCE).includes(result.source));
    });
});
