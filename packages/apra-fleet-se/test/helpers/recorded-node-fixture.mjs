// apra-fleet-i9ag.19.34 -- shared "recorded node" test fixture.
//
// WHY THIS EXISTS (judge D4): test/i9ag19-11-serve-startup-toolchain.test.mjs
// and test/i9ag19-14-pathless-service-launch.test.mjs each used to build
// their own "recorded node" by fs.linkSync/copyFileSync'ing the running test
// runner's OWN node binary into a fresh, UNRELATED temp directory. On a
// Homebrew-installed macOS node this crashes on start: `otool -l` on a real
// Homebrew node binary shows two LC_RPATH entries, `@loader_path` and
// `@loader_path/../lib`, and its ONE non-absolute dependency,
// `@rpath/libnode.NNN.dylib`, is therefore looked up RELATIVE TO THE
// INVOKING PATH -- which, for a hard-linked copy sitting in an unrelated
// temp dir, has no co-located `../lib/libnode.NNN.dylib` at all. Empirically
// reproduced against a real Homebrew node install (this repo's own dev
// host, apra-fleet-i9ag.19.34's own investigation):
//   $ ln <homebrew node> /tmp/xyz/recorded-node && /tmp/xyz/recorded-node --version
//   dyld[...]: Library not loaded: @rpath/libnode.141.dylib
//     Referenced from: /tmp/xyz/recorded-node
//     Reason: tried: '/tmp/xyz/libnode.141.dylib' (no such file), ...
//   [exit 134 -- SIGABRT]
// -- the exact class of failure judge D4 reports (13 tests failing outright,
// ~90 unrelated test files SIGABRT-ing for as long as the broken link
// exists). Every OTHER dependency in that same node binary (libuv, llhttp,
// openssl, icu4c, ...) is linked with an ABSOLUTE Cellar path and is
// therefore completely unaffected by where the binary is invoked from --
// libnode is the only location-relative one, and it is exactly the one this
// fixture has to keep resolvable.
//
// WHY NOT A PLAIN SYMLINK TO process.execPath: a symlink also fixes the
// @rpath lookup above (dyld/libuv follow the symlink to node's REAL,
// original location, so `@loader_path/../lib` resolves there too) -- but it
// does so PRECISELY BECAUSE `process.execPath`, as reported by a node
// process started that way, resolves the symlink and reports node's real,
// ORIGINAL path, never the symlink's own path. This is documented Node.js
// behaviour (process.execPath: "Symbolic links, if any, are resolved";
// process.argv[0] is separately documented to always equal process.execPath)
// and was verified directly here with `child_process.spawnSync`: a node
// spawned through a fresh symlink reports process.execPath as the symlink's
// TARGET, not the symlink's own path. Both suites this fixture serves
// assert, byte for byte, that a spawned child's OWN reported
// process.execPath equals the exact "recorded node" path AND is DISTINCT
// from the test runner's own process.execPath (i9ag19-14's
// `samePath(record.execPath, fixture.recordedNode)` /
// `!samePath(record.execPath, process.execPath)`; i9ag19-11's
// `path.resolve(records[0].execPath) === path.resolve(fixture.recordedNode)`)
// -- proving the CONFIGURED tier was used, not the current-runtime tier. A
// symlink to the test runner's own node necessarily resolves to the EXACT
// SAME underlying binary the test runner itself is running, so a
// symlink-built fixture could never satisfy either assertion:
// `record.execPath` would equal the test runner's own `process.execPath` on
// the nose, indistinguishable from tier 3 (current-runtime) BY
// CONSTRUCTION, not by comparison mechanics -- no normalization of the
// comparison could fix that; only a fixture whose own identity differs from
// the original solves it.
//
// THE FIX USED HERE: a HARD LINK of the main `node` binary (fs.linkSync,
// the same zero-copy, instant mechanism used before this bead -- a hard
// link, unlike a symlink, has no "target" to resolve, so a hard-linked node
// reports EXACTLY its own invoked path as process.execPath, preserving the
// identity property both suites need and were already written against),
// PLUS a SYMLINK of node's own sibling `lib/` directory into the SAME
// relative position next to the hard link, ONLY when that directory
// actually exists. That second symlink is what fixes the crash:
// `@loader_path/../lib/libnode.NNN.dylib` now resolves inside this fixture
// directory, to a directory symlink that itself resolves straight back to
// the ORIGINAL Cellar lib/ dir dyld already trusts -- a symlinked directory
// costs nothing to create and copies zero bytes (unlike hard-linking or
// copying the tens-of-megabytes libnode.dylib itself would). Symlinking is
// safe here specifically because dylib *loading* follows symlinks
// transparently on open() -- it is only process.execPath's OWN special
// resolution rule (above) that a symlink would defeat, and that rule only
// ever applies to the MAIN executable, never to a dependency it loads.
//
// On a self-contained node build with no sibling `lib/` at all (the common
// case for nvm/nodejs.org-tarball installs on macOS, Linux and Windows --
// verified: only the Homebrew build's `@rpath/libnode.NNN.dylib` dependency
// is location-relative, and a self-contained build has no separate libnode
// at all), the lib-symlink step is a no-op: there is no `lib/` directory to
// find, so nothing is created, and the hard link alone is already
// sufficient -- the exact property this fixture relied on before this bead,
// verified here not to have broken for those builds.
//
// Empirically verified end to end on this repo's own dev host (a real
// Homebrew node install): a bare hard link into an unrelated temp dir
// reproduces the exact reported crash (`dyld: Library not loaded:
// @rpath/libnode.141.dylib`, exit 134); the SAME hard link WITH the sibling
// `lib/` symlink added gets past that exact failure (dyld resolves libnode
// successfully and moves on to the binary's next, absolute-path,
// dependency).
//
// WINDOWS: `fs.linkSync` (an NTFS hard link) needs no elevated privilege --
// unlike `fs.symlinkSync`, which requires SeCreateSymbolicLinkPrivilege or
// Developer Mode by default -- so it is the "junction-free equivalent" this
// bead's own acceptance criteria ask for (a junction is Windows' directory-
// only, symlink-like mechanism; it does not apply to a single .exe file at
// all, which is why this fixture reaches for a hard link instead). Official
// Windows node.exe builds do not ship a separate, relatively-linked
// "node.dll" the way Homebrew's macOS build ships a separate libnode.dylib
// (Windows builds are far closer to self-contained), so this bug class is
// not known to reproduce there -- the hard link this fixture already used
// on Windows is left unchanged, with the SAME sibling-`lib/`-if-present
// symlink step applied uniformly (harmless when absent, and a safety net if
// some Windows node distribution ever does ship a co-located, relatively-
// resolved DLL). A directory symlink also needs elevated privilege on
// Windows; failing to create it is caught and silently skipped, since
// Windows does not need it for any known build anyway.
//
// A cross-device tmp dir (hard link impossible, ENOTSUP/EXDEV) falls back
// to a byte copy, exactly as this fixture did before this bead -- rare in
// practice (every caller's tmp dir comes from os.tmpdir()), and a copy
// carries the identical relocatability risk a hard link does, so it is
// covered by the same sibling-lib symlink step too.
//
// ASCII only.

