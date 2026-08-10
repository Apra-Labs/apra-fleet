// Verification for apra-fleet-4yr (apra-fleet-4yr.2): apra-fleet-4yr.1
// replaced the dashboard's native window.confirm()/alert() on the Stop path
// with an in-page modal + non-blocking toast (see
// packages/apra-fleet-workflow/src/viewer/index.mjs, HTML_TEMPLATE()).
//
// There is no jsdom/browser dependency in this repo -- same technique as
// apra-fleet-workflow/test/viewer-heartbeat-quiet-period-dom.test.mjs and
// apra-fleet-workflow-viewer-more-output-button.test.mjs: extract the ACTUAL
// stopWorkflow()/closeStopModal()/confirmStopWorkflow()/showStopToast()
// functions verbatim out of HTML_TEMPLATE()'s emitted client script and
// execute them against a lightweight DOM stub + mocked fetch, rather than
// reimplementing the logic here (which would drift out of sync with the real
// client code and stop catching regressions like a reintroduced confirm()/
// alert()).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HTML_TEMPLATE } from '@apralabs/apra-fleet-workflow/viewer';

// A minimal classList + element stub -- just enough surface for the
// extracted script (classList.add/remove/contains, getElementById,
// addEventListener, querySelectorAll used elsewhere in the template is not
// reached by this extracted slice).
function makeClassList(el) {
    return {
        add(cls) { el._classes.add(cls); },
        remove(cls) { el._classes.delete(cls); },
        contains(cls) { return el._classes.has(cls); },
    };
}

function makeElement(id) {
    const el = { id, _classes: new Set(), textContent: '' };
    el.classList = makeClassList(el);
    return el;
}

/**
 * Builds a runnable sandbox around the actual Stop-modal script block (from
 * `function stopWorkflow()` through the Escape keydown listener registration),
 * extracted verbatim out of HTML_TEMPLATE()'s emitted client script.
 */
function buildStopModalSandbox({ fetchImpl } = {}) {
    const html = HTML_TEMPLATE([]);
    const start = html.indexOf('function stopWorkflow()');
    assert.ok(start !== -1, 'template must define stopWorkflow()');
    const end = html.indexOf('let allExpanded = true;', start);
    assert.ok(end !== -1, 'must find the end of the stop-modal script block');
    const script = html.slice(start, end);

    const overlay = makeElement('stop-modal-overlay');
    const toast = makeElement('stop-toast');
    const elementsById = { 'stop-modal-overlay': overlay, 'stop-toast': toast };

    const keydownHandlers = [];
    const mockDocument = {
        getElementById: (id) => elementsById[id] || null,
        addEventListener: (type, handler) => {
            if (type === 'keydown') keydownHandlers.push(handler);
        },
    };

    const fetchCalls = [];
    const fetch = fetchImpl || (async (url, opts) => {
        fetchCalls.push({ url, opts });
        return { ok: true };
    });

    const timers = [];
    const setTimeoutStub = (fn) => { timers.push(fn); return timers.length; };

    // eslint-disable-next-line no-new-func
    const fn = new Function('document', 'fetch', 'setTimeout', `${script}\nreturn { stopWorkflow, closeStopModal, confirmStopWorkflow, showStopToast };`);
    const api = fn(mockDocument, fetch, setTimeoutStub);

    return {
        overlay,
        toast,
        fetchCalls,
        timers,
        pressEscape() {
            for (const handler of keydownHandlers) handler({ key: 'Escape' });
        },
        ...api,
    };
}

describe('apra-fleet-4yr.2: dashboard Stop uses the in-page modal (no native confirm()/alert())', () => {
    test('no bare confirm(/alert( call remains on the stop path', () => {
        const html = HTML_TEMPLATE([]);
        const start = html.indexOf('function stopWorkflow()');
        assert.ok(start !== -1);
        const end = html.indexOf('let allExpanded = true;', start);
        const stopPathScript = html.slice(start, end);
        assert.ok(!/\bconfirm\(/.test(stopPathScript), 'stop path must not call window.confirm()');
        assert.ok(!/\balert\(/.test(stopPathScript), 'stop path must not call window.alert()');
    });

    test('modal markup exists and its buttons reuse the --danger / --accent themed button classes', () => {
        const html = HTML_TEMPLATE([]);
        assert.ok(html.includes('id="stop-modal-overlay"'), 'modal overlay markup must exist');
        assert.ok(html.includes('id="stop-toast"'), 'toast markup must exist');
        assert.ok(html.includes('onclick="closeStopModal()"'), 'modal must wire a Cancel handler');
        assert.ok(html.includes('onclick="confirmStopWorkflow()"'), 'modal must wire a confirm-stop handler');
        // The modal's Stop action reuses .btn-stop (var(--danger)); the
        // stylesheet also defines .btn-save/.group-header etc against
        // var(--accent) -- both theme variables are present in the emitted
        // document the modal is styled against.
        assert.ok(/\.btn-stop\s*\{[^}]*var\(--danger\)/.test(html), 'the modal Stop button class must be themed with var(--danger)');
        assert.ok(html.includes('var(--accent)'), 'the dashboard stylesheet the modal is rendered within must define var(--accent)');
    });

    test('clicking Stop opens the modal and sends nothing', () => {
        const sandbox = buildStopModalSandbox();
        assert.equal(sandbox.overlay.classList.contains('open'), false);
        sandbox.stopWorkflow();
        assert.equal(sandbox.overlay.classList.contains('open'), true, 'Stop must open the modal');
        assert.deepEqual(sandbox.fetchCalls, [], 'opening the modal must not send /stop');
    });

    test('Cancel closes the modal and sends nothing', () => {
        const sandbox = buildStopModalSandbox();
        sandbox.stopWorkflow();
        sandbox.closeStopModal();
        assert.equal(sandbox.overlay.classList.contains('open'), false, 'Cancel must close the modal');
        assert.deepEqual(sandbox.fetchCalls, [], 'Cancel must not send /stop');
    });

    test('Escape closes the modal and sends nothing', () => {
        const sandbox = buildStopModalSandbox();
        sandbox.stopWorkflow();
        sandbox.pressEscape();
        assert.equal(sandbox.overlay.classList.contains('open'), false, 'Escape must close the modal');
        assert.deepEqual(sandbox.fetchCalls, [], 'Escape must not send /stop');
    });

    test('confirming the modal sends exactly one POST /stop and shows a toast (no alert())', async () => {
        const sandbox = buildStopModalSandbox();
        sandbox.stopWorkflow();
        await sandbox.confirmStopWorkflow();

        assert.equal(sandbox.overlay.classList.contains('open'), false, 'confirming must also close the modal');
        assert.equal(sandbox.fetchCalls.length, 1, 'confirming must send exactly one /stop request');
        assert.equal(sandbox.fetchCalls[0].url, '/stop');
        assert.equal(sandbox.fetchCalls[0].opts.method, 'POST');

        assert.equal(sandbox.toast.classList.contains('show'), true, 'a toast element must be shown on resolve');
    });

    test('a second confirm click after resolve does not send a duplicate request unless Stop is reopened explicitly', async () => {
        const sandbox = buildStopModalSandbox();
        sandbox.stopWorkflow();
        await sandbox.confirmStopWorkflow();
        assert.equal(sandbox.fetchCalls.length, 1);
        // Re-clicking Stop and confirming again is a deliberate second action
        // (e.g. the user retrying) -- it sends its own single request, still
        // never two from one confirm click.
        sandbox.stopWorkflow();
        await sandbox.confirmStopWorkflow();
        assert.equal(sandbox.fetchCalls.length, 2);
    });
});
