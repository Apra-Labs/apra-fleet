import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    evaluateClockSkew,
    parseEpochMillis,
    clockSkewThresholdMs,
    CLOCK_SKEW_PROBE_POSIX,
    CLOCK_SKEW_PROBE_WINDOWS,
} from '../fleet-sprint/runner.js';

// =============================================================================
// apra-fleet-lgz0.1.1: exercises the pure helpers backing the upcoming Clock
// Skew Check phase at Sprint Setup (wiring lands in apra-fleet-lgz0.1.2).
// These are advisory-only, so the overriding property under test throughout
// is "never throws, degrades to an unparsable/false result instead."
// =============================================================================

test('probe constants are the expected cross-shell commands', () => {
    assert.equal(CLOCK_SKEW_PROBE_POSIX, 'date +%s%3N');
    assert.equal(CLOCK_SKEW_PROBE_WINDOWS, '[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()');
});

test('parseEpochMillis extracts a clean digit-only reading', () => {
    assert.equal(parseEpochMillis('1699999999123\n'), 1699999999123);
    assert.equal(parseEpochMillis('  1699999999123  '), 1699999999123);
});

test('parseEpochMillis returns null (never NaN, never throws) on unparsable output', () => {
    assert.equal(parseEpochMillis('date: illegal option -- 3'), null);
    assert.equal(parseEpochMillis('1699999999%3N'), null);
    assert.equal(parseEpochMillis(''), null);
    assert.equal(parseEpochMillis(undefined), null);
    assert.equal(parseEpochMillis(null), null);
    assert.equal(parseEpochMillis(123), null);
});

test('clockSkewThresholdMs mirrors stall-detector parseInt-with-fallback, divided by 4', () => {
    assert.equal(clockSkewThresholdMs({ STALL_THRESHOLD_MS: '120000' }), 30000);
    assert.equal(clockSkewThresholdMs({}), 30000);
    assert.equal(clockSkewThresholdMs(undefined), 30000);
    assert.equal(clockSkewThresholdMs({ STALL_THRESHOLD_MS: 'not-a-number' }), 30000);
    assert.equal(clockSkewThresholdMs({ STALL_THRESHOLD_MS: '80000' }), 20000);
});

test('evaluateClockSkew: member epoch inside [hubT0, hubT1] window is zero skew', () => {
    const result = evaluateClockSkew({ hubT0: 1000, hubT1: 1200, memberEpochMs: 1100, thresholdMs: 30000 });
    assert.deepEqual(result, { ok: true, skewMs: 0, exceeded: false, reason: null });
});

test('evaluateClockSkew: member ahead of hubT1 yields positive skew', () => {
    const result = evaluateClockSkew({ hubT0: 1000, hubT1: 1200, memberEpochMs: 1200 + 50000, thresholdMs: 30000 });
    assert.equal(result.ok, true);
    assert.equal(result.skewMs, 50000);
    assert.equal(result.exceeded, true);
});

test('evaluateClockSkew: member behind hubT0 yields negative skew', () => {
    const result = evaluateClockSkew({ hubT0: 1000, hubT1: 1200, memberEpochMs: 1000 - 50000, thresholdMs: 30000 });
    assert.equal(result.ok, true);
    assert.equal(result.skewMs, -50000);
    assert.equal(result.exceeded, true);
});

test('evaluateClockSkew: negative skew within threshold is not exceeded', () => {
    const result = evaluateClockSkew({ hubT0: 1000, hubT1: 1200, memberEpochMs: 1000 - 500, thresholdMs: 30000 });
    assert.equal(result.exceeded, false);
});

test('evaluateClockSkew: non-finite/NaN/null memberEpochMs is unparsable, never throws', () => {
    for (const bad of [NaN, Infinity, -Infinity, null, undefined, 'not-a-number']) {
        const result = evaluateClockSkew({ hubT0: 1000, hubT1: 1200, memberEpochMs: bad, thresholdMs: 30000 });
        assert.deepEqual(result, { ok: false, skewMs: null, exceeded: false, reason: 'unparsable' });
    }
});