import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';

/**
 * Builds a "recorded node" fixture inside `toolDir`: a real, independently
 * running Node.js interpreter at an absolute path distinct from
 * `process.execPath` (the test runner's own), structured
 * `<toolDir>/bin/<name>` with node's own sibling `lib/` directory (if any)
 * symlinked alongside it at `<toolDir>/lib`, so a build whose main binary
 * depends on a co-located, relatively-resolved shared library (Homebrew's
 * macOS node) still starts. See the module doc comment above for the full
 * "why" and the empirical evidence behind this specific shape.
 *
 * Asserts (never returns a broken fixture to a caller): the built path is
 * distinct from `process.execPath`, and `<recordedNode> --version` actually
 * runs and exits 0 -- both properties every existing caller already relied
 * on before this bead, preserved here byte for byte.
 *
 * THE `name` OPTION (apra-fleet-i9ag.19.14 amended AC A1/A2): the default
 * basename `recorded-node` is deliberately NOT `node`, so a suite asserting
 * "the CONFIGURED tier was used" cannot be confused by a coincidental PATH
 * hit on a file that merely happens to be called `node`. But one caller
 * needs the opposite: a REAL npm-shaped `bd` shim is a
 * `#!/usr/bin/env node` script (POSIX) or an npm `.cmd` that prefers a
 * co-located `node.exe` (Windows), and BOTH of those resolve the interpreter
 * by the literal name `node` -- so a suite reproducing the PATH-less-service
 * defect against a real shim must be able to record a node whose basename is
 * exactly `node`/`node.exe`. That is a property of the FIXTURE (what the file
 * is called), never of the assertions built on it: the returned path is still
 * a distinct absolute path from `process.execPath`, still asserted so below,
 * so `record.execPath === recordedNode && record.execPath !== process.execPath`
 * keeps distinguishing the CONFIGURED tier from the current-runtime tier
 * exactly as before. `.exe` is appended on win32 by this fixture, so callers
 * pass the platform-neutral stem.
 *
 * @param {string} toolDir - an existing, writable directory (typically a
 *   fresh temp dir) this fixture creates its own `bin/` (and, if needed,
 *   `lib/`) subdirectories under.
 * @param {{ name?: string }} [options] - `name` is the platform-neutral
 *   basename stem for the recorded interpreter (default `recorded-node`);
 *   see the paragraph above for when a caller needs `'node'` instead.
 * @returns {string} the absolute path to the recorded node executable.
 */
