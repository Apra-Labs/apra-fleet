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
    SPRINT_RUNNER_PROBE_TIMEOUT_MS,
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

/**
 * A fake `exec` that plays back a fixed SEQUENCE of outcomes for exactly one
 * `file` -- apra-fleet-i9ag.19.35's retry tests need to control precisely
 * what the CONFIGURED tier's probe sees on its first attempt vs its one
 * bounded retry (`probeVersion()`'s `{ retry: true }` opt-in, node-version.mjs),
 * something `fakeExec`/`fakeExecCapturing` (a single fixed outcome per file)
 * cannot express. Each entry in `sequence` is either a version string
 * (success) or `{ error }`, an Error object to throw -- callers build that
 * Error with exactly the shape `classifyIncompleteProbe()` (node-version.mjs)
 * inspects (`killed: true` for a timeout, `code: 'EAGAIN'`/etc. for a
 * transient spawn errno), so these tests exercise the SAME classification
 * logic a real timed-out/overloaded spawn would hit, not just "some Error".
 * The last entry repeats for any call beyond `sequence`'s length (a retry
 * ceiling bug would otherwise call past the array and crash confusingly).
 * A call for any OTHER file throws a generic ENOENT, matching this file's
 * other fakes' behaviour for an unlisted candidate.
 */
