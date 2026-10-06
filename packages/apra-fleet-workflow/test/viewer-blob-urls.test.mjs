// The blob-hosted dashboard reads every file with the SAS from its URL
// fragment. It used to derive per-item URLs by cutting the state URL at its
// last '/', which dropped the SAS query, so every 'more...' and bead
// description read failed with 403 once the container was private -- and
// the archived page called live routes that no longer exist at all. These
// tests run the REAL emitted page code (extracted from HTML_TEMPLATE's
// output) against a fake location/fetch and assert the URLs it requests.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

import { HTML_TEMPLATE } from '../src/viewer/index.mjs';
import { resolveBlobDataUrls, blobDataUrl, buildBlobViewerFragment, buildBlobViewerLink } from '../src/viewer/blob-urls.mjs';

const SAS = 'sv=2021-08-06&sr=c&sp=r&se=2026-09-30T04%3A00%3A00Z&sig=abc%2Fdef%3D';
const STATE = 'https://acct.blob.core.windows.net/c1/sprints/s1/state.json';

describe('resolveBlobDataUrls', () => {
  test('a separate sas= param is carried onto the state URL and every derived URL', () => {
    const urls = resolveBlobDataUrls(buildBlobViewerFragment({ stateUrl: STATE, sas: SAS }));
    assert.equal(urls.stateUrl, `${STATE}?${SAS}`);
    assert.equal(urls.base, 'https://acct.blob.core.windows.net/c1/sprints/s1/');
    assert.equal(blobDataUrl(urls, 'activities/a1.json'), `https://acct.blob.core.windows.net/c1/sprints/s1/activities/a1.json?${SAS}`);
  });

  test('a SAS on the state URL itself is kept for derived URLs too', () => {
    const urls = resolveBlobDataUrls(`#state=${encodeURIComponent(`${STATE}?${SAS}`)}`);
    assert.equal(blobDataUrl(urls, 'extensions/beads/b1.json'), `https://acct.blob.core.windows.net/c1/sprints/s1/extensions/beads/b1.json?${SAS}`);
  });

  test('a SAS pasted WITHOUT encoding is reassembled, not truncated to its first field', () => {
    const urls = resolveBlobDataUrls(`#state=${encodeURIComponent(STATE)}&sas=sv=2021-08-06&sp=r&sig=zzz`);
    for (const part of ['sv=2021-08-06', 'sp=r', 'sig=zzz']) {
      assert.ok(urls.token.includes(part), `token must keep ${part}: ${urls.token}`);
    }
  });

  test('no fragment, or a state value that is not a URL, yields no state URL (the page shows no data)', () => {
    assert.equal(resolveBlobDataUrls('').stateUrl, null);
    assert.equal(resolveBlobDataUrls('#state=not a url').stateUrl, null);
  });

  test('without any SAS, derived URLs carry no query at all', () => {
    const urls = resolveBlobDataUrls(`#state=${encodeURIComponent(STATE)}`);
    assert.equal(blobDataUrl(urls, 'activities/a1.json'), 'https://acct.blob.core.windows.net/c1/sprints/s1/activities/a1.json');
  });
});

/**
 * Run the data-provider block of a real emitted page in a sandbox and return
 * its dataProvider plus every URL it fetched.
 */
function loadProvider(html, { hash = '', search = '', href = '' } = {}) {
  const start = html.indexOf('<script>');
  const script = html.slice(start + '<script>'.length, html.indexOf('</script>', start));
  const from = script.indexOf('function resolveStringRefs');
  const endMarker = 'window.dataProvider = dataProvider; }';
  const to = script.indexOf(endMarker) + endMarker.length;
  assert.ok(from > 0 && to > from, 'could not locate the provider block in the emitted page');
  const fetched = [];
  const sandbox = {
    URL, URLSearchParams, encodeURIComponent, decodeURIComponent,
    location: { hash, search, href },
    window: {},
    fetch: async (url) => { fetched.push(url); return { ok: true, json: async () => ({ id: 'x', _strings: [] }) }; },
    setInterval: () => 0, clearInterval: () => {},
  };
  vm.runInNewContext(script.slice(from, to), sandbox);
  return { provider: sandbox.window.dataProvider, fetched };
}

// The short link: the page sits in the same (private) container as the data
// and is opened as viewer.html?<SAS>#<runId>. The token appears ONCE -- the one
// that loaded the page is the one every read uses -- and the state URL is
// derived from the page's own location instead of being spelled out.
const PAGE = 'https://acct.blob.core.windows.net/c1/viewer.html';

