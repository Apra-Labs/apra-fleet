import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import { Writable } from 'node:stream';

// The LogScope invocation id names the durable output file a Linux member tees
// into under the shared /tmp (durableOutputPath), so it must come from a CSPRNG,
// not Math.random. Pin Math.random to a constant: a Math.random-derived id would
// then repeat across scopes.
describe('LogScope invocation id', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(fs, 'createWriteStream').mockImplementation(() => new Writable({
      write(_chunk, _enc, cb) { cb(); },
    }) as unknown as fs.WriteStream);
    vi.spyOn(Math, 'random').mockReturnValue(0.123456789);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is 5 lowercase base36 chars and does not depend on Math.random', async () => {
    const { LogScope } = await import('../../src/utils/log-helpers.js');
    const ids = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const inv = new LogScope('test', 'entry').getInv();
      expect(inv).toMatch(/^[a-z0-9]{5}$/);
      ids.add(inv);
    }
    expect(ids.size).toBeGreaterThan(1);
  });
});
