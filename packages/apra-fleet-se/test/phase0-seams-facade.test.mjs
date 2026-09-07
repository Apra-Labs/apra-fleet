import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resultText, resolveMemberTarget, clearMemberOsCache } from '../fleet-sprint/runner.js';

// apra-fleet-3swo.2.6: proves the two Phase 0 seams (mcp-result.mjs,
// member-target.mjs -- apra-fleet-3swo.2.4/2.5) are behaviour-preserving:
// runner.js's facade re-exports still resolve, the golden transcripts are
// byte-identical without UPDATE_GOLDEN, the member_detail cache contract
// holds, and -- crucially -- the facade assertion is provably non-vacuous
// (it actually fails when a re-export line is missing).

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.join(__dirname, '..');
const fleetSprintDir = path.join(packageRoot, 'fleet-sprint');
const runnerPath = path.join(fleetSprintDir, 'runner.js');
const goldenFixtureDir = path.join(__dirname, 'fixtures', 'golden-transcript');

/**
 * Walk up from `startDir` to find the workspace's hoisted node_modules (the
 * one holding @apralabs packages). runner.js imports workspace packages
 * (e.g. @apralabs/apra-fleet-workflow) via a bare specifier that Node
 * resolves by walking up node_modules directories from the importing file;
 * a sandbox copy under os.tmpdir() has no such chain to the repo root, so
 * the caller symlinks this directory in to restore it.
 */
function findWorkspaceNodeModules(startDir) {
    let dir = startDir;
    for (;;) {
        const candidate = path.join(dir, 'node_modules', '@apralabs');
        if (fs.existsSync(candidate)) return path.join(dir, 'node_modules');
        const parent = path.dirname(dir);
        if (parent === dir) {
            throw new Error(`could not locate a node_modules/@apralabs directory above ${startDir}`);
        }
        dir = parent;
    }
}