function fakeExecSequence(file, sequence) {
    let next = 0;
    const calls = [];
    const exec = (f, args, options) => {
        calls.push({ file: f, args, options });
        if (f !== file) {
            throw new Error(`spawn ENOENT: ${f}`);
        }
        const entry = sequence[Math.min(next, sequence.length - 1)];
        next += 1;
        if (entry && typeof entry === 'object' && 'error' in entry) {
            throw entry.error;
        }
        return entry;
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

    test('apra-fleet-i9ag.19.24: an async exec handed to resolveSprintRunnerCommand() FAILS LOUDLY, never silently returns { version: undefined }', () => {
        // resolveSprintRunnerCommand() is a synchronous-only caller of the
        // shared probeVersion() helper (node-version.mjs) -- it never passes
        // { async: true }. Before this fix, an async `exec` (only reachable
        // via test/dependency injection, never in production) would make
        // probeVersion() return its in-flight Promise itself; destructuring
        // `{ version }` off that Promise silently reads `undefined` (not
        // `=== null`), which the null-guard then treated as a SUCCESS. The
        // fix makes probeVersion() throw ProbeVersionAsyncContractError the
        // instant a thenable result is observed by a caller that never
        // opted into the async contract, so this must fail loudly instead.
        const asyncExec = async () => 'v22.16.0\n';
        assert.throws(
            () => resolveSprintRunnerCommand({
                env: { FLEET_SE_NODE: '/custom/node' },
                execPath: '/usr/bin/node-under-test',
                isSea: () => false,
                exec: asyncExec,
                platform: 'linux',
            }),
            (err) => {
                assert.equal(err.name, 'ProbeVersionAsyncContractError');
                assert.ok(
                    !(err instanceof SprintRunnerResolutionError),
                    'must NOT be a SprintRunnerResolutionError -- api.mjs maps that type to an HTTP 503 ' +
                    '("no runtime found"), and this contract violation must surface as an unmistakable ' +
                    'crash rather than being silently absorbed into that user-facing path',
                );
                assert.match(
                    err.message,
                    /did not opt into the async contract/,
                    'message must name the actual defect (unopted-into async contract), not just "it threw"',
                );
                return true;
            },
        );
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
        // WHOLE import STATEMENTS, not lines (apra-fleet-i9ag.19.35): a
        // multi-line `import {\n  a,\n  b,\n} from './x.mjs'` specifier list
        // is one statement whose FIRST line carries no `from` clause at all,
        // so a line-based check failed it as if it reached outside the
        // package. Matching each statement up to its own `from '...'` keeps
        // the real invariant exact while being indifferent to formatting.
        const importSpecifiers = [...src.matchAll(/^\s*import\b[\s\S]*?from\s+'([^']+)';/gm)].map((m) => m[1]);
        const sideEffectImports = [...src.matchAll(/^\s*import\s+'([^']+)';/gm)].map((m) => m[1]);
        const importCount = src.split('\n').filter((l) => /^\s*import\b/.test(l)).length;
        assert.ok(
            importSpecifiers.length + sideEffectImports.length > 0 && importCount > 0,
            'the import scan matched nothing at all -- the regex, not the module, is what broke',
        );
        for (const specifier of [...importSpecifiers, ...sideEffectImports]) {
            assert.ok(
                // node: built-ins, or a same-directory sibling module -- both
                // stay inside packages/apra-fleet-se. apra-fleet-i9ag.19.15
                // added the latter: node-runner.mjs now imports
                // parseVersionString/compareVersions/quoteForWindowsShell/
                // probeVersion from the shared ./node-version.mjs instead of
                // keeping its own local copies (apra-fleet-i9ag.19.35 adds
                // knownSelfNodeVersion/defaultIsSea from the same sibling). A
                // '../'-prefixed or bare package-name import (reaching outside
                // this directory, or out to core's src/ tree / node_modules)
                // still fails this assertion, which is the invariant this test
                // actually protects.
                /^(node:|\.\/)/.test(specifier),
                `expected only node: built-in or same-directory sibling imports, found: ${specifier}`,
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
        // apra-fleet-i9ag.19.35: this ALSO incidentally pins the other half
        // of the CONFIGURED tier's `{ retry: true }` contract -- an ENOENT
        // (this fake's thrown Error carries no `.code` at all, which
        // classifyIncompleteProbe() treats identically to an unrecognised
        // code: never retryable) never retries even though retry IS opted
        // into, so `calls.length` above is exactly 1, not 2. Made fully
        // explicit, with a `.code: 'ENOENT'` Error and a
        // would-succeed-if-retried control, in the dedicated test below.
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

    // apra-fleet-i9ag.19.35, leg 2 of the chosen strategy (see
    // node-runner.mjs's "STARTUP AND LAUNCH MUST AGREE" header): when there
    // is NO accepted startup-validation result to consume -- no
    // `configuredNodeVersion`, the shape every case in this block uses -- the
    // CONFIGURED tier still probes, and that probe opts into
    // `probeVersion(..., { retry: true })`: the SAME bounded-retry,
    // transient-vs-genuine classification toolchain.mjs's startup
    // `validateRecordedToolchain()` has for this exact recorded path. So a
    // probe that merely could not COMPLETE under host load (a timeout, or a
    // transient spawn errno) is never collapsed into "does not resolve to a
    // usable Node.js runtime", the wording reserved for a genuinely broken
    // recording, and the two probes can never disagree on the same input.
    // Leg 1 -- consuming the accepted version so no launch-time probe happens
    // at all -- is pinned in its own describe block at the end of this file.
    // These tests pin BOTH behavioural halves this bead's acceptance criteria
    // call out directly, against the real exec/retry seam (not toolchain.mjs's
    // own tests, which cover its own call site and pass unchanged regardless
    // of what this tier does).
    test('apra-fleet-i9ag.19.35: a timeout on the first attempt retries and SUCCEEDS on the bounded retry, source stays "configured"', () => {
        const timeoutErr = Object.assign(new Error('spawn ETIMEDOUT'), { killed: true });
        const { exec, calls } = fakeExecSequence('/opt/toolchain/node', [
            { error: timeoutErr },
            'v22.16.0',
        ]);

        const result = resolveSprintRunnerCommand({
            env: {},
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true,
            exec,
            platform: 'linux',
            configuredNodePath: '/opt/toolchain/node',
        });

        assert.deepEqual(result, {
            command: '/opt/toolchain/node',
            source: SPRINT_RUNNER_SOURCE.CONFIGURED,
            version: '22.16.0',
        }, 'a transient timeout on attempt 1 must not fail the launch when the bounded retry succeeds');
        assert.equal(calls.length, 2, 'exactly the original attempt plus one bounded retry, never a retry-until-pass loop');
    });

    test('apra-fleet-i9ag.19.35: a transient spawn errno (EAGAIN) retries the same as a timeout does', () => {
        const eagainErr = Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' });
        const { exec, calls } = fakeExecSequence('/opt/toolchain/node', [
            { error: eagainErr },
            'v22.16.0',
        ]);

        const result = resolveSprintRunnerCommand({
            env: {},
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true,
            exec,
            platform: 'linux',
            configuredNodePath: '/opt/toolchain/node',
        });

        assert.equal(result.version, '22.16.0');
        assert.equal(result.source, SPRINT_RUNNER_SOURCE.CONFIGURED);
        assert.equal(calls.length, 2, 'a transient EAGAIN is classified the same way a timeout is: one bounded retry');
    });

    test('apra-fleet-i9ag.19.35: an ENOENT (genuine missing binary) never retries, even though retry is opted into', () => {
        const enoentErr = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
        // The second entry ('v22.16.0') would be picked up and would make
        // resolution SUCCEED if a retry ever happened -- so this proves the
        // no-retry gate is real (the test would fail the other way if the
        // gate were accidentally removed), not just that no assertion
        // happened to catch a retry.
        const { exec, calls } = fakeExecSequence('/opt/toolchain/node', [
            { error: enoentErr },
            'v22.16.0',
        ]);

        assert.throws(
            () => resolveSprintRunnerCommand({
                env: {},
                execPath: '/opt/apra-fleet/apra-fleet',
                isSea: () => true,
                exec,
                platform: 'linux',
                configuredNodePath: '/opt/toolchain/node',
            }),
            SprintRunnerResolutionError,
        );
        assert.equal(calls.length, 1, 'ENOENT is a genuine finding on the first attempt -- classifyIncompleteProbe() deliberately excludes it');
    });

    test('apra-fleet-i9ag.19.47: the REAL execFileSync timeout shape (ETIMEDOUT, killed undefined) is worded as "could not be probed within Ns"', () => {
        const timeoutErr = () => Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT', killed: undefined, signal: 'SIGTERM', status: null });
        const { exec, calls } = fakeExecSequence('/opt/toolchain/node', [
            { error: timeoutErr() },
            { error: timeoutErr() },
        ]);
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
                assert.match(err.message, new RegExp(`could not be probed within ${SPRINT_RUNNER_PROBE_TIMEOUT_MS / 1_000}s`));
                assert.ok(!err.message.includes('does not resolve'));
                return true;
            },
        );
        assert.equal(calls.length, 2);
    });

    test('apra-fleet-i9ag.19.35: a timeout that persists through the bounded retry is worded distinguishably from a broken recording', () => {
        const timeoutErr = () => Object.assign(new Error('spawn ETIMEDOUT'), { killed: true });
        const { exec, calls } = fakeExecSequence('/opt/toolchain/node', [
            { error: timeoutErr() },
            { error: timeoutErr() },
        ]);

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
                assert.match(
                    err.message,
                    new RegExp(`could not be probed within ${SPRINT_RUNNER_PROBE_TIMEOUT_MS / 1_000}s`),
                    'must use formatIncompleteProbeProblem()\'s shared "could not be probed" wording, deriving the seconds from the real export, not a hand-copied literal',
                );
                assert.ok(
                    !err.message.includes('does not resolve'),
                    'a probe that merely could not COMPLETE must never read as "does not resolve to a usable Node.js runtime" -- the wording reserved for a genuinely broken recording',
                );
                return true;
            },
        );
        assert.equal(calls.length, 2, 'the original attempt plus exactly one bounded retry, then a hard stop -- never a retry-until-pass loop');
    });
});

