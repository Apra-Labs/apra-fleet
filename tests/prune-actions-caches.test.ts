import { describe, it, expect } from 'vitest';
import { decide, familyOf, summarize, isAlreadyGone, runDeletes } from '../scripts/ci/prune-actions-caches.mjs';

const NOW = Date.parse('2026-10-09T22:00:00Z');
const MB = 1024 * 1024;
const hoursAgo = (h: number) => new Date(NOW - h * 3600 * 1000).toISOString();
const hex = (n: number) => n.toString(16).padStart(64, 'a');

let nextId = 1;
const cache = (key: string, ref: string, sizeMb: number, accessedH: number, createdH = accessedH) => ({
  id: nextId++, key, ref, sizeInBytes: Math.round(sizeMb * MB), lastAccessedAt: hoursAgo(accessedH), createdAt: hoursAgo(createdH),
});
const codeql = (i: number) => `codeql-overlay-base-database-1-c801913f1ee29663-javascript-2.27.1-${hex(i).slice(0, 10)}-3788765${i}-1`;

// Modelled on the 2026-10-09 listing: 28 CodeQL overlays on main (~270 MB,
// one every few hours, each restored by the next run), setup-node npm caches
// across lockfile hashes, and current nm-v1/nm-v2 node_modules caches.
function fixture() {
  nextId = 1;
  const rows = [];
  for (let i = 0; i < 28; i++) rows.push(cache(codeql(i), 'refs/heads/main', 270, i * 6 + 1, i * 6 + 3));
  for (const os of ['Linux-x64', 'Windows-x64', 'macOS-arm64']) {
    rows.push(cache(`node-cache-${os}-npm-${hex(1)}`, 'refs/heads/main', 28, 2));
    rows.push(cache(`node-cache-${os}-npm-${hex(2)}`, 'refs/heads/main', 28, 10));
    rows.push(cache(`node-cache-${os}-npm-${hex(3)}`, 'refs/heads/main', 28, 50));   // older, within 3d
    rows.push(cache(`node-cache-${os}-npm-${hex(4)}`, 'refs/heads/main', 28, 100));  // older, idle 3d+
    rows.push(cache(`node-cache-${os}-npm-${hex(5)}`, 'refs/heads/main', 28, 200));  // older, idle 3d+
    rows.push(cache(`node-cache-${os}-npm-${hex(4)}`, 'refs/heads/feat/old', 28, 300)); // sole cache on its ref
  }
  rows.push(cache(`nm-v1-Linux-X64-ubuntu-latest-ubuntu24-nodev22.23.3-${hex(9)}`, 'refs/heads/chore/ci-node-modules-cache', 20, 5));
  rows.push(cache(`nm-v2-Linux-x64-ubuntu-latest-ubuntu24-nodev22.23.3-${hex(9)}`, 'refs/heads/chore/ci-nm-cache-followups', 20, 1));
  rows.push(cache(`nm-v2-Windows-x64-windows-2022-win22-nodev22.23.3-${hex(8)}`, 'refs/heads/main', 24, 30));
  rows.push(cache(`nm-v2-Windows-x64-windows-2022-win22-nodev22.23.3-${hex(7)}`, 'refs/heads/main', 24, 90));
  rows.push(cache(`nm-v2-Windows-x64-windows-2022-win22-nodev22.23.3-${hex(6)}`, 'refs/heads/main', 24, 120));
  return rows;
}

const byKeyRef = (ds: ReturnType<typeof decide>, key: string, ref: string) => ds.find((d) => d.key === key && d.ref === ref)!;

describe('familyOf', () => {
  it('strips the trailing content hash and groups all codeql overlays', () => {
    expect(familyOf(`node-cache-Linux-x64-npm-${hex(1)}`)).toBe('node-cache-Linux-x64-npm');
    expect(familyOf(`nm-v2-Windows-x64-windows-2022-win22-nodev22.23.3-${hex(1)}`)).toBe('nm-v2-Windows-x64-windows-2022-win22-nodev22.23.3');
    expect(familyOf(codeql(3))).toBe('codeql-overlay-base-database');
    expect(familyOf('plain-key')).toBe('plain-key');
  });
});

