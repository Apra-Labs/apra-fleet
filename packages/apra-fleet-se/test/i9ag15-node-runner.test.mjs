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

// apra-fleet-i9ag.19.5 -- the CONFIGURED tier: the recorded toolchain's
// absolute node path, inserted between the FLEET_SE_NODE override (tier 1)
// and current-runtime/PATH (tiers 3/4). This is what lets a launchd/Windows-
// service supervisor -- whose PATH the login shell never populates, and whose
// own execPath is the apra-fleet SEA binary rather than node -- launch a
// sprint at all. See node-runner.mjs's file-level doc comment for the full
// rationale; these tests pin AC1-AC5 from that bead with exact
// file/args/options assertions (matching this file's own injected-exec
// convention above), not just "it still works".
describe('apra-fleet-i9ag.19.5: resolveSprintRunnerCommand() CONFIGURED tier', () => {
    test('AC1: a configured path with no other usable tier (PATH absent) resolves with source "configured"', () => {
        const result = resolveSprintRunnerCommand({
            env: {},
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true, // current-runtime tier is skipped either way
            // 'node' (the PATH tier) is deliberately absent from this map --
            // if resolution ever fell through to it, the probe would throw.
            exec: fakeExec({ '/opt/toolchain/node': 'v22.16.0' }),
            platform: 'linux',
            configuredNodePath: '/opt/toolchain/node',
        });
        assert.deepEqual(result, {
            command: '/opt/toolchain/node',
            source: SPRINT_RUNNER_SOURCE.CONFIGURED,
            version: '22.16.0',
        });
    });

    // apra-fleet-i9ag.19.6 bullet 1: "configured beats current-runtime; configured
    // beats PATH" -- AC1 above only proves the configured tier resolves when
    // the LATER tiers are absent/unusable; these two prove actual PRECEDENCE
    // by making current-runtime and PATH each independently resolvable too
    // (via a spy exec), and asserting neither probe ever ran once a
    // configured path was present. That is the whole point of tier ordering:
    // a later tier that would ALSO succeed must never even be consulted.
    test('apra-fleet-i9ag.19.6: configured beats current-runtime, even when current-runtime would also resolve', () => {
        const { exec, calls } = fakeExecCapturing({
            '/opt/toolchain/node': 'v22.16.0',
            '/usr/bin/node-under-test': 'v22.16.0',
        });
        const result = resolveSprintRunnerCommand({
            env: {},
            execPath: '/usr/bin/node-under-test',
            isSea: () => false, // current-runtime tier WOULD resolve if reached
            exec,
            platform: 'linux',
            configuredNodePath: '/opt/toolchain/node',
        });
        assert.deepEqual(result, {
            command: '/opt/toolchain/node',
            source: SPRINT_RUNNER_SOURCE.CONFIGURED,
            version: '22.16.0',
        });
        assert.equal(calls.length, 1, 'current-runtime must never be probed once a configured path resolves');
        assert.equal(calls[0].file, '/opt/toolchain/node');
    });

    test('apra-fleet-i9ag.19.6: configured beats PATH, even when PATH would also resolve', () => {
        const { exec, calls } = fakeExecCapturing({
            '/opt/toolchain/node': 'v22.16.0',
            node: 'v22.16.0', // the PATH tier WOULD resolve if reached
        });
        const result = resolveSprintRunnerCommand({
            env: {},
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true, // skips current-runtime, would otherwise fall through to PATH
            exec,
            platform: 'linux',
            configuredNodePath: '/opt/toolchain/node',
        });
        assert.deepEqual(result, {
            command: '/opt/toolchain/node',
            source: SPRINT_RUNNER_SOURCE.CONFIGURED,
            version: '22.16.0',
        });
        assert.equal(calls.length, 1, 'the PATH probe must never run once a configured path resolves');
        assert.equal(calls[0].file, '/opt/toolchain/node');
    });

    test('AC2: a broken configured path throws naming it, and neither current-runtime nor the PATH probe is ever invoked', () => {
        // Both the current-runtime execPath and 'node' on PATH would resolve
        // successfully if tried -- proving the configured-tier failure is a
        // hard stop, not a silent fall-through, requires a spy that shows
        // those probes never ran at all (not just that the end result threw).
        const { exec, calls } = fakeExecCapturing({ '/usr/bin/node-under-test': 'v22.16.0', node: 'v22.16.0' });
        assert.throws(
            () => resolveSprintRunnerCommand({
                env: {},
                execPath: '/usr/bin/node-under-test',
                isSea: () => false,
                exec,
                platform: 'linux',
                configuredNodePath: '/bad/configured/node',
            }),
            (err) => {
                assert.ok(err instanceof SprintRunnerResolutionError);
                assert.ok(err.message.includes('/bad/configured/node'), 'names the broken configured path');
                return true;
            },
        );
        assert.equal(calls.length, 1, 'current-runtime/PATH must never be probed once the configured tier throws');
        assert.equal(calls[0].file, '/bad/configured/node');
    });

    test('AC2: a configured path resolving below MIN_NODE_VERSION throws naming the version found and the minimum, without falling through', () => {
        const { exec, calls } = fakeExecCapturing({ '/opt/toolchain/node': 'v22.9.0', node: 'v22.16.0' });
        assert.throws(
            () => resolveSprintRunnerCommand({
                env: {},
                execPath: '/opt/apra-fleet/apra-fleet',
                isSea: () => true,
                exec,
                platform: 'linux',
                configuredNodePath: '/opt/toolchain/node',
            }),
            (err) => {
                assert.ok(err instanceof SprintRunnerResolutionError);
                assert.ok(err.message.includes('/opt/toolchain/node'), 'names the configured path');
                assert.ok(err.message.includes('22.9.0'), 'names the too-old version actually found');
                assert.ok(err.message.includes(MIN_NODE_VERSION), 'names the required minimum');
                return true;
            },
        );
        assert.equal(calls.length, 1, 'must never fall through to the PATH probe after a too-old configured version');
    });

    test('AC3: FLEET_SE_NODE still wins over a configured path, even when the configured path would also resolve', () => {
        const result = resolveSprintRunnerCommand({
            env: { FLEET_SE_NODE: '/custom/node' },
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true,
            exec: fakeExec({ '/custom/node': 'v20.0.0', '/opt/toolchain/node': 'v22.16.0', node: 'v22.16.0' }),
            platform: 'linux',
            configuredNodePath: '/opt/toolchain/node',
        });
        assert.deepEqual(result, {
            command: '/custom/node',
            source: SPRINT_RUNNER_SOURCE.OVERRIDE,
            version: '20.0.0',
        });
    });

    test('AC4: an absent configuredNodePath leaves current-runtime/PATH tier order and result exactly as before this bead', () => {
        const result = resolveSprintRunnerCommand({
            env: {},
            execPath: '/usr/bin/node-under-test',
            isSea: () => false,
            exec: fakeExec({ '/usr/bin/node-under-test': 'v22.16.0' }),
            platform: 'linux',
            // configuredNodePath intentionally omitted
        });
        assert.deepEqual(result, {
            command: '/usr/bin/node-under-test',
            source: SPRINT_RUNNER_SOURCE.CURRENT_RUNTIME,
            version: '22.16.0',
        });
    });

    test('AC4: an empty/whitespace-only configuredNodePath is treated as unset, not a tier-2 candidate', () => {
        const result = resolveSprintRunnerCommand({
            env: {},
            execPath: '/usr/bin/node-under-test',
            isSea: () => false,
            exec: fakeExec({ '/usr/bin/node-under-test': 'v22.16.0' }),
            platform: 'linux',
            configuredNodePath: '   ',
        });
        assert.equal(result.source, SPRINT_RUNNER_SOURCE.CURRENT_RUNTIME);
    });

    test('AC5: a configured path containing a space is quoted before the win32 shell probe, and resolves', () => {
        const spacedPath = 'C:\\Program Files\\nodejs\\node.exe';
        const quoted = `"${spacedPath}"`;
        const { exec, calls } = fakeExecCapturing({ [quoted]: 'v22.16.0' });

        const result = resolveSprintRunnerCommand({
            env: {},
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true,
            exec,
            platform: 'win32',
            configuredNodePath: spacedPath,
        });

        assert.deepEqual(result, {
            command: spacedPath,
            source: SPRINT_RUNNER_SOURCE.CONFIGURED,
            version: '22.16.0',
        }, 'the resolved command returned to the caller is the ORIGINAL unquoted path');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].file, quoted, 'the configured-path probe itself was quoted for the win32 shell');
        assert.equal(calls[0].options.shell, true);
    });

    test('AC5: a configured path containing a space on non-win32 is probed unquoted and without a shell', () => {
        const spacedPath = '/usr/local/my node/bin/node';
        const { exec, calls } = fakeExecCapturing({ [spacedPath]: 'v22.16.0' });

        const result = resolveSprintRunnerCommand({
            env: {},
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true,
            exec,
            platform: 'linux',
            configuredNodePath: spacedPath,
        });

        assert.equal(result.command, spacedPath);
        assert.equal(result.source, SPRINT_RUNNER_SOURCE.CONFIGURED);
        assert.equal(calls.length, 1);
        assert.equal(calls[0].file, spacedPath, 'linux/darwin never quote -- no shell is used there');
        assert.equal(calls[0].options.shell, false);
    });
});