describe('Phase 0 seams: mcp-result + member-target preserve runner behaviour and the facade (apra-fleet-3swo.2.6)', () => {
    test('both golden transcript tests pass without UPDATE_GOLDEN, and the fixture directory stays clean', () => {
        const env = { ...process.env };
        delete env.UPDATE_GOLDEN;

        // This duplicates the execution the package's own test/*.test.mjs
        // glob already gives golden-transcript.test.mjs and
        // golden-transcript-3bead.test.mjs -- worth the extra ~1-2s because
        // it is the only place UPDATE_GOLDEN is guaranteed stripped: an
        // outer `UPDATE_GOLDEN=1 npm test` legitimately updates the fixtures
        // for the ambient run, which would make the git-status check below a
        // false failure if it depended on that run instead. An explicit
        // timeout caps the risk called out in apra-fleet-3swo.10 of an
        // untimed spawn silently hanging the whole suite.
        // Must not throw (node --test exits non-zero on any failing subtest).
        execFileSync(
            process.execPath,
            ['--test', 'test/golden-transcript.test.mjs', 'test/golden-transcript-3bead.test.mjs'],
            { cwd: packageRoot, env, stdio: 'pipe', timeout: 60_000 },
        );

        const dirty = execFileSync('git', ['status', '--porcelain', '--', goldenFixtureDir], {
            cwd: packageRoot,
            encoding: 'utf-8',
        }).trim();
        assert.equal(dirty, '', `golden-transcript fixtures must be unmodified after a run without UPDATE_GOLDEN; git status reported:\n${dirty}`);
    });

    test('runner.js still exports resolveMemberTarget and resultText (the result-text helper) by their original names', () => {
        assert.equal(typeof resolveMemberTarget, 'function', 'resolveMemberTarget must still resolve from fleet-sprint/runner.js');
        assert.equal(typeof resultText, 'function', 'resultText must still resolve from fleet-sprint/runner.js');
    });

    test('member_detail dispatch count does not increase when the same member is resolved twice', async () => {
        clearMemberOsCache();
        let callCount = 0;
        const fleetApi = {
            memberDetail: async () => {
                callCount += 1;
                return { content: [{ text: JSON.stringify({ os: 'linux', shell: '' }) }] };
            },
        };
        const log = () => {};

        await resolveMemberTarget({ fleetApi, member: 'facade-test-member', log });
        assert.equal(callCount, 1);
        await resolveMemberTarget({ fleetApi, member: 'facade-test-member', log });
        assert.equal(callCount, 1, 'a second resolution of the same member must be served from cache, not re-dispatch member_detail');

        clearMemberOsCache();
    });

    test('falsification: removing the resolveMemberTarget re-export from runner.js demonstrably breaks the facade assertion, then the line is restored', async () => {
        // Runs against a faithful sandbox copy of fleet-sprint/, not the
        // live tracked runner.js: this directory has 20+ files concurrently
        // imported (statically) by every other test file in a full `npm
        // test` run (test-concurrency=8, many files run as separate
        // processes at once). Mutating the shared tracked file in place --
        // even briefly, even restored synchronously -- would risk a
        // concurrent process's static `import ... from '../fleet-sprint/
        // runner.js'` observing the file mid-edit. A sandboxed copy proves
        // the identical fact (this exact re-export line is what makes the
        // symbol resolve through the facade) with zero shared-state risk,
        // and is fully cleaned up afterward -- "no artifacts left outside
        // the test sandbox" per this task's acceptance criteria.
        const realRunnerContentBefore = fs.readFileSync(runnerPath, 'utf-8');
        // Under os.tmpdir(), not the repo working tree -- matching the
        // sandbox convention every sibling guard test uses (guarded-modules-
        // coverage, shell-command-guard, dolt-literal-guard), so a hard kill
        // between mkdtemp and the finally below cannot leave an untracked,
        // un-.gitignore'd directory that dirties `git status`.
        const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-seam-facade-'));
        assert.ok(
            fs.realpathSync(sandboxDir).startsWith(fs.realpathSync(os.tmpdir())),
            'the sandbox must live under os.tmpdir(), not the repo tree',
        );
        try {
            const sandboxFleetSprint = path.join(sandboxDir, 'fleet-sprint');
            fs.cpSync(fleetSprintDir, sandboxFleetSprint, { recursive: true });
            // Restore workspace package resolution for the copy (see
            // findWorkspaceNodeModules doc comment above). rmSync on
            // sandboxDir at cleanup only unlinks this symlink, never
            // recurses into the real node_modules it points at.
            fs.symlinkSync(findWorkspaceNodeModules(packageRoot), path.join(sandboxDir, 'node_modules'), 'dir');
            const sandboxRunnerPath = path.join(sandboxFleetSprint, 'runner.js');
            const originalContent = fs.readFileSync(sandboxRunnerPath, 'utf-8');

            const reExportLine = "export { resolveMemberTarget, resolveMemberOs, clearMemberOsCache };";
            assert.ok(
                originalContent.includes(reExportLine),
                'expected runner.js to contain the exact resolveMemberTarget/resolveMemberOs/clearMemberOsCache re-export line this test removes',
            );

            // Sanity: the sandbox copy is faithful -- the facade resolves
            // before any mutation, same as the real module.
            const before = await import(`${sandboxRunnerPath}?facade-sanity=${Date.now()}-${Math.random()}`);
            assert.equal(typeof before.resolveMemberTarget, 'function');

            // Remove the single re-export line and prove the facade breaks.
            const brokenContent = originalContent.replace(`${reExportLine}\n`, '');
            assert.notEqual(brokenContent, originalContent, 'the re-export line must actually have been removed');
            fs.writeFileSync(sandboxRunnerPath, brokenContent, 'utf-8');
            const broken = await import(`${sandboxRunnerPath}?facade-broken=${Date.now()}-${Math.random()}`);
            assert.equal(
                broken.resolveMemberTarget,
                undefined,
                'removing the re-export line must make resolveMemberTarget unresolvable through the facade -- the assertion above is not vacuous',
            );

            // Restore, and prove the facade resolves again.
            fs.writeFileSync(sandboxRunnerPath, originalContent, 'utf-8');
            const restored = await import(`${sandboxRunnerPath}?facade-restored=${Date.now()}-${Math.random()}`);
            assert.equal(typeof restored.resolveMemberTarget, 'function', 'the re-export line must be restored before this task completes');
            assert.equal(fs.readFileSync(sandboxRunnerPath, 'utf-8'), originalContent, 'sandbox runner.js must be byte-identical to its original content once restored');
        } finally {
            fs.rmSync(sandboxDir, { recursive: true, force: true });
        }

        // The real, tracked runner.js was never touched by this test (compared
        // by content, not `git status`, since it may legitimately already
        // carry uncommitted Phase 0 seam changes from this same task).
        const realRunnerContentAfter = fs.readFileSync(runnerPath, 'utf-8');
        assert.equal(realRunnerContentAfter, realRunnerContentBefore, 'the real fleet-sprint/runner.js must be byte-identical before and after this test');

        // No sandbox directory left behind under os.tmpdir() either.
        assert.equal(fs.existsSync(sandboxDir), false, 'no sandbox directory may survive this test');
    });
});
