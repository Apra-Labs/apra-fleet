import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../src/cli/fleet-se-guard.js', () => ({ detectRunningFleetSe: vi.fn() }));
import { detectRunningFleetSe } from '../src/cli/fleet-se-guard.js';
import { runFleetSeCheck } from '../src/cli/fleet-se-check.js';

function capture(): string[] {
  const out: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.join(' ')); });
  return out;
}
afterEach(() => vi.restoreAllMocks());

describe('fleet-se-check (read-only, the guard detection, tagged output)', () => {
  it('prints the supervisor, sprints and warnings', async () => {
    vi.mocked(detectRunningFleetSe).mockResolvedValue({ supervisor: { pid: 5, port: 8788 }, sprints: [{ pid: 9, sprintId: 's1' }, { pid: 10 }], warnings: ['w'] });
    const out = capture();
    await runFleetSeCheck();
    expect(out).toEqual(['FLEET_SE_CHECK ok', 'FLEET_SE supervisor pid=5 port=8788', 'FLEET_SE sprint pid=9 id=s1', 'FLEET_SE sprint pid=10', 'FLEET_SE warning w']);
  });
  it('tags an unverified sprint (unreadable command line) so replace-full refuses on it', async () => {
    vi.mocked(detectRunningFleetSe).mockResolvedValueOnce({ supervisor: null, sprints: [{ pid: 7680, lockFile: 'l', unverified: true }] });
    const out = capture();
    await runFleetSeCheck();
    expect(out).toEqual(['FLEET_SE_CHECK ok', 'FLEET_SE sprint pid=7680 unverified']);
  });
  it('prints only the ok tag when nothing runs, and an error tag when detection throws', async () => {
    vi.mocked(detectRunningFleetSe).mockResolvedValueOnce({ supervisor: null, sprints: [] });
    let out = capture();
    await runFleetSeCheck();
    expect(out).toEqual(['FLEET_SE_CHECK ok']);
    vi.restoreAllMocks();
    vi.mocked(detectRunningFleetSe).mockRejectedValueOnce(new Error('boom'));
    out = capture();
    await runFleetSeCheck();
    expect(out).toEqual(['FLEET_SE_CHECK error boom']);
  });
});
