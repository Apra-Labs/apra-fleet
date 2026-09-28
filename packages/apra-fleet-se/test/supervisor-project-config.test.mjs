import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
    SUPERVISOR_CONFIG_FILENAME,
    supervisorConfigPath,
    readSupervisorConfig,
    writeSupervisorConfig,
} from '../src/supervisor/project-config.mjs';
import { defaultDataDir } from '../src/supervisor/ledger.mjs';

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

async function mkTmp(prefix = 'apra-fleet-project-config-') {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
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
