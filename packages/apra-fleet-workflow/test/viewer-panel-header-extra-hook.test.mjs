// apra-fleet-vk0a.2: HTML_TEMPLATE's per-extension panel-header row must
// expose a fixed, always-visible hook -- `panel-header-${ext.id}-extra` --
// as a SIBLING of the tab title <span> inside `#panel-header-${ext.id}`,
// not inside the scrollable `#extension-${ext.id}` content container below
// it. This is what lets a consuming extension (e.g. fleet-sprint's
// beadsExtension.js renderBeadsPanel(), see viewer-extensions.mjs) pin a
// widget like the sprint progress bar into the fixed header row instead of
// re-rendering it at the top of the scrollable tree, where it would scroll
// out of view. This test pins that contract at the core-template level, so
// a regression that drops/renames the hook (or moves it inside the
// scrollable container) fails here rather than only in a
// fleet-sprint-specific reimplementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HTML_TEMPLATE } from '../src/viewer/index.mjs';

const dashboardExtensions = [{ id: 'beads', title: 'Tasks', js: '' }];

test('HTML_TEMPLATE emits a panel-header-<ext.id>-extra hook for each dashboard extension', () => {
    const html = HTML_TEMPLATE(dashboardExtensions);
    assert.match(html, /id=["']panel-header-beads-extra["']/, 'panel-header row must expose the per-extension -extra hook');
});

test('the -extra hook is a sibling of the tab title inside panel-header-<ext.id>, not inside the scrollable extension-<ext.id> container', () => {
    const html = HTML_TEMPLATE(dashboardExtensions);

    const headerStart = html.indexOf('id="panel-header-beads"');
    assert.ok(headerStart !== -1, 'must find the fixed panel-header row for the beads extension');
    const contentStart = html.indexOf('id="extension-beads"');
    assert.ok(contentStart !== -1, 'must find the scrollable content container for the beads extension');
    assert.ok(headerStart < contentStart, 'panel-header row must render before its scrollable content container');

    // The -extra hook must live between the panel-header opening tag and
    // the scrollable content container's opening tag -- i.e. inside the
    // fixed header row, never inside (or after) the scrollable container.
    const headerBlock = html.slice(headerStart, contentStart);
    assert.match(headerBlock, /id=["']panel-header-beads-extra["']/, 'the -extra hook must be nested inside the fixed panel-header row');

    const extraIdx = html.indexOf('panel-header-beads-extra');
    const contentBlockStart = contentStart;
    const contentBlockEnd = html.indexOf('</div>', contentBlockStart);
    assert.ok(!(extraIdx >= contentBlockStart && extraIdx <= contentBlockEnd), 'the -extra hook must NOT be inside the scrollable extension-beads container');

    // Sanity: the hook is a sibling of the title <span>, both inside the
    // same panel-header <div>.
    assert.match(headerBlock, /<span>Tasks<\/span>/, 'the extension title must still render as a sibling of the -extra hook');
});

test('HTML_TEMPLATE with no dashboard extensions emits no -extra hooks at all', () => {
    const html = HTML_TEMPLATE([]);
    assert.ok(!html.includes('-extra"'), 'no extensions means no per-extension header hooks');
});
