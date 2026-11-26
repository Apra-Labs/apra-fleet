import { test, describe } from 'node:test';
import assert from 'node:assert';
import { shouldSuppressToggle } from '../src/viewer/header-selection.mjs';
import { HTML_TEMPLATE } from '../src/viewer/index.mjs';

// Decision logic for the viewer's <summary> header click handler: a drag-select
// that ends inside a header must not toggle its <details>.

const inside = { id: 'text-in-header' };
const outside = { id: 'text-elsewhere' };
const header = { contains: (n) => n === inside };

describe('shouldSuppressToggle', () => {
    test('non-collapsed selection inside the header -> toggle suppressed', () => {
        assert.equal(shouldSuppressToggle({ isCollapsed: false, rangeCount: 1, anchorNode: inside, focusNode: inside, keyboard: false }, header), true);
        assert.equal(shouldSuppressToggle({ isCollapsed: false, rangeCount: 1, anchorNode: outside, focusNode: inside, keyboard: false }, header), true);
    });
    test('collapsed selection (plain click) -> toggle proceeds', () => {
        assert.equal(shouldSuppressToggle({ isCollapsed: true, rangeCount: 1, anchorNode: inside, focusNode: inside, keyboard: false }, header), false);
        assert.equal(shouldSuppressToggle({ isCollapsed: false, rangeCount: 0, anchorNode: null, focusNode: null, keyboard: false }, header), false);
    });
    test('selection outside the header -> toggle proceeds', () => {
        assert.equal(shouldSuppressToggle({ isCollapsed: false, rangeCount: 1, anchorNode: outside, focusNode: outside, keyboard: false }, header), false);
    });
    test('keyboard Enter/Space is never suppressed, even with a selection in the header', () => {
        assert.equal(shouldSuppressToggle({ isCollapsed: false, rangeCount: 1, anchorNode: inside, focusNode: inside, keyboard: true }, header), false);
    });
    test('missing inputs never suppress', () => {
        assert.equal(shouldSuppressToggle(null, header), false);
        assert.equal(shouldSuppressToggle({ isCollapsed: false, rangeCount: 1, anchorNode: inside, focusNode: inside }, null), false);
    });
    test('the page embeds this exact function source and the click handler marks keyboard clicks via detail === 0', () => {
        const html = HTML_TEMPLATE([]);
        assert.ok(html.includes(shouldSuppressToggle.toString()));
        assert.ok(html.includes('keyboard: e.detail === 0'));
    });
});
