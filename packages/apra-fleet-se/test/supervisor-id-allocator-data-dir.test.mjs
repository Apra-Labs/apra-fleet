import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createIdAllocator, defaultDataDir, ID_ALLOCATOR_FILENAME } from '../src/supervisor/id-allocator.mjs';

// Two supervisors on one host, each with its own FLEET_SE_DATA_DIR, must not
// share (and so regress) one child-id-allocator.json. Allocators are built
// exactly as bin/serve.mjs builds them: createIdAllocator({ dataDir:
// defaultDataDir() }), resolving the dir from the env var. HOME is pointed at a
// temp dir so the legacy ~/.apra-fleet/supervisor file can be asserted untouched.

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

test('separate FLEET_SE_DATA_DIRs: ids unique, high-water marks monotonic across restarts, legacy HOME file untouched', async () => {
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
