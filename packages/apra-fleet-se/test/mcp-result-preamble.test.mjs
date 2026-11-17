import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { resultText, toolErrorText } from '../fleet-sprint/mcp-result.mjs';

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
    text: '<apra-fleet-display>\nWELCOME BANNER\n</apra-fleet-display>',
    annotations: { audience: ['user'], priority: 1 },
};

const realResult = {
    type: 'text',
    text: 'REAL TOOL OUTPUT',
};

const nudge = {
    type: 'text',
    text: '<apra-fleet-display>\nWELCOME BANNER\n</apra-fleet-display>',
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

    test('8. [banner, nudge] (all-banner, preamble + trailing nudge) returns the empty string', () => {
        assert.strictEqual(resultText({ content: [banner, nudge] }), '');
    });
});

// =============================================================================
// apra-fleet-3swo.63 -- toolErrorText vs. the onboarding banner. Mirrors the
// resultText suite above: toolErrorText() used to read res.content[0]
// unconditionally, so a first-run/welcome-back dispatch's onboarding banner
// (content[0]) would be logged as if it were the tool's error text instead of
// the real error at content[1]. Fixed to skip display banners the same way
// resultText() does, keeping its own 'no error text returned' fallback for
// the empty/all-banner case (distinct from resultText()'s '' fallback).
// =============================================================================
describe('toolErrorText vs. the onboarding banner (apra-fleet-3swo.63)', () => {
    test('1. [banner, realResult] returns the real error text, skipping the banner', () => {
        assert.equal(toolErrorText({ content: [banner, realResult] }), 'REAL TOOL OUTPUT');
    });

    test('2. [banner, realResult, nudge] returns the real error text, skipping both banners', () => {
        assert.equal(toolErrorText({ content: [banner, realResult, nudge] }), 'REAL TOOL OUTPUT');
    });

    test('3. [realResult, nudge] (no-banner steady state) returns the real error text', () => {
        assert.equal(toolErrorText({ content: [realResult, nudge] }), 'REAL TOOL OUTPUT');
    });

    test('4. [banner] alone (all-banner) falls back to the no-error-text sentinel, not the banner text', () => {
        assert.strictEqual(toolErrorText({ content: [banner] }), 'no error text returned');
    });

    test('5. empty/missing/null/undefined content all fall back to the no-error-text sentinel', () => {
        assert.strictEqual(toolErrorText({ content: [] }), 'no error text returned');
        assert.strictEqual(toolErrorText({}), 'no error text returned');
        assert.strictEqual(toolErrorText(null), 'no error text returned');
        assert.strictEqual(toolErrorText(undefined), 'no error text returned');
    });

    test('6. a contentless isError envelope ({isError:true}, no content array) does not throw', () => {
        // apra-fleet-eft/kb.mjs: a degenerate MCP error result of exactly
        // {isError:true} must still produce a usable log line, not throw.
        assert.strictEqual(toolErrorText({ isError: true }), 'no error text returned');
    });

    test('7. an entry whose text is the empty string is skipped, keeping the no-error-text sentinel (apra-fleet-3swo.70)', () => {
        // apra-fleet-3swo.63's rework read `typeof first.text === 'string'`
        // without also requiring it to be non-empty, so {content:[{text:''}]}
        // returned '' instead of the sentinel -- a regression from the
        // pre-3swo.63 `(first && ... && first.text) || 'no error text
        // returned'` fallback, which kb.mjs's four log call sites rely on for
        // a non-blank log line.
        assert.strictEqual(toolErrorText({ content: [{ type: 'text', text: '' }] }), 'no error text returned');
    });

    test('7a. an audience:[\'user\'] entry is skipped even with no apra-fleet-display tag in its text', () => {
        const audienceOnlyBanner = {
            type: 'text',
            text: 'no display tag here',
            annotations: { audience: ['user'] },
        };
        assert.strictEqual(toolErrorText({ content: [audienceOnlyBanner, realResult] }), 'REAL TOOL OUTPUT');
    });

    test('7b. an <apra-fleet-display> tagged entry is skipped even with no annotations', () => {
        const taggedOnlyBanner = {
            type: 'text',
            text: '<apra-fleet-display>\nno annotations here\n</apra-fleet-display>',
        };
        assert.strictEqual(toolErrorText({ content: [taggedOnlyBanner, realResult] }), 'REAL TOOL OUTPUT');
    });

    test('8. [banner, nudge] (all-banner, preamble + trailing nudge) falls back to the no-error-text sentinel', () => {
        assert.strictEqual(toolErrorText({ content: [banner, nudge] }), 'no error text returned');
    });
});