// =============================================================================
// apra-fleet-i9ag.19.35 -- A LAUNCH IS NEVER REFUSED FOR A NODE STARTUP
// VALIDATION ALREADY ACCEPTED (leg 1 of the chosen strategy), and the current
// runtime is never re-probed to learn its own version (leg 3).
//
// The defect: toolchain.mjs's `validateRecordedToolchain()` probed the recorded
// node at supervisor startup and logged it healthy; this resolver then probed
// the SAME path again at every launch and hard-refused (503) when that second,
// independent probe could not complete under host load. A bounded retry alone
// (the block above) narrows the window but cannot close it -- two attempts can
// both lose on a loaded machine. Leg 1 closes it structurally: when the caller
// hands over the version startup validation ACCEPTED for that exact path in
// that same process (`deps.configuredNodeVersion`, threaded bin/serve.mjs ->
// spawner.mjs -> here), this tier consumes it and probes NOTHING.
//
// Each case proves that the only way that counts: with an injected exec that
// FAILS every probe it is given (and would time out even on the retry), so a
// successful resolution can only mean no probe ran.
// =============================================================================
describe('apra-fleet-i9ag.19.35: the CONFIGURED tier consumes the startup validation result instead of re-probing', () => {
    /** An exec that always fails with Node's own timeout-kill shape, and
     * counts every call. Under this exec, ANY successful resolution proves the
     * candidate was never probed. */
    function alwaysTimingOutExec() {
        const calls = [];
        const exec = (file, args, options) => {
            calls.push({ file, args, options });
            throw Object.assign(new Error(`spawn ${file} ETIMEDOUT`), { killed: true, signal: 'SIGTERM' });
        };
        return { exec, calls };
    }

    test('AC3: with the accepted version supplied, an exec that times out EVERY probe still resolves the configured node -- and is never called at all', () => {
        const { exec, calls } = alwaysTimingOutExec();

        const result = resolveSprintRunnerCommand({
            env: {},
            exec,
            platform: 'linux',
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true,
            configuredNodePath: '/opt/toolchain/node',
            configuredNodeVersion: '22.23.2',
        });

        assert.equal(result.command, '/opt/toolchain/node');
        assert.equal(result.source, SPRINT_RUNNER_SOURCE.CONFIGURED);
        assert.equal(result.version, '22.23.2');
        assert.deepEqual(calls, [], 'a node startup validation already accepted must never be re-probed at launch time');
    });

    test('AC3 CONTROL: the SAME inputs WITHOUT the accepted version hard-refuse the launch -- so it is the consumed result, not the fake, that makes the case above pass', () => {
        const { exec, calls } = alwaysTimingOutExec();

        assert.throws(
            () => resolveSprintRunnerCommand({
                env: {},
                exec,
                platform: 'linux',
                execPath: '/opt/apra-fleet/apra-fleet',
                isSea: () => true,
                configuredNodePath: '/opt/toolchain/node',
            }),
            (err) => {
                assert.ok(err instanceof SprintRunnerResolutionError);
                assert.match(err.message, new RegExp(`could not be probed within ${SPRINT_RUNNER_PROBE_TIMEOUT_MS / 1_000}s`));
                assert.doesNotMatch(err.message, /does not resolve to a usable Node\.js runtime/);
                return true;
            },
        );
        assert.equal(calls.length, 2, 'without an accepted version this tier probes -- original attempt plus one bounded retry');
    });

    test('a leading-v accepted version ("v22.23.2", exactly what `node --version` prints and the recording carries) is normalized, not rejected', () => {
        const { exec, calls } = alwaysTimingOutExec();

        const result = resolveSprintRunnerCommand({
            env: {},
            exec,
            platform: 'linux',
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true,
            configuredNodePath: '/opt/toolchain/node',
            configuredNodeVersion: 'v22.23.2',
        });

        assert.equal(result.version, '22.23.2');
        assert.deepEqual(calls, []);
    });

    test('an accepted version BELOW MIN_NODE_VERSION is still a hard error naming both versions -- "accepted" never means "ungated"', () => {
        const { exec, calls } = alwaysTimingOutExec();

        assert.throws(
            () => resolveSprintRunnerCommand({
                env: {},
                exec,
                platform: 'linux',
                execPath: '/opt/apra-fleet/apra-fleet',
                isSea: () => true,
                configuredNodePath: '/opt/toolchain/node',
                configuredNodeVersion: '18.0.0',
            }),
            (err) => {
                assert.ok(err instanceof SprintRunnerResolutionError);
                assert.match(err.message, /18\.0\.0/);
                assert.match(err.message, new RegExp(MIN_NODE_VERSION.replace(/\./g, '\\.')));
                return true;
            },
        );
        assert.deepEqual(calls, [], 'the gate is applied to the consumed value itself -- no probe is needed to reject it');
    });

    test('an unparseable/blank accepted version is never trusted: the tier falls through to its normal probe', () => {
        for (const bogus of ['', '   ', 'not-a-version', 'unknown']) {
            const { exec, calls } = fakeExecCapturing({ '/opt/toolchain/node': `v${MIN_NODE_VERSION}` });

            const result = resolveSprintRunnerCommand({
                env: {},
                exec,
                platform: 'linux',
                execPath: '/opt/apra-fleet/apra-fleet',
                isSea: () => true,
                configuredNodePath: '/opt/toolchain/node',
                configuredNodeVersion: bogus,
            });

            assert.equal(result.source, SPRINT_RUNNER_SOURCE.CONFIGURED, `bogus version ${JSON.stringify(bogus)}`);
            assert.equal(result.version, MIN_NODE_VERSION, 'the version reported must be the PROBED one, never the bogus input');
            assert.equal(calls.length, 1, `bogus version ${JSON.stringify(bogus)} must fall through to a real probe`);
        }
    });

    test('an accepted version is scoped to the CONFIGURED tier alone: with no configuredNodePath it changes nothing', () => {
        const { exec, calls } = fakeExecCapturing({ node: `v${MIN_NODE_VERSION}` });

        const result = resolveSprintRunnerCommand({
            env: {},
            exec,
            platform: 'linux',
            execPath: '/opt/apra-fleet/apra-fleet',
            isSea: () => true,
            configuredNodeVersion: '22.23.2',
        });

        assert.equal(result.source, SPRINT_RUNNER_SOURCE.PATH, 'a version with no path to attach it to must never resolve anything');
        assert.equal(result.command, 'node');
        assert.equal(calls.length, 1);
    });
});