export function buildRecordedNode(toolDir, options = {}) {
    const { name = 'recorded-node' } = options;
    assert.ok(
        typeof name === 'string' && name.length > 0 && !/[\\/]/.test(name),
        'buildRecordedNode(): `name` must be a bare basename stem, never a path',
    );
    const isWin = process.platform === 'win32';
    const realNode = fs.realpathSync(process.execPath);
    const binDir = path.join(toolDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const recordedNode = path.join(binDir, isWin ? `${name}.exe` : name);

    try {
        fs.linkSync(realNode, recordedNode);
    } catch {
        fs.copyFileSync(realNode, recordedNode);
    }

    // Mirror node's own `bin/../lib` layout (if it has one) so an
    // `@loader_path/../lib`-relative dependency (Homebrew's libnode.dylib)
    // still resolves -- see the module doc comment for the full mechanism
    // and why a directory SYMLINK here is safe. No-op (and non-fatal on a
    // permission failure) for a self-contained build with no `lib/` sibling
    // at all, or on a Windows host without symlink privilege.
    const realLibDir = path.join(path.dirname(path.dirname(realNode)), 'lib');
    if (fs.existsSync(realLibDir)) {
        const linkedLibDir = path.join(toolDir, 'lib');
        try {
            fs.symlinkSync(realLibDir, linkedLibDir, 'dir');
        } catch {
            // Best-effort: a build that does not actually need this (the
            // overwhelmingly common case) is unaffected either way.
        }
    }

    assert.notEqual(
        recordedNode, process.execPath,
        'the recorded node must be a DIFFERENT path from the test runner/supervisor own execPath, '
        + 'or a launch resolved from the current runtime would be indistinguishable from one resolved from the recording',
    );
    const probe = spawnSync(recordedNode, ['--version'], { encoding: 'utf-8' });
    assert.equal(probe.status, 0, `the recorded node fixture is not executable: ${probe.error ? probe.error.message : probe.stderr}`);

    return recordedNode;
}
