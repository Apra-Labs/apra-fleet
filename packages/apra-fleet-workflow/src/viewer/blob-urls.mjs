// URL resolution for the blob-hosted dashboard (the viewer's `blob` data
// provider). These functions are EMBEDDED VERBATIM into the served page via
// `.toString()` (see index.mjs, same pattern as resolveStringRefs), so each
// must stay self-contained: no imports, no references to module scope, only
// globals that exist in both a browser and Node (URL, URLSearchParams).
//
// THE ACCESS MODEL. The page itself carries no run data and no storage
// URL. It sits in the same private container as the data and is opened with
// ONE access token, which loads the page and authorises every read:
//
//   <container>/viewer.html?<SAS>#<runId>
//
// (An explicit `#state=<url>&sas=<token>` form remains for data kept
// elsewhere.) Every file the page reads (state.json, activities/<id>.json,
// extensions/<ext>/<id>.json) lives in state.json's folder and is read WITH
// the token. It used to be derived by cutting the state URL at its last '/',
// which dropped the SAS query string from every per-item read, so each one
// failed with 403 once the data was not public.
//
// ASCII only.

/**
 * Parse the page's location into the blob URLs the page reads.
 *
 * THE SHORT FORM (what links use): the page lives in the same container as
 * the data and is opened as
 *
 *   <container>/viewer.html?<SAS>#<runId>
 *
 * The SAS that loaded the page is the one every data read uses, and the
 * run's state is `<runsPrefix>/<runId>/state.json` resolved against the
 * page's own URL -- so the token appears once and nothing else needs to be
 * spelled out. `#run=<id>` is the same thing, named. `runsPrefix` is the
 * folder the publisher stores runs under; it is baked into the page when the
 * page is generated (HTML_TEMPLATE opts.blobRunsPrefix), never guessed here.
 *
 * THE EXPLICIT FORM (an override, e.g. data elsewhere): `#state=<url>` plus
 * an optional `sas=<token>`. The token is then `sas=`, else the state URL's
 * own query, else the page's. A SAS contains '&', so a SAS pasted WITHOUT
 * encoding splits into stray params (sv=, se=, sp=, sig=, ...); those are
 * reassembled into the token rather than silently dropped.
 *
 * @param {string} hash - `location.hash`, with or without the leading '#'
 * @param {string} [pageHref] - `location.href`; needed for the short form
 * @param {string} [pageSearch] - `location.search`; the page's own token
 * @param {string} [runsPrefix] - folder of runs beside the page (default 'runs')
 * @returns {{ stateUrl: string|null, base: string, token: string, socketUrl: string|null }}
 */
export function resolveBlobDataUrls(hash, pageHref, pageSearch, runsPrefix) {
    const rawHash = String(hash || '').replace(/^#/, '');
    const pageToken = String(pageSearch || '').replace(/^\?/, '');

    // Short form: a bare run id (no '=' anywhere), or run=<id>.
    const prefix = String(runsPrefix || 'runs').replace(/^\/+|\/+$/g, '');
    let runId = null;
    if (rawHash && rawHash.indexOf('=') === -1) {
        try { runId = decodeURIComponent(rawHash); } catch (e) { runId = null; }
    } else if (rawHash) {
        const named = new URLSearchParams(rawHash).get('run');
        if (named && !new URLSearchParams(rawHash).get('state')) runId = named;
    }
    if (runId) {
        let stateUrl;
        try {
            stateUrl = new URL(prefix + '/' + encodeURIComponent(runId) + '/state.json', pageHref);
        } catch (e) {
            return { stateUrl: null, base: '', token: '', socketUrl: null };
        }
        const dir = stateUrl.origin + stateUrl.pathname.slice(0, stateUrl.pathname.lastIndexOf('/') + 1);
        return {
            stateUrl: stateUrl.origin + stateUrl.pathname + (pageToken ? '?' + pageToken : ''),
            base: dir,
            token: pageToken,
            socketUrl: null,
        };
    }

    const params = new URLSearchParams(rawHash);
    const reserved = { state: true, sas: true, socket: true };
    const strays = [];
    params.forEach(function (value, key) {
        if (!reserved[key]) strays.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
    });
    const socketUrl = params.get('socket') || null;
    const rawState = params.get('state');
    if (!rawState) return { stateUrl: null, base: '', token: '', socketUrl: socketUrl };

    let parsed;
    try {
        parsed = new URL(rawState);
    } catch (e) {
        return { stateUrl: null, base: '', token: '', socketUrl: socketUrl };
    }
    const sasParam = params.get('sas');
    let token = sasParam !== null
        ? String(sasParam).replace(/^[?&]+/, '')
        : (parsed.search.replace(/^\?/, '') || pageToken);
    if (strays.length > 0) token = token ? token + '&' + strays.join('&') : strays.join('&');

    const path = parsed.pathname;
    const base = parsed.origin + path.slice(0, path.lastIndexOf('/') + 1);
    const stateUrl = parsed.origin + path + (token ? '?' + token : '');
    return { stateUrl: stateUrl, base: base, token: token, socketUrl: socketUrl };
}

/**
 * The URL of one file in state.json's folder, carrying the same SAS.
 * @param {{ base: string, token: string }} urls - from resolveBlobDataUrls()
 * @param {string} relPath - e.g. 'activities/<id>.json' (already encoded)
 * @returns {string}
 */
export function blobDataUrl(urls, relPath) {
    return urls.base + relPath + (urls.token ? '?' + urls.token : '');
}

/**
 * Build a viewer link in the short form: the page's URL, the SAS once (it
 * loads the page AND every data read), and the run id as the fragment.
 * @param {{ pageUrl: string, runId: string, sas?: string|null }} parts
 * @returns {string}
 */
export function buildBlobViewerLink({ pageUrl, runId, sas = null }) {
    const token = sas ? String(sas).replace(/^[?&]+/, '') : '';
    return String(pageUrl).split('#')[0].split('?')[0] + (token ? '?' + token : '') + '#' + encodeURIComponent(runId);
}

/**
 * Build the fragment a viewer link carries -- the one place links are
 * produced, so every value is encoded (an unencoded SAS splits the fragment).
 * @param {{ stateUrl: string, sas?: string|null, socketUrl?: string|null }} parts
 * @returns {string} starting with '#'
 */
export function buildBlobViewerFragment({ stateUrl, sas = null, socketUrl = null }) {
    const pairs = ['state=' + encodeURIComponent(stateUrl)];
    if (sas) pairs.push('sas=' + encodeURIComponent(String(sas).replace(/^[?&]+/, '')));
    if (socketUrl) pairs.push('socket=' + encodeURIComponent(socketUrl));
    return '#' + pairs.join('&');
}