// =============================================================================
// apra-fleet-i9ag.19.35, leg 3 -- tier 3 never spawns a child process to ask
// the interpreter it is ALREADY RUNNING ON what version it is.
//
// On a host with no recorded toolchain, every launch used to pay for a real
// `node --version` spawn (tier 3) and, if that could not complete in time,
// another one for tier 4 -- two 15s-bounded, load-sensitive child processes on
// the POST /api/sprints critical path, with a "no usable Node.js runtime" hard
// error waiting at the end of them for the very interpreter running the
// supervisor. `process.versions.node` is that answer, known with certainty.
// =============================================================================
describe('apra-fleet-i9ag.19.35: tier 3 reads its own version instead of probing itself', () => {
    test('the real process.execPath resolves with source current-runtime and process.versions.node, spawning nothing', () => {
        let execCalls = 0;
        const result = resolveSprintRunnerCommand({
            env: {},
            exec: () => { execCalls += 1; throw new Error('the current runtime must never be probed with a child process'); },
            platform: process.platform,
            execPath: process.execPath,
            isSea: () => false,
        });

        assert.equal(result.command, process.execPath);
        assert.equal(result.source, SPRINT_RUNNER_SOURCE.CURRENT_RUNTIME);
        assert.equal(result.version, process.versions.node);
        assert.equal(execCalls, 0, 'this process is executing that binary -- stronger evidence than any probe of it could be');
    });

    test('CONTROL: any OTHER execPath is still probed exactly as before -- the shortcut is not a blanket skip', () => {
        const { exec, calls } = fakeExecCapturing({ '/some/other/node': `v${MIN_NODE_VERSION}` });

        const result = resolveSprintRunnerCommand({
            env: {},
            exec,
            platform: 'linux',
            execPath: '/some/other/node',
            isSea: () => false,
        });

        assert.equal(result.source, SPRINT_RUNNER_SOURCE.CURRENT_RUNTIME);
        assert.equal(calls.length, 1, 'an execPath this process is not running on says nothing about itself and must be probed');
        assert.equal(calls[0].file, '/some/other/node');
    });

    test('CONTROL: under a SEA build tier 3 stays skipped entirely -- process.execPath is the apra-fleet binary, not node', () => {
        const { exec, calls } = fakeExecCapturing({ node: `v${MIN_NODE_VERSION}` });

        const result = resolveSprintRunnerCommand({
            env: {},
            exec,
            platform: 'linux',
            execPath: process.execPath,
            isSea: () => true,
        });

        assert.equal(result.source, SPRINT_RUNNER_SOURCE.PATH, 'the SEA guard still wins: nothing may be concluded from execPath');
        assert.deepEqual(calls.map((c) => c.file), ['node'], 'only the PATH tier was probed');
    });

    test('the FLEET_SE_NODE override still beats the shortcut, and is still probed (the operator named THAT interpreter)', () => {
        const { exec, calls } = fakeExecCapturing({ '/explicit/node': 'v22.16.0' });

        const result = resolveSprintRunnerCommand({
            env: { FLEET_SE_NODE: '/explicit/node' },
            exec,
            platform: 'linux',
            execPath: process.execPath,
            isSea: () => false,
        });

        assert.equal(result.source, SPRINT_RUNNER_SOURCE.OVERRIDE);
        assert.equal(result.command, '/explicit/node');
        assert.deepEqual(calls.map((c) => c.file), ['/explicit/node']);
    });
});