describe('the short link', () => {
  test('builds as page?SAS#runId, with the run id encoded', () => {
    assert.equal(buildBlobViewerLink({ pageUrl: PAGE, runId: 's 1', sas: `?${SAS}` }), `${PAGE}?${SAS}#s%201`);
  });

  test('derives the state URL beside the page (default runs/ folder) and carries the page token to every read', () => {
    const urls = resolveBlobDataUrls('#s%201', `${PAGE}?${SAS}#s%201`, `?${SAS}`);
    assert.equal(urls.stateUrl, `https://acct.blob.core.windows.net/c1/runs/s%201/state.json?${SAS}`);
    assert.equal(blobDataUrl(urls, 'activities/a1.json'), `https://acct.blob.core.windows.net/c1/runs/s%201/activities/a1.json?${SAS}`);
  });

  test('#run=<id> is the same thing, named, and the folder is whatever the publisher says', () => {
    const urls = resolveBlobDataUrls('#run=s1', `${PAGE}?${SAS}`, `?${SAS}`, 'sprints');
    assert.equal(urls.stateUrl, `https://acct.blob.core.windows.net/c1/sprints/s1/state.json?${SAS}`);
  });

  test('the explicit #state= form still works, and falls back to the page token', () => {
    const urls = resolveBlobDataUrls(`#state=${encodeURIComponent(STATE)}`, `${PAGE}?${SAS}`, `?${SAS}`);
    assert.equal(urls.stateUrl, `${STATE}?${SAS}`);
  });

  test('the real emitted page, published with a runs folder, reads everything with the ONE token it was opened with', async () => {
    const html = HTML_TEMPLATE([], { dataProvider: 'blob', blobRunsPrefix: 'sprints' });
    const link = buildBlobViewerLink({ pageUrl: PAGE, runId: 's1', sas: SAS });
    const { provider, fetched } = loadProvider(html, { href: link, search: `?${SAS}`, hash: '#s1' });
    await provider.getState();
    await provider.getActivityOutput('a1');
    await provider.getExtensionDetail('beads', 'b1');
    assert.deepEqual(fetched, [
      `https://acct.blob.core.windows.net/c1/sprints/s1/state.json?${SAS}`,
      `https://acct.blob.core.windows.net/c1/sprints/s1/activities/a1.json?${SAS}`,
      `https://acct.blob.core.windows.net/c1/sprints/s1/extensions/beads/b1.json?${SAS}`,
    ]);
  });

  test('a runs folder that is not a plain name is refused in favour of the default', () => {
    const html = HTML_TEMPLATE([], { dataProvider: 'blob', blobRunsPrefix: '../elsewhere' });
    assert.ok(html.includes('const BLOB_RUNS_PREFIX = "runs"'));
  });
});

describe('the emitted blob page', () => {
  test('reads state, activity output and extension detail WITH the SAS', async () => {
    const html = HTML_TEMPLATE([], { dataProvider: 'blob' });
    const { provider, fetched } = loadProvider(html, { hash: buildBlobViewerFragment({ stateUrl: STATE, sas: SAS }) });
    await provider.getState();
    await provider.getActivityOutput('act 1');
    await provider.getExtensionDetail('beads', 'b-1');
    assert.deepEqual(fetched, [
      `${STATE}?${SAS}`,
      `https://acct.blob.core.windows.net/c1/sprints/s1/activities/act%201.json?${SAS}`,
      `https://acct.blob.core.windows.net/c1/sprints/s1/extensions/beads/b-1.json?${SAS}`,
    ]);
  });
});

// The page's script is generated inside a template literal, so an escape that
// is right in the source can come out wrong in the page (a \' becomes a bare
// quote). Caught once already while writing this file; compile every mode.
describe('the emitted page script compiles in every mode', () => {
  const state = { workflowName: 'x', status: 'success', stats: {}, tree: [], extensions: {} };
  for (const [label, opts] of [
    ['live', {}],
    ['blob', { dataProvider: 'blob' }],
    ['history', { history: true, state }],
    ['archive', { history: true, state, historyAssets: 'relative' }],
  ]) {
    test(label, () => {
      const html = HTML_TEMPLATE([], opts);
      const start = html.indexOf('<script>');
      const script = html.slice(start + '<script>'.length, html.indexOf('</script>', start));
      assert.doesNotThrow(() => new vm.Script(script), `the ${label} page script must parse`);
    });
  }
});

describe('the emitted blob page without access', () => {
  // Observed live against real storage: with no SAS, the page tried to parse
  // the service's XML error body as JSON and reported a syntax error.
  test('a refused state read says there is no access, with the HTTP status', async () => {
    const html = HTML_TEMPLATE([], { dataProvider: 'blob' });
    const start = html.indexOf('<script>');
    const script = html.slice(start + '<script>'.length, html.indexOf('</script>', start));
    const from = script.indexOf('function resolveStringRefs');
    const marker = 'window.dataProvider = dataProvider; }';
    const sandbox = {
      URL, URLSearchParams, encodeURIComponent,
      location: { hash: buildBlobViewerFragment({ stateUrl: STATE }), search: '' },
      window: {},
      fetch: async () => ({ ok: false, status: 409, json: async () => { throw new SyntaxError("Unexpected token '<'"); } }),
      setInterval: () => 0, clearInterval: () => {},
    };
    vm.runInNewContext(script.slice(from, script.indexOf(marker) + marker.length), sandbox);
    await assert.rejects(sandbox.window.dataProvider.getState(), /no access to this run \(HTTP 409\)/);
  });
});

describe('the emitted archive page (history, relative assets)', () => {
  const state = { workflowName: 'x', status: 'success', stats: { activitiesCount: 0, totalTokens: 0, totalCost: 0, unknownCostCount: 0, startTime: 0, durationMs: 0 }, tree: [], extensions: {} };

  test('reads the materialised files beside the page, with the page query string', async () => {
    const html = HTML_TEMPLATE([], { history: true, state, historyAssets: 'relative' });
    const { provider, fetched } = loadProvider(html, { search: `?${SAS}` });
    await provider.getActivityOutput('a1');
    await provider.getExtensionDetail('beads', 'b1');
    assert.deepEqual(fetched, [`activities/a1.json?${SAS}`, `extensions/beads/b1.json?${SAS}`]);
  });

  test('the default history page keeps calling the live routes (supervisor History view unchanged)', async () => {
    const html = HTML_TEMPLATE([], { history: true, state });
    const { provider, fetched } = loadProvider(html);
    await provider.getActivityOutput('a1');
    assert.deepEqual(fetched, ['/activities/a1/output']);
  });
});
