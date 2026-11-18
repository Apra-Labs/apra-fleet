/**
 * An interrupted registry write must leave the previous registry.json intact:
 * saves go to an owner-only temp file in the same dir and are renamed over it.
 * Runs in the per-run sandbox data dir (scripts/test-sandbox.mjs).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { addAgent, getAllAgents, updateAgent } from '../src/services/registry.js';
import { makeTestAgent, REGISTRY_PATH, backupAndResetRegistry, restoreRegistry } from './test-helpers.js';

const dir = () => path.dirname(REGISTRY_PATH);
const leftovers = () => fs.readdirSync(dir()).filter(f => f.endsWith('.tmp'));
let a: ReturnType<typeof makeTestAgent>;
let seed: Buffer;

beforeEach(() => {
  backupAndResetRegistry();
  a = makeTestAgent({ friendlyName: 'one' });
  addAgent(a);
  addAgent(makeTestAgent({ friendlyName: 'two' }));
  seed = fs.readFileSync(REGISTRY_PATH);
});
afterEach(() => {
  vi.restoreAllMocks();
  restoreRegistry();
});

describe('registry atomic write', () => {
  it('a partial write that then throws leaves registry.json byte-identical, members intact, no temp file', () => {
    const real = fs.writeFileSync;
    vi.spyOn(fs, 'writeFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, data: unknown, opts?: unknown) => {
      real(p, String(data).slice(0, 10), opts as fs.WriteFileOptions);
      throw new Error('disk full');
    }) as typeof fs.writeFileSync);
    expect(() => updateAgent(a.id, { friendlyName: 'renamed' })).toThrow();
    vi.restoreAllMocks();
    expect(fs.readFileSync(REGISTRY_PATH).equals(seed)).toBe(true);
    expect(getAllAgents().map(x => x.friendlyName).sort()).toEqual(['one', 'two']);
    expect(leftovers()).toEqual([]);
  });

  it('a rename that keeps failing throws, leaves registry.json intact and no temp file', () => {
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('EBUSY'); });
    expect(() => updateAgent(a.id, { friendlyName: 'renamed' })).toThrow(/could not replace .*registry\.json/);
    expect(spy.mock.calls.length).toBeGreaterThan(1); // retried
    vi.restoreAllMocks();
    expect(fs.readFileSync(REGISTRY_PATH).equals(seed)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it('a normal save writes a temp file in the same dir and renames it over registry.json', () => {
    const write = vi.spyOn(fs, 'writeFileSync');
    const rename = vi.spyOn(fs, 'renameSync');
    updateAgent(a.id, { friendlyName: 'renamed' });
    const tmpWrite = write.mock.calls.map(c => String(c[0])).find(p => p.endsWith('.tmp'));
    expect(tmpWrite).toBeDefined();
    // The writer realpaths the target (macOS: /var -> /private/var).
    expect(path.dirname(tmpWrite!)).toBe(fs.realpathSync(dir()));
    expect(write.mock.calls.some(c => String(c[0]) === REGISTRY_PATH)).toBe(false);
    expect(rename.mock.calls.some(c => String(c[0]) === tmpWrite && String(c[1]).endsWith('registry.json'))).toBe(true);
    vi.restoreAllMocks();
    expect(getAllAgents().map(x => x.friendlyName).sort()).toEqual(['renamed', 'two']);
    expect(leftovers()).toEqual([]);
    if (process.platform !== 'win32') expect(fs.statSync(REGISTRY_PATH).mode & 0o777).toBe(0o600);
  });
});
