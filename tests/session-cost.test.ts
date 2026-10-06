// Per-dispatch cost from the Claude CLI's CUMULATIVE total_cost_usd.
// The CLI documents (2.1.291, result field docs) that "a resumed or forked
// session continues from the total its transcript saved ... (so the first
// result already carries the earlier turns)", and that a /clear resets it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  dispatchCostFromCumulative, lastSessionCost, recordSessionCost, _resetSessionCostCache, _setSessionCostFileForTest,
} from '../src/services/session-cost.js';

// A private file per test: the run's data dir is shared by every vitest
// worker, and other workers' Claude dispatches write session-costs.json there.
let dir: string;
let FILE: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-session-cost-'));
  FILE = path.join(dir, 'nested', 'session-costs.json');
  _setSessionCostFileForTest(FILE);
});

afterEach(() => {
  _setSessionCostFileForTest(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('dispatchCostFromCumulative', () => {
  it('a fresh session is charged its whole figure, and becomes the baseline', () => {
    expect(dispatchCostFromCumulative(0.1380048, 's1', undefined)).toBe(0.1380048);
    expect(lastSessionCost('s1')).toBe(0.1380048);
  });

  it('a resume is charged only the delta over the session\'s last figure', () => {
    dispatchCostFromCumulative(0.1380048, 's1', undefined);
    expect(dispatchCostFromCumulative(0.5, 's1', 's1')).toBeCloseTo(0.5 - 0.1380048, 10);
    expect(dispatchCostFromCumulative(0.75, 's1', 's1')).toBeCloseTo(0.25, 10);
  });

  it('a fork is charged the delta over its SOURCE session, and starts its own baseline', () => {
    dispatchCostFromCumulative(1, 'src', undefined);
    expect(dispatchCostFromCumulative(1.3, 'fork', 'src')).toBeCloseTo(0.3, 10);
    expect(lastSessionCost('fork')).toBe(1.3);
    expect(lastSessionCost('src')).toBe(1);
  });

  it('a figure below the baseline (total restarted: /clear, no saved total) is charged in full', () => {
    dispatchCostFromCumulative(2, 's1', undefined);
    expect(dispatchCostFromCumulative(0.4, 's1', 's1')).toBe(0.4);
  });

  it('continuing a session never seen gives undefined (caller prices the tokens) but records the baseline', () => {
    expect(dispatchCostFromCumulative(3, 'old', 'old')).toBeUndefined();
    expect(lastSessionCost('old')).toBe(3);
    expect(dispatchCostFromCumulative(3.5, 'old', 'old')).toBeCloseTo(0.5, 10);
  });

  it('the baseline survives a server restart (persisted under the data dir)', () => {
    recordSessionCost('s-persist', 0.9);
    _resetSessionCostCache();
    expect(lastSessionCost('s-persist')).toBe(0.9);
    expect(JSON.parse(fs.readFileSync(FILE, 'utf-8'))['s-persist']).toBe(0.9);
  });

  it('keeps only the most recent sessions', () => {
    for (let i = 0; i < 520; i++) recordSessionCost(`s${i}`, i);
    _resetSessionCostCache();
    expect(lastSessionCost('s0')).toBeUndefined();
    expect(lastSessionCost('s519')).toBe(519);
  });
});
