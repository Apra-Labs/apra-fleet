// apra-fleet-siqi.2.2: coverage for DASHBOARD_TAB_SCRIPT's switchTab() --
// the tab-activation refresh hook apra-fleet-siqi.2.1 wired up to reach the
// SAME fetch/poll plumbing each tab already uses elsewhere
// (window.__fleetSeSprintStack.refreshIfStale() for Sprints,
// window.__fleetSeBacklog.refreshIfStale() for Backlog), never a full page
// reload/navigation.
//
// Same technique as supervisor-dashboard-live-refresh.test.mjs: extract the
// ACTUAL client script verbatim out of renderIndexPageHtml()'s emitted HTML
// and execute it against hand-rolled document/window/event/location stubs,
// rather than reimplementing switchTab()'s logic here (which would drift out
// of sync with the real client code and stop catching regressions).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { renderIndexPageHtml } from '../src/supervisor/dashboard.mjs';

/** Minimal classList stub -- just enough for switchTab()'s add()/remove(). */
class MockClassList {
    constructor() {
        this.classes = new Set();
    }
    add(c) { this.classes.add(c); }
    remove(c) { this.classes.delete(c); }
    contains(c) { return this.classes.has(c); }
}

class MockEl {
    constructor() {
        this.classList = new MockClassList();
    }
}

/**
 * Extracts the ACTUAL DASHBOARD_TAB_SCRIPT verbatim out of
 * renderIndexPageHtml()'s emitted HTML: from its `var TAB_ACTIVATION_STALE_MS`
 * declaration (so the extracted snippet is self-contained -- switchTab()
 * closes over that var) through the closing `</script>` tag. Deliberately
 * NOT `html.indexOf('<script>')` -- renderLaunchFormHtml()'s own embedded
 * `<script>` (launch-form.mjs) renders EARLIER in the document than
 * DASHBOARD_TAB_SCRIPT, so the first raw `<script>` tag in the page is not
 * this one.
 */
function extractTabScript() {
    const html = renderIndexPageHtml([]);
    const start = html.indexOf('var TAB_ACTIVATION_STALE_MS');
    assert.ok(start !== -1, 'renderIndexPageHtml() must embed DASHBOARD_TAB_SCRIPT');
    const end = html.indexOf('</script>', start);
    assert.ok(end !== -1, 'must find the end of the tab-activation script block');
    return html.slice(start, end);
}

/**
 * Runs the actual switchTab() from the extracted DASHBOARD_TAB_SCRIPT against
 * mocked document/window/event/location, returning the callable switchTab
 * function (captured via an appended `return switchTab;` -- the extracted
 * script itself is never modified, only what we do with it afterward).
 */
function buildSwitchTab({ document, window, event, location }) {
    const script = extractTabScript();
    // eslint-disable-next-line no-new-func
    const fn = new Function('document', 'window', 'event', 'location', script + '\n;return switchTab;');
    return fn(document, window, event, location);
}