describe('decide', () => {
  it('codeql overlays: keeps newest per ref plus anything accessed in 24h, deletes the rest', () => {
    const ds = decide(fixture(), NOW).filter((d) => d.family === 'codeql-overlay-base-database');
    const kept = ds.filter((d) => d.action === 'KEEP');
    // i=0..3 accessed at 1,7,13,19h -> 24h guard; i=0 is also the newest.
    expect(kept.map((d) => d.key)).toEqual([0, 1, 2, 3].map(codeql));
    expect(ds.filter((d) => d.action === 'DELETE')).toHaveLength(24);
  });

  it('codeql: newest per ref is tracked independently per ref', () => {
    const rows = [
      cache(codeql(1), 'refs/heads/main', 100, 40, 40),
      cache(codeql(2), 'refs/heads/main', 100, 80, 80),
      cache(codeql(3), 'refs/heads/release', 100, 90, 90),
    ];
    const ds = decide(rows, NOW);
    expect(ds.map((d) => d.action)).toEqual(['KEEP', 'DELETE', 'KEEP']);
    expect(ds[1].reason).toMatch(/superseded/);
  });

  it('24h guard beats both the codeql rule and the >200 MB rule', () => {
    const rows = [
      cache(codeql(1), 'refs/heads/main', 300, 1, 1),
      cache(codeql(2), 'refs/heads/main', 300, 5, 30), // superseded but accessed 5h ago
      cache('huge-thing', 'refs/heads/main', 900, 23),
    ];
    expect(decide(rows, NOW).map((d) => [d.action, d.rule])).toEqual([
      ['KEEP', 'recent-access'], ['KEEP', 'recent-access'], ['KEEP', 'recent-access'],
    ]);
  });

  it('>200 MB idle 3d is deleted even when it is the newest (or only) in its family', () => {
    const rows = [cache(`big-${hex(1)}`, 'refs/heads/main', 250, 73)];
    expect(decide(rows, NOW).map((d) => [d.action, d.rule])).toEqual([['DELETE', 'large-stale']]);
    // idle under 3d is not "large-stale"
    expect(decide([cache(`big-${hex(1)}`, 'refs/heads/main', 250, 71)], NOW)[0].action).toBe('KEEP');
  });

  it('a quiet ref keeps its only (newest) codeql overlay even when >200 MB and idle 3d', () => {
    const rows = [cache(codeql(1), 'refs/heads/main', 270, 80, 80), cache(codeql(2), 'refs/heads/main', 270, 100, 100)];
    expect(decide(rows, NOW).map((d) => [d.action, d.rule])).toEqual([['KEEP', 'codeql-overlay'], ['DELETE', 'codeql-overlay']]);
    expect(decide([cache(codeql(3), 'refs/heads/main', 270, 500, 500)], NOW)[0].action).toBe('KEEP');
  });

  it('families: keep newest 2 per (family, ref), keep older ones accessed in 3d, delete older idle ones', () => {
    const ds = decide(fixture(), NOW);
    for (const os of ['Linux-x64', 'Windows-x64', 'macOS-arm64']) {
      const a = (n: number, ref = 'refs/heads/main') => byKeyRef(ds, `node-cache-${os}-npm-${hex(n)}`, ref).action;
      expect([a(1), a(2), a(3), a(4), a(5)]).toEqual(['KEEP', 'KEEP', 'KEEP', 'DELETE', 'DELETE']);
      // Same key on another ref is its own group: sole cache there, kept.
      expect(a(4, 'refs/heads/feat/old')).toBe('KEEP');
    }
    const nm = (n: number) => byKeyRef(ds, `nm-v2-Windows-x64-windows-2022-win22-nodev22.23.3-${hex(n)}`, 'refs/heads/main');
    expect([nm(8).action, nm(7).action, nm(6).action]).toEqual(['KEEP', 'KEEP', 'DELETE']);
  });

  it('preserves current nm-v1 / nm-v2 caches', () => {
    const ds = decide(fixture(), NOW).filter((d) => d.key.startsWith('nm-v') && !d.key.includes(hex(6)));
    expect(ds.every((d) => d.action === 'KEEP')).toBe(true);
  });

  it('summarize totals the freed bytes', () => {
    const s = summarize(decide(fixture(), NOW));
    expect(s.total).toBe(28 + 18 + 5);
    expect(s.deleteCount).toBe(24 + 6 + 1);
    expect(s.deleteBytes).toBe(24 * Math.round(270 * MB) + 6 * Math.round(28 * MB) + Math.round(24 * MB));
  });
});

describe('delete path', () => {
  const ghError = (stderr: string) => Object.assign(new Error('Command failed: gh cache delete 8749404123 --repo o/r'), { stderr, stdout: '' });
  const GH_GONE = 'X Could not find a cache matching 8749404123 in o/r\n';

  it('classifies the real gh "could not find" message (and 404s) as already gone', () => {
    expect(isAlreadyGone(GH_GONE)).toBe(true);
    expect(isAlreadyGone('HTTP 404: Not Found (https://api.github.com/repos/o/r/actions/caches/1)')).toBe(true);
    expect(isAlreadyGone('HTTP 403: Resource not accessible by integration')).toBe(false);
    // a cache id containing 404 is not a 404
    expect(isAlreadyGone('HTTP 500: server error for cache 8749404123')).toBe(false);
  });

  it('counts deletes, treats already-gone as success, fails only on real errors', () => {
    const rows = [1, 2, 3, 4].map((i) => cache(codeql(i), 'refs/heads/main', 270, 100 + i, 100 + i));
    const ds = decide(rows, NOW); // newest kept, 3 superseded deleted
    const ids = ds.filter((d) => d.action === 'DELETE').map((d) => d.id);
    expect(ids).toHaveLength(3);
    const ok = runDeletes(ds, (id: number) => { if (id === ids[1]) throw ghError(GH_GONE); });
    expect(ok).toEqual({ deleted: 2, gone: 1, failures: [], exitCode: 0 });

    const bad = runDeletes(ds, (id: number) => { if (id === ids[2]) throw ghError('HTTP 403: Resource not accessible by integration'); });
    expect(bad.deleted).toBe(2);
    expect(bad.failures.map((f: { id: number }) => f.id)).toEqual([ids[2]]);
    expect(bad.exitCode).toBe(1);
  });

  it('never calls delete for KEEP decisions', () => {
    const calls: number[] = [];
    runDeletes(decide(fixture(), NOW), (id: number) => { calls.push(id); });
    expect(calls).toHaveLength(24 + 6 + 1);
  });
});
