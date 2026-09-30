import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    SUPERVISOR_CONFIG_FILENAME,
    supervisorConfigPath,
    readSupervisorConfig,
    writeSupervisorConfig,
    writeSupervisorToolchain,
} from '../src/supervisor/project-config.mjs';
import { defaultDataDir } from '../src/supervisor/ledger.mjs';

/** Repo root, two levels up from this package (packages/apra-fleet-se/test/..). */
const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..');

// =============================================================================
// src/supervisor/project-config.mjs -- the single owner of
// supervisor.config.json: where it lives (FLEET_SE_DATA_DIR, never a second
// home literal), that reading it is TOTAL (four distinct bad inputs each
// degrade to not-configured + a reason, none of them throw), that writing it
// is atomic, and that unknown keys survive a write by this build.
//
// Every test below works inside its OWN mkdtemp directory under os.tmpdir()
// and cleans it up; nothing here writes to a real home directory. The
// FLEET_SE_DATA_DIR test restores the previous value in a finally/afterEach so
// it cannot leak into a sibling test in this same file-process.
// =============================================================================

/** Temp dirs created by this file, removed in afterEach. */
const tmpDirs = [];

/**
 * mkdtemp under a REALPATH'd root. os.tmpdir() is itself a symlink on some
 * hosts (macOS: /var/folders/... -> /private/var/folders/...), and a spawned
 * supervisor reports its cwd already resolved, so an un-resolved fixture path
 * would not compare equal to what the process reports. Resolving once at
 * creation keeps both sides of every path assertion in the same spelling.
 * The `.native` variant also expands a Windows 8.3 short name.
 */
