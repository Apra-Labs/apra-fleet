import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createIdAllocator, defaultDataDir, ID_ALLOCATOR_FILENAME } from '../src/supervisor/id-allocator.mjs';

// Two supervisors on one host, each with its own FLEET_SE_DATA_DIR, must not
// share (and so regress) one child-id-allocator.json. Allocators are built
// exactly as bin/serve.mjs builds them: createIdAllocator({ dataDir:
// defaultDataDir() }), resolving the dir from the env var. HOME is pointed at a
// temp dir so the real legacy ~/.apra-fleet/supervisor file is never touched.

const exists = (p) => access(p).then(() => true, () => false);

async function withEnv(vars, fn) {
    const saved = {};
    for (const k of Object.keys(vars)) saved[k] = process.env[k];
    Object.assign(process.env, vars);
    try { return await fn(); } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
}

// Built per-supervisor under that supervisor's own env, like serve.mjs.
const buildAllocator = (dataDirEnv) => withEnv({ FLEET_SE_DATA_DIR: dataDirEnv }, async () => {
    const a = createIdAllocator({ dataDir: defaultDataDir(), leaseMs: 100_000 });
    await a.start();
    return a;
});

test('separate FLEET_SE_DATA_DIRs: ids unique, high-water marks monotonic across restarts, no legacy file created when none exists', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'id-alloc-datadir-'));
    const home = path.join(root, 'home');
    const dirA = path.join(root, 'a');
    const dirB = path.join(root, 'b');
    try {
        await withEnv({ HOME: home, USERPROFILE: home }, async () => {
            const P1 = 'proj-one.7';
            const P2 = 'proj-two.9';
            const issued = { [P1]: [], [P2]: [] };
            const grab = async (alloc, parent, n) => {
                for (let i = 0; i < n; i++) {
                    const g = await alloc.allocate(parent, { pid: process.pid });
                    await alloc.confirm(g.token);
                    issued[parent].push(Number(g.childId.slice(parent.length + 1)));
                }
            };

            let a = await buildAllocator(dirA);
            let b = await buildAllocator(dirB);
            await grab(a, P1, 3);
            await grab(b, P2, 4);
            await a.stop();
            a = await buildAllocator(dirA);
            await grab(a, P1, 2);
            await grab(b, P2, 1);
            await b.stop();
            b = await buildAllocator(dirB);
            await grab(b, P2, 2);
            await grab(a, P1, 1);
            await a.stop();
            await b.stop();

            for (const parent of [P1, P2]) {
                const seqs = issued[parent];
                assert.equal(new Set(seqs).size, seqs.length, `${parent} ids unique: ${seqs}`);
                assert.deepEqual(seqs, [...seqs].sort((x, y) => x - y), `${parent} monotonic: ${seqs}`);
            }
            assert.equal(issued[P1].length, 6);
            assert.equal(issued[P2].length, 7);

            const fileA = await readFile(path.join(dirA, ID_ALLOCATOR_FILENAME), 'utf-8');
            const fileB = await readFile(path.join(dirB, ID_ALLOCATOR_FILENAME), 'utf-8');
            assert.ok(fileA.includes(P1) && !fileA.includes(P2), 'dir A holds only project one');
            assert.ok(fileB.includes(P2) && !fileB.includes(P1), 'dir B holds only project two');
            assert.deepEqual((await readdir(dirA)).filter((f) => f.endsWith('.json')), [ID_ALLOCATOR_FILENAME]);

            // Legacy shared file never created; HOME has no .apra-fleet at all.
            assert.equal(await exists(path.join(home, '.apra-fleet', 'supervisor', ID_ALLOCATOR_FILENAME)), false);
            assert.equal(await exists(path.join(home, '.apra-fleet')), false);
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('defaultDataDir: FLEET_SE_DATA_DIR wins; unset keeps the legacy ~/.apra-fleet/supervisor path', async () => {
    await withEnv({ HOME: '/tmp/h-ugw3', USERPROFILE: '/tmp/h-ugw3', FLEET_SE_DATA_DIR: '/tmp/x-ugw3' }, () => {
        assert.equal(defaultDataDir(), path.resolve('/tmp/x-ugw3'));
    });
    const saved = process.env.FLEET_SE_DATA_DIR;
    delete process.env.FLEET_SE_DATA_DIR;
    try {
        await withEnv({ HOME: '/tmp/h-ugw3', USERPROFILE: '/tmp/h-ugw3' }, () => {
            assert.equal(defaultDataDir(), path.join('/tmp/h-ugw3', '.apra-fleet', 'supervisor'));
        });
    } finally { if (saved !== undefined) process.env.FLEET_SE_DATA_DIR = saved; }
});

test('upgrade: legacy file seeds the new FLEET_SE_DATA_DIR allocator once; legacy bytes untouched', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'id-alloc-upgrade-'));
    const legacyFile = path.join(root, 'legacy', ID_ALLOCATOR_FILENAME);
    const dataDir = path.join(root, 'new');
    try {
        await mkdir(path.dirname(legacyFile), { recursive: true });
        const P = 'proj.5';
        const legacyDoc = { version: 1, parents: { [P]: { highWater: 7, free: [], reserved: {} } } };
        const legacyBytes = `${JSON.stringify(legacyDoc, null, 2)}\n`;
        await writeFile(legacyFile, legacyBytes);

        const build = () => createIdAllocator({ dataDir, legacyFilePath: legacyFile, leaseMs: 100_000, logger: { log() {}, error() {} } });
        let a = build();
        await a.start();
        const g = await a.allocate(P, { pid: process.pid });
        assert.equal(g.childId, `${P}.8`);
        await a.confirm(g.token);
        await a.stop();
        assert.equal(await exists(path.join(dataDir, ID_ALLOCATOR_FILENAME)), true);

        // Mutate legacy: must be ignored on restart (seeded once).
        const mutated = { version: 1, parents: { [P]: { highWater: 99, free: [], reserved: {} } } };
        await writeFile(legacyFile, JSON.stringify(mutated));
        a = build();
        await a.start();
        const g2 = await a.allocate(P, { pid: process.pid });
        assert.equal(g2.childId, `${P}.9`);
        await a.stop();

        // Unmutated-legacy byte check on a fresh upgrade.
        await writeFile(legacyFile, legacyBytes);
        const b = createIdAllocator({ dataDir: path.join(root, 'new2'), legacyFilePath: legacyFile, logger: { log() {}, error() {} } });
        await b.start();
        await b.stop();
        assert.equal(await readFile(legacyFile, 'utf-8'), legacyBytes);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test('upgrade: missing or corrupt legacy file starts empty and logs the reason', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'id-alloc-upgrade-bad-'));
    try {
        const corrupt = path.join(root, 'corrupt.json');
        await writeFile(corrupt, '{not json');
        for (const legacyFilePath of [path.join(root, 'missing.json'), corrupt]) {
            const logs = [];
            const a = createIdAllocator({ dataDir: path.join(root, path.basename(legacyFilePath, '.json')), legacyFilePath, logger: { log: (m) => logs.push(m) } });
            await a.start();
            assert.equal((await a.allocate('p.1', { pid: process.pid })).childId, 'p.1.1');
            await a.stop();
            assert.ok(logs.some((m) => m.includes('starting empty')), logs.join('|'));
        }
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
