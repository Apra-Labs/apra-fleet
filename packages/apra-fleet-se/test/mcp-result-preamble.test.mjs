import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resultText } from '../fleet-sprint/mcp-result.mjs';

// =============================================================================
// apra-fleet-3swo.61 -- resultText vs. the onboarding banner.
//
// content[0] is NOT reliably the tool result: src/services/tool-registry.ts's
// wrapTool() may prepend a user-audience onboarding/welcome-back display
// banner ahead of the real result, and append a nudge suffix banner after it.
// Quoting the actual push sites read from tool-registry.ts this pass, so a
// future divergence in their shape is traceable here:
//
//   content.push({ type: 'text' as const, text: `<apra-fleet-display>\n${preamble}\n</apra-fleet-display>`, annotations: { audience: ['user'], priority: 1 } });
//   content.push({ type: 'text' as const, text: sanitizeToolResult(result) });
//   content.push({ type: 'text' as const, text: `<apra-fleet-display>\n${suffix}\n</apra-fleet-display>`, annotations: { audience: ['user'], priority: 0.8 } });
//
// This is a pure unit test: mcp-result.mjs has no imports of its own, and the
// hand-built fixtures below match the shape above without dragging the
// TypeScript server graph (tool-registry.ts) into this fleet-sprint unit
// test.
// =============================================================================

const banner = {
    type: 'text',
    text: '\nWELCOME BANNER\n',
    annotations: { audience: ['user'], priority: 1 },
};

const realResult = {
    type: 'text',
    text: 'REAL TOOL OUTPUT',
};

const nudge = {
    type: 'text',
    text: '\nWELCOME BANNER\n',
    annotations: { audience: ['user'], priority: 0.8 },
};

describe('resultText vs. the onboarding banner (apra-fleet-3swo.61)', () => {
    test('1. [banner, realResult] returns the real result, skipping the banner', () => {
        assert.equal(resultText({ content: [banner, realResult] }), 'REAL TOOL OUTPUT');
    });

    test('2. [banner, realResult, nudge] returns the real result, skipping both banners', () => {
        assert.equal(resultText({ content: [banner, realResult, nudge] }), 'REAL TOOL OUTPUT');
    });

    test('3. [realResult, nudge] (no-banner steady state) returns the real result', () => {
        assert.equal(resultText({ content: [realResult, nudge] }), 'REAL TOOL OUTPUT');
    });

    test('4. [banner] alone returns the empty string, not undefined, without throwing', () => {
        const value = resultText({ content: [banner] });
        assert.strictEqual(value, '');
    });

    test('5. empty/missing/null/undefined content all return the empty string', () => {
        assert.strictEqual(resultText({ content: [] }), '');
        assert.strictEqual(resultText({}), '');
        assert.strictEqual(resultText(null), '');
        assert.strictEqual(resultText(undefined), '');
    });

    test('6. a raw string result is returned as-is', () => {
        assert.strictEqual(resultText('plain'), 'plain');
    });

    test('7a. an audience:[\'user\'] entry is skipped even with no apra-fleet-display tag in its text', () => {
        const audienceOnlyBanner = {
            type: 'text',
            text: 'no display tag here',
            annotations: { audience: ['user'] },
        };
        assert.strictEqual(resultText({ content: [audienceOnlyBanner, realResult] }), 'REAL TOOL OUTPUT');
    });

    test('7b. an <apra-fleet-display> tagged entry is skipped even with no annotations', () => {
        const taggedOnlyBanner = {
            type: 'text',
            text: '<apra-fleet-display>\nno annotations here\n</apra-fleet-display>',
        };
        assert.strictEqual(resultText({ content: [taggedOnlyBanner, realResult] }), 'REAL TOOL OUTPUT');
    });
});