async function mkRealTmp(prefix) {
    return fs.realpathSync.native(await fsp.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function mkTmp(prefix = 'apra-fleet-project-config-') {
    const dir = await mkRealTmp(prefix);
    tmpDirs.push(dir);
    return dir;
}

const savedDataDirEnv = process.env.FLEET_SE_DATA_DIR;

afterEach(async () => {
    if (savedDataDirEnv === undefined) delete process.env.FLEET_SE_DATA_DIR;
    else process.env.FLEET_SE_DATA_DIR = savedDataDirEnv;
    while (tmpDirs.length) {
        await fsp.rm(tmpDirs.pop(), { recursive: true, force: true });
    }
});

describe('project-config -- where the file lives', () => {
    test('the path derives from defaultDataDir(): FLEET_SE_DATA_DIR moves the file, with no home fallback', async () => {
        const dataDir = await mkTmp('apra-fleet-project-config-env-');
        process.env.FLEET_SE_DATA_DIR = dataDir;

        const resolved = supervisorConfigPath();

        assert.equal(resolved, path.join(dataDir, SUPERVISOR_CONFIG_FILENAME));
        assert.equal(resolved, path.join(defaultDataDir(), SUPERVISOR_CONFIG_FILENAME));
        // The decisive assertion: the resolved path is INSIDE the temp data dir
        // and nowhere near the real home directory. A second home literal in
        // the module would show up right here.
        assert.ok(resolved.startsWith(dataDir + path.sep), `${resolved} is not under ${dataDir}`);
        assert.ok(
            !resolved.startsWith(path.join(os.homedir(), '.apra-fleet-se')),
            `${resolved} escaped FLEET_SE_DATA_DIR into the real home directory`,
        );

        // And a real write lands there, not in a home directory.
        const projectDir = await mkTmp('apra-fleet-project-config-proj-');
        await writeSupervisorConfig({ projectDir });
        const onDisk = JSON.parse(await fsp.readFile(resolved, 'utf-8'));
        assert.equal(onDisk.projectDir, projectDir);
    });

    test('an explicit dataDir overrides the env knob (second-instance / test injection)', async () => {
        const envDir = await mkTmp('apra-fleet-project-config-env2-');
        const explicitDir = await mkTmp('apra-fleet-project-config-explicit-');
        process.env.FLEET_SE_DATA_DIR = envDir;

        assert.equal(
            supervisorConfigPath({ dataDir: explicitDir }),
            path.join(explicitDir, SUPERVISOR_CONFIG_FILENAME),
        );
    });
});

describe('project-config -- reading is total (each bad input asserted individually)', () => {
    test('1/4 missing file: not configured, reason names the path, does not throw', async () => {
        const dataDir = await mkTmp();
        const r = await readSupervisorConfig({ dataDir });

        assert.equal(r.configured, false);
        assert.equal(r.projectDir, null);
        assert.match(r.reason, /no supervisor\.config\.json/);
        assert.ok(r.reason.includes(dataDir), `reason should name the path, got: ${r.reason}`);
        assert.deepEqual(r.raw, {});
    });

    test('2/4 unreadable file: not configured, reason carries the I/O detail, does not throw', async () => {
        const dataDir = await mkTmp();
        // Injected fs so this case does not depend on chmod semantics, which
        // differ on Windows and are a no-op for root.
        const denied = Object.assign(new Error('permission denied, open'), { code: 'EACCES' });
        const r = await readSupervisorConfig({
            dataDir,
            fs: { readFile: async () => { throw denied; } },
        });

        assert.equal(r.configured, false);
        assert.equal(r.projectDir, null);
        assert.match(r.reason, /could not read/);
        assert.match(r.reason, /permission denied/);
    });

    test('3/4 malformed JSON: not configured, reason says it is not valid JSON, does not throw', async () => {
        const dataDir = await mkTmp();
        await fsp.writeFile(path.join(dataDir, SUPERVISOR_CONFIG_FILENAME), '{"projectDir": "/x", trunc', 'utf-8');

        const r = await readSupervisorConfig({ dataDir });

        assert.equal(r.configured, false);
        assert.equal(r.projectDir, null);
        assert.match(r.reason, /is not valid JSON/);
    });

    test('4/4 valid JSON with a wrong-typed projectDir: not configured, reason says so, does not throw', async () => {
        const dataDir = await mkTmp();
        await fsp.writeFile(
            path.join(dataDir, SUPERVISOR_CONFIG_FILENAME),
            JSON.stringify({ projectDir: 42, keepMe: 'yes' }),
            'utf-8',
        );

        const r = await readSupervisorConfig({ dataDir });

        assert.equal(r.configured, false);
        assert.equal(r.projectDir, null);
        assert.match(r.reason, /not a non-empty string/);
        assert.match(r.reason, /number/);
        // raw is still handed back so a writer can preserve the other keys.
        assert.equal(r.raw.keepMe, 'yes');
    });

    test('further not-configured shapes also degrade rather than throw', async () => {
        const dataDir = await mkTmp();
        const file = path.join(dataDir, SUPERVISOR_CONFIG_FILENAME);
        const cases = [
            ['a JSON array', '[1,2,3]', /must contain a JSON object, got an array/],
            ['JSON null', 'null', /must contain a JSON object, got object/],
            ['a bare number', '7', /must contain a JSON object, got number/],
            ['no projectDir key', '{"other":1}', /has no 'projectDir' setting/],
            ['a blank projectDir', '{"projectDir":"   "}', /not a non-empty string \(got an empty string\)/],
            ['a null projectDir', '{"projectDir":null}', /has no 'projectDir' setting/],
            ['an array projectDir', '{"projectDir":["/x"]}', /not a non-empty string \(got a array\)/],
        ];
        for (const [label, body, expected] of cases) {
            await fsp.writeFile(file, body, 'utf-8');
            const r = await readSupervisorConfig({ dataDir });
            assert.equal(r.configured, false, `${label} should be not-configured`);
            assert.equal(r.projectDir, null, `${label} should have no projectDir`);
            assert.match(r.reason, expected, `${label} reason: ${r.reason}`);
        }
    });

    test('a good file reads back an absolute projectDir and the whole raw object', async () => {
        const dataDir = await mkTmp();
        const projectDir = await mkTmp('apra-fleet-project-config-proj-');
        await fsp.writeFile(
            path.join(dataDir, SUPERVISOR_CONFIG_FILENAME),
            JSON.stringify({ projectDir, futureField: { a: 1 } }),
            'utf-8',
        );

        const r = await readSupervisorConfig({ dataDir });

        assert.equal(r.configured, true);
        assert.equal(r.projectDir, projectDir);
        assert.equal(r.reason, null);
        assert.deepEqual(r.raw.futureField, { a: 1 });
    });

    test('a relative projectDir resolves against cwd, so the caller never sees a relative path', async () => {
        const dataDir = await mkTmp();
        const base = await mkTmp('apra-fleet-project-config-base-');
        await fsp.writeFile(
            path.join(dataDir, SUPERVISOR_CONFIG_FILENAME),
            JSON.stringify({ projectDir: 'sub/proj' }),
            'utf-8',
        );

        const r = await readSupervisorConfig({ dataDir, cwd: base });

        assert.equal(r.configured, true);
        assert.equal(r.projectDir, path.join(base, 'sub', 'proj'));
        assert.ok(path.isAbsolute(r.projectDir));
    });
});

describe('project-config -- writing', () => {
    test('round-trips through the reader and stores an absolute path', async () => {
        const dataDir = await mkTmp();
        const projectDir = await mkTmp('apra-fleet-project-config-proj-');

        const written = await writeSupervisorConfig({ dataDir, projectDir });
        assert.equal(written.projectDir, projectDir);
        assert.equal(written.path, path.join(dataDir, SUPERVISOR_CONFIG_FILENAME));

        const r = await readSupervisorConfig({ dataDir });
        assert.equal(r.configured, true);
        assert.equal(r.projectDir, projectDir);
    });

    test('creates the data dir when it does not exist yet (first-boot write)', async () => {
        const parent = await mkTmp();
        const dataDir = path.join(parent, 'not', 'created', 'yet');
        const projectDir = await mkTmp('apra-fleet-project-config-proj-');

        await writeSupervisorConfig({ dataDir, projectDir });

        const r = await readSupervisorConfig({ dataDir });
        assert.equal(r.configured, true);
        assert.equal(r.projectDir, projectDir);
    });

    test('unknown keys are PRESERVED, not silently dropped, so a newer field survives an older writer', async () => {
        const dataDir = await mkTmp();
        const first = await mkTmp('apra-fleet-project-config-a-');
        const second = await mkTmp('apra-fleet-project-config-b-');
        await fsp.writeFile(
            path.join(dataDir, SUPERVISOR_CONFIG_FILENAME),
            JSON.stringify({
                projectDir: first,
                futureSetting: 'do not destroy me',
                nested: { deep: [1, 2, 3] },
            }),
            'utf-8',
        );

        await writeSupervisorConfig({ dataDir, projectDir: second });

        const onDisk = JSON.parse(await fsp.readFile(path.join(dataDir, SUPERVISOR_CONFIG_FILENAME), 'utf-8'));
        assert.equal(onDisk.projectDir, second, 'our own field is updated');
        assert.equal(onDisk.futureSetting, 'do not destroy me', 'unknown scalar key preserved');
        assert.deepEqual(onDisk.nested, { deep: [1, 2, 3] }, 'unknown nested key preserved');
    });

    test('a corrupt current file is replaced rather than blocking the write', async () => {
        const dataDir = await mkTmp();
        const projectDir = await mkTmp('apra-fleet-project-config-proj-');
        await fsp.writeFile(path.join(dataDir, SUPERVISOR_CONFIG_FILENAME), 'not json at all', 'utf-8');

        await writeSupervisorConfig({ dataDir, projectDir });

        const r = await readSupervisorConfig({ dataDir });
        assert.equal(r.configured, true);
        assert.equal(r.projectDir, projectDir);
    });

    test('writing is atomic: a temp file is written then renamed, never a partial destination', async () => {
        const dataDir = await mkTmp();
        const projectDir = await mkTmp('apra-fleet-project-config-proj-');
        const target = path.join(dataDir, SUPERVISOR_CONFIG_FILENAME);

        // Record the fs call order, and prove the bytes reach a DIFFERENT path
        // than the destination before any rename touches the destination.
        const calls = [];
        const spyFs = {
            readFile: (...a) => { calls.push(['readFile', a[0]]); return fsp.readFile(...a); },
            mkdir: (...a) => { calls.push(['mkdir', a[0]]); return fsp.mkdir(...a); },
            writeFile: (...a) => { calls.push(['writeFile', a[0]]); return fsp.writeFile(...a); },
            rename: (...a) => { calls.push(['rename', a[0], a[1]]); return fsp.rename(...a); },
        };

        await writeSupervisorConfig({ dataDir, projectDir, fs: spyFs });

        const write = calls.find((c) => c[0] === 'writeFile');
        const rename = calls.find((c) => c[0] === 'rename');
        assert.ok(write, 'a writeFile happened');
        assert.ok(rename, 'a rename happened');
        assert.notEqual(write[1], target, 'the payload is NOT written directly over the destination');
        assert.equal(write[1], `${target}.tmp`, 'the payload goes to the .tmp sibling');
        assert.equal(rename[1], `${target}.tmp`, 'the rename source is that temp file');
        assert.equal(rename[2], target, 'the rename destination is the real file');
        assert.ok(
            calls.indexOf(write) < calls.indexOf(rename),
            'write must precede rename (temp-then-rename, not rename-then-write)',
        );

        // An interrupted write (the rename never happens) must leave the
        // PREVIOUS good file intact and readable, not a truncated one.
        await writeSupervisorConfig({ dataDir, projectDir });
        const interrupted = {
            readFile: fsp.readFile,
            mkdir: fsp.mkdir,
            writeFile: fsp.writeFile,
            rename: async () => { throw Object.assign(new Error('interrupted'), { code: 'EIO' }); },
        };
        const other = await mkTmp('apra-fleet-project-config-other-');
        await assert.rejects(
            () => writeSupervisorConfig({ dataDir, projectDir: other, fs: interrupted }),
            /interrupted/,
        );
        const after = await readSupervisorConfig({ dataDir });
        assert.equal(after.configured, true, 'the previous file is still valid after an interrupted write');
        assert.equal(after.projectDir, projectDir, 'and still carries the previous value');
    });

    test('no temp file is left behind after a successful write', async () => {
        const dataDir = await mkTmp();
        const projectDir = await mkTmp('apra-fleet-project-config-proj-');

        await writeSupervisorConfig({ dataDir, projectDir });

        const entries = await fsp.readdir(dataDir);
        assert.deepEqual(entries, [SUPERVISOR_CONFIG_FILENAME]);
    });

    test('a missing or blank projectDir is a programming error, not a silent empty write', async () => {
        const dataDir = await mkTmp();
        await assert.rejects(() => writeSupervisorConfig({ dataDir }), /non-empty projectDir string/);
        await assert.rejects(() => writeSupervisorConfig({ dataDir, projectDir: '  ' }), /non-empty projectDir string/);
        await assert.rejects(() => writeSupervisorConfig({ dataDir, projectDir: 5 }), /non-empty projectDir string/);
        // Nothing was created by any of the rejected calls.
        assert.deepEqual(await fsp.readdir(dataDir), []);
    });
});

describe('project-config -- toolchain reading is total (apra-fleet-i9ag.19.3)', () => {
    test('AC1: a file written by seedSupervisorToolchain() (the core installer, a different package) reads back through readSupervisorConfig() with the same values', async () => {
        const dataDir = await mkTmp();
        // dist/cli/supervisor.js is the compiled output of src/cli/supervisor.ts
        // in the ROOT package -- a different package from this one, which is
        // exactly why this is the one case that proves the two writers (this
        // module's writeSupervisorToolchain() and the core installer's
        // seedSupervisorToolchain()) agree on the wire format instead of only
        // "by eye". Cache-busted the same way installed-supervisor.test.mjs
        // already imports dist/cli/*.js, since a bare import would be cached
        // across test files in this same process.
        const cacheBust = `${Date.now()}-${Math.random()}`;
        const supervisorMod = await import(
            `${pathToFileURL(path.join(REPO_ROOT, 'dist', 'cli', 'supervisor.js')).href}?project-config-toolchain=${cacheBust}`
        );

        const resolvedToolchain = {
            node: { path: '/opt/nvm/versions/node/v22.16.0/bin/node', version: '22.16.0', ok: true, reason: null },
            bd: { path: '/usr/local/bin/bd', version: '1.3.0', ok: true, reason: null },
        };
        const seedResult = supervisorMod.seedSupervisorToolchain(resolvedToolchain, dataDir);
        assert.equal(seedResult.ok, true, 'seedSupervisorToolchain should succeed for a resolved node');

        const r = await readSupervisorConfig({ dataDir });
        assert.equal(r.toolchainReason, null);
        assert.ok(r.toolchain, 'toolchain should read back non-null');
        assert.equal(r.toolchain.nodePath, resolvedToolchain.node.path);
        assert.equal(r.toolchain.nodeVersion, resolvedToolchain.node.version);
        assert.equal(r.toolchain.bdPath, resolvedToolchain.bd.path);
        assert.equal(r.toolchain.bdVersion, resolvedToolchain.bd.version);
        assert.equal(typeof r.toolchain.recordedAt, 'string');
        assert.ok(!Number.isNaN(Date.parse(r.toolchain.recordedAt)), 'recordedAt should be a parseable timestamp');
    });

    test('AC2: each malformed toolchain shape returns toolchain:null with its OWN distinguishable reason', async () => {
        const dataDir = await mkTmp();
        const file = path.join(dataDir, SUPERVISOR_CONFIG_FILENAME);
        const cases = [
            ['no toolchain key at all', { projectDir: '/x' }, /has no 'toolchain' setting/],
            ['a null toolchain', { projectDir: '/x', toolchain: null }, /has no 'toolchain' setting/],
            ['a string toolchain', { toolchain: 'nope' }, /'toolchain' that is not an object \(got string\)/],
            ['an array toolchain', { toolchain: ['/x'] }, /'toolchain' that is not an object \(got an array\)/],
            ['a number toolchain', { toolchain: 7 }, /'toolchain' that is not an object \(got number\)/],
            ['toolchain with no nodePath key', { toolchain: { bdPath: '/usr/bin/bd' } }, /toolchain has no 'nodePath' setting/],
            ['toolchain with a null nodePath', { toolchain: { nodePath: null } }, /toolchain has no 'nodePath' setting/],
            ['toolchain with a numeric nodePath', { toolchain: { nodePath: 7 } }, /'nodePath' that is not a string \(got number\)/],
            ['toolchain with an array nodePath', { toolchain: { nodePath: ['/x'] } }, /'nodePath' that is not a string \(got an array\)/],
            ['toolchain with a blank nodePath', { toolchain: { nodePath: '   ' } }, /'nodePath' that is blank/],
            ['toolchain with a relative nodePath', { toolchain: { nodePath: 'bin/node' } }, /'nodePath' that is not an absolute path: bin\/node/],
        ];

        // "missing" and "null" are documented as the SAME not-yet-recorded case
        // (see readToolchainBlock()'s doc comment), so they share one reason
        // text by design; every other shape below must be distinguishable from
        // every other shape's reason, which the per-case regex below enforces.
        for (const [label, body, expected] of cases) {
            await fsp.writeFile(file, JSON.stringify(body), 'utf-8');
            const r = await readSupervisorConfig({ dataDir });
            assert.equal(r.toolchain, null, `${label} should have a null toolchain`);
            assert.match(r.toolchainReason, expected, `${label} toolchainReason: ${r.toolchainReason}`);
        }
    });

    test('AC3: a valid toolchain plus a malformed projectDir -> configured:false with a projectDir reason AND a non-null toolchain', async () => {
        const dataDir = await mkTmp();
        await fsp.writeFile(
            path.join(dataDir, SUPERVISOR_CONFIG_FILENAME),
            JSON.stringify({
                projectDir: 42,
                toolchain: { nodePath: '/usr/bin/node', nodeVersion: '22.16.0', bdPath: null, bdVersion: null, recordedAt: '2026-01-01T00:00:00.000Z' },
            }),
            'utf-8',
        );

        const r = await readSupervisorConfig({ dataDir });

        assert.equal(r.configured, false);
        assert.match(r.reason, /not a non-empty string/);
        assert.equal(r.toolchainReason, null);
        assert.deepEqual(r.toolchain, {
            nodePath: '/usr/bin/node',
            nodeVersion: '22.16.0',
            bdPath: null,
            bdVersion: null,
            recordedAt: '2026-01-01T00:00:00.000Z',
        });
    });

    test('AC3 (reverse): a valid projectDir plus a malformed toolchain -> configured:true with the toolchain null and its own reason', async () => {
        const dataDir = await mkTmp();
        const projectDir = await mkTmp('apra-fleet-project-config-proj-');
        await fsp.writeFile(
            path.join(dataDir, SUPERVISOR_CONFIG_FILENAME),
            JSON.stringify({ projectDir, toolchain: { nodePath: 'relative/node' } }),
            'utf-8',
        );

        const r = await readSupervisorConfig({ dataDir });

        assert.equal(r.configured, true);
        assert.equal(r.projectDir, projectDir);
        assert.equal(r.reason, null);
        assert.equal(r.toolchain, null);
        assert.match(r.toolchainReason, /'nodePath' that is not an absolute path/);
    });
});

describe('project-config -- toolchain writing preserves the OTHER setting (apra-fleet-i9ag.19.3 AC4)', () => {
    test('writeSupervisorToolchain() preserves an existing projectDir and unknown top-level keys', async () => {
        const dataDir = await mkTmp();
        const projectDir = await mkTmp('apra-fleet-project-config-proj-');
        await fsp.writeFile(
            path.join(dataDir, SUPERVISOR_CONFIG_FILENAME),
            JSON.stringify({ projectDir, futureSetting: 'do not destroy me' }),
            'utf-8',
        );

        const written = await writeSupervisorToolchain(
            { nodePath: '/usr/bin/node', nodeVersion: '22.16.0', bdPath: '/usr/bin/bd', bdVersion: '1.3.0' },
            { dataDir },
        );
        assert.equal(written.toolchain.nodePath, '/usr/bin/node');

        const onDisk = JSON.parse(await fsp.readFile(path.join(dataDir, SUPERVISOR_CONFIG_FILENAME), 'utf-8'));
        assert.equal(onDisk.projectDir, projectDir, 'projectDir survives a toolchain write');
        assert.equal(onDisk.futureSetting, 'do not destroy me', 'unknown key survives a toolchain write');
        assert.equal(onDisk.toolchain.nodePath, '/usr/bin/node');

        const r = await readSupervisorConfig({ dataDir });
        assert.equal(r.configured, true);
        assert.equal(r.projectDir, projectDir);
        assert.equal(r.toolchain.nodePath, '/usr/bin/node');
    });

    test('writeSupervisorConfig({ projectDir }) leaves an existing toolchain block intact', async () => {
        const dataDir = await mkTmp();
        const first = await mkTmp('apra-fleet-project-config-a-');
        const second = await mkTmp('apra-fleet-project-config-b-');
        await writeSupervisorToolchain({ nodePath: '/usr/bin/node' }, { dataDir });
        await writeSupervisorConfig({ dataDir, projectDir: first });

        await writeSupervisorConfig({ dataDir, projectDir: second });

        const onDisk = JSON.parse(await fsp.readFile(path.join(dataDir, SUPERVISOR_CONFIG_FILENAME), 'utf-8'));
        assert.equal(onDisk.projectDir, second, 'projectDir write still updates its own field');
        assert.equal(onDisk.toolchain.nodePath, '/usr/bin/node', 'toolchain block survives a projectDir-only write');

        const r = await readSupervisorConfig({ dataDir });
        assert.equal(r.configured, true);
        assert.equal(r.projectDir, second);
        assert.equal(r.toolchain.nodePath, '/usr/bin/node');
    });

    test('writeSupervisorToolchain() requires a non-empty, absolute nodePath and does not write on a bad one', async () => {
        const dataDir = await mkTmp();
        await assert.rejects(() => writeSupervisorToolchain({ nodePath: '' }, { dataDir }), /absolute, non-empty toolchain\.nodePath/);
        await assert.rejects(() => writeSupervisorToolchain({ nodePath: 'relative/node' }, { dataDir }), /absolute, non-empty toolchain\.nodePath/);
        await assert.rejects(() => writeSupervisorToolchain(null, { dataDir }), /requires a toolchain object/);
        assert.deepEqual(await fsp.readdir(dataDir), [], 'nothing written by any rejected call');
    });

    test('writeSupervisorToolchain() writes atomically: temp file then rename, no temp file left behind', async () => {
        const dataDir = await mkTmp();
        const target = path.join(dataDir, SUPERVISOR_CONFIG_FILENAME);

        const calls = [];
        const spyFs = {
            readFile: (...a) => { calls.push(['readFile', a[0]]); return fsp.readFile(...a); },
            mkdir: (...a) => { calls.push(['mkdir', a[0]]); return fsp.mkdir(...a); },
            writeFile: (...a) => { calls.push(['writeFile', a[0]]); return fsp.writeFile(...a); },
            rename: (...a) => { calls.push(['rename', a[0], a[1]]); return fsp.rename(...a); },
        };

        await writeSupervisorToolchain({ nodePath: '/usr/bin/node' }, { dataDir, fs: spyFs });

        const write = calls.find((c) => c[0] === 'writeFile');
        const rename = calls.find((c) => c[0] === 'rename');
        assert.ok(write, 'a writeFile happened');
        assert.ok(rename, 'a rename happened');
        assert.equal(write[1], `${target}.tmp`, 'the payload goes to the .tmp sibling');
        assert.equal(rename[1], `${target}.tmp`);
        assert.equal(rename[2], target);
        assert.ok(calls.indexOf(write) < calls.indexOf(rename), 'write must precede rename');

        const entries = await fsp.readdir(dataDir);
        assert.deepEqual(entries, [SUPERVISOR_CONFIG_FILENAME], 'no .tmp sibling left behind');
    });
});

describe('project-config -- module ownership and recorded decision', () => {
    test('this module is the only code that opens supervisor.config.json by name', async () => {
        // Guards the acceptance criterion directly: a second hand-rolled
        // reader/writer elsewhere would fork the file format.
        //
        // The line this draws is deliberately at a QUOTED CODE LITERAL of the
        // filename (`'supervisor.config.json'` / `"..."`), which is how one
        // would actually open the file by name, rather than at any mention of
        // the string. Prose that names the file -- a comment, or serve.mjs's
        // SERVE_USAGE help text documenting the config-file fallback -- is
        // legitimate and must stay possible; what must not exist is a second
        // place that turns the name into a path and hands it to fs. Callers
        // import SUPERVISOR_CONFIG_FILENAME (or better, the reader/writer)
        // from this module instead.
        const pkgRoot = path.join(import.meta.dirname, '..');
        const literal = new RegExp(`['"]${SUPERVISOR_CONFIG_FILENAME.replace(/\./g, '\\.')}['"]`);
        const hits = [];
        async function walk(dir) {
            let entries;
            try {
                entries = await fsp.readdir(dir, { withFileTypes: true });
            } catch { return; }
            for (const entry of entries) {
                if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { await walk(full); continue; }
                if (!/\.(mjs|js|ts)$/.test(entry.name)) continue;
                const text = await fsp.readFile(full, 'utf-8');
                if (literal.test(text)) hits.push(path.relative(pkgRoot, full).split(path.sep).join('/'));
            }
        }
        await walk(path.join(pkgRoot, 'src'));
        await walk(path.join(pkgRoot, 'bin'));
        await walk(path.join(pkgRoot, 'fleet-sprint'));

        assert.deepEqual(
            hits.sort(),
            ['src/supervisor/project-config.mjs'],
            'only project-config.mjs may name supervisor.config.json as a code literal; other files must import it',
        );
    });

    test('the module header records why this is a JSON file and not a row in supervisor.sqlite', async () => {
        const header = await fsp.readFile(
            path.join(import.meta.dirname, '..', 'src', 'supervisor', 'project-config.mjs'),
            'utf-8',
        );
        // The decision must be findable by the next reader who wonders whether
        // to merge this into the /api/projects store.
        assert.match(header, /supervisor\.sqlite/);
        assert.match(header, /node:sqlite/);
        assert.match(header, /22\.13\.0/);
        assert.match(header, /registerProjectsStoreUnavailableRoutes/);
        assert.match(header, /defaultDataDir\(\)/);
    });
});