describe('apra-fleet-siqi.2.2: tab activation triggers a data fetch with no full-page reload', () => {
    test('activating Sprints calls window.__fleetSeSprintStack.refreshIfStale() (the siqi.1 fetch/poll path), never window.__fleetSeBacklog, and never a full-page reload', () => {
        const tabButtons = { sprints: new MockEl(), backlog: new MockEl() };
        const tabContents = { sprints: new MockEl(), backlog: new MockEl() };
        const mockDocument = {
            querySelectorAll(sel) {
                if (sel === '.tab-btn') return Object.values(tabButtons);
                if (sel === '.tab-content') return Object.values(tabContents);
                throw new Error(`unsupported selector: ${sel}`);
            },
            getElementById(id) {
                if (id === 'tab-sprints') return tabContents.sprints;
                if (id === 'tab-backlog') return tabContents.backlog;
                return null;
            },
        };
        const sprintStackCalls = [];
        const backlogCalls = [];
        const mockWindow = {
            __fleetSeSprintStack: { refreshIfStale: (maxAgeMs) => sprintStackCalls.push(maxAgeMs) },
            __fleetSeBacklog: { refreshIfStale: (maxAgeMs) => backlogCalls.push(maxAgeMs) },
        };
        // A real switchTab() implementation never touches navigation at all
        // (acceptance criterion: "no full-page navigation/reload is
        // invoked") -- these throw if it ever does, turning a future
        // regression into a hard test failure rather than a silent full
        // reload.
        const mockLocation = {
            reload() { throw new Error('switchTab() must never call location.reload()'); },
            assign() { throw new Error('switchTab() must never call location.assign()'); },
            replace() { throw new Error('switchTab() must never call location.replace()'); },
            set href(_v) { throw new Error('switchTab() must never navigate via location.href'); },
        };
        // switchTab() reads the bare global `event` (an inline onclick
        // handler's implicit event) -- mutated per call below, same object
        // reference reused across both switchTab() invocations in this test.
        const mockEvent = { currentTarget: null };

        const switchTab = buildSwitchTab({ document: mockDocument, window: mockWindow, event: mockEvent, location: mockLocation });

        mockEvent.currentTarget = tabButtons.sprints;
        switchTab('sprints');

        assert.deepEqual(sprintStackCalls, [3000], 'Sprints activation must call window.__fleetSeSprintStack.refreshIfStale() with the configured TAB_ACTIVATION_STALE_MS');
        assert.deepEqual(backlogCalls, [], 'activating Sprints must never call the Backlog refresh path -- the two tabs refresh independently');
        assert.ok(tabContents.sprints.classList.contains('active'), 'the Sprints tab-content panel is activated');
        assert.ok(!tabContents.backlog.classList.contains('active'), 'the Backlog tab-content panel is not activated');
        assert.ok(tabButtons.sprints.classList.contains('active'), 'the clicked tab button is marked active');
    });

    test('activating Backlog calls window.__fleetSeBacklog.refreshIfStale() (the siqi.1 fetch/poll path), never window.__fleetSeSprintStack, and never a full-page reload', () => {
        const tabButtons = { sprints: new MockEl(), backlog: new MockEl() };
        const tabContents = { sprints: new MockEl(), backlog: new MockEl() };
        const mockDocument = {
            querySelectorAll(sel) {
                if (sel === '.tab-btn') return Object.values(tabButtons);
                if (sel === '.tab-content') return Object.values(tabContents);
                throw new Error(`unsupported selector: ${sel}`);
            },
            getElementById(id) {
                if (id === 'tab-sprints') return tabContents.sprints;
                if (id === 'tab-backlog') return tabContents.backlog;
                return null;
            },
        };
        const sprintStackCalls = [];
        const backlogCalls = [];
        const mockWindow = {
            __fleetSeSprintStack: { refreshIfStale: (maxAgeMs) => sprintStackCalls.push(maxAgeMs) },
            __fleetSeBacklog: { refreshIfStale: (maxAgeMs) => backlogCalls.push(maxAgeMs) },
        };
        const mockLocation = {
            reload() { throw new Error('switchTab() must never call location.reload()'); },
            assign() { throw new Error('switchTab() must never call location.assign()'); },
            replace() { throw new Error('switchTab() must never call location.replace()'); },
            set href(_v) { throw new Error('switchTab() must never navigate via location.href'); },
        };
        const mockEvent = { currentTarget: null };

        const switchTab = buildSwitchTab({ document: mockDocument, window: mockWindow, event: mockEvent, location: mockLocation });

        mockEvent.currentTarget = tabButtons.backlog;
        switchTab('backlog');

        assert.deepEqual(backlogCalls, [3000], 'Backlog activation must call window.__fleetSeBacklog.refreshIfStale() with the configured TAB_ACTIVATION_STALE_MS');
        assert.deepEqual(sprintStackCalls, [], 'activating Backlog must never call the Sprints refresh path -- the two tabs refresh independently');
        assert.ok(tabContents.backlog.classList.contains('active'), 'the Backlog tab-content panel is activated');
        assert.ok(!tabContents.sprints.classList.contains('active'), 'the Sprints tab-content panel is not activated');
    });

    test('two activations in a row (Sprints then Backlog) each independently invoke only their own tab\'s refresh path -- neither call double-triggers the other', () => {
        const tabButtons = { sprints: new MockEl(), backlog: new MockEl() };
        const tabContents = { sprints: new MockEl(), backlog: new MockEl() };
        const mockDocument = {
            querySelectorAll(sel) {
                if (sel === '.tab-btn') return Object.values(tabButtons);
                if (sel === '.tab-content') return Object.values(tabContents);
                throw new Error(`unsupported selector: ${sel}`);
            },
            getElementById(id) {
                if (id === 'tab-sprints') return tabContents.sprints;
                if (id === 'tab-backlog') return tabContents.backlog;
                return null;
            },
        };
        const sprintStackCalls = [];
        const backlogCalls = [];
        const mockWindow = {
            __fleetSeSprintStack: { refreshIfStale: (maxAgeMs) => sprintStackCalls.push(maxAgeMs) },
            __fleetSeBacklog: { refreshIfStale: (maxAgeMs) => backlogCalls.push(maxAgeMs) },
        };
        const mockLocation = {
            reload() { throw new Error('switchTab() must never call location.reload()'); },
            assign() { throw new Error('switchTab() must never call location.assign()'); },
            replace() { throw new Error('switchTab() must never call location.replace()'); },
            set href(_v) { throw new Error('switchTab() must never navigate via location.href'); },
        };
        const mockEvent = { currentTarget: null };

        const switchTab = buildSwitchTab({ document: mockDocument, window: mockWindow, event: mockEvent, location: mockLocation });

        mockEvent.currentTarget = tabButtons.sprints;
        switchTab('sprints');
        assert.deepEqual(sprintStackCalls, [3000]);
        assert.deepEqual(backlogCalls, []);

        mockEvent.currentTarget = tabButtons.backlog;
        switchTab('backlog');
        assert.deepEqual(sprintStackCalls, [3000], 'the earlier Sprints refresh call count is untouched by the later Backlog activation');
        assert.deepEqual(backlogCalls, [3000]);
    });
});
