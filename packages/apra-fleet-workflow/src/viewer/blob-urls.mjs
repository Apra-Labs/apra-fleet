// URL resolution for the blob-hosted dashboard (the viewer's `blob` data
// provider). These functions are EMBEDDED VERBATIM into the served page via
// `.toString()` (see index.mjs, same pattern as resolveStringRefs), so each
// must stay self-contained: no imports, no references to module scope, only
// globals that exist in both a browser and Node (URL, URLSearchParams).
//
// THE ACCESS MODEL. The page itself carries no sprint data and no storage
// URL; everything it reads comes from its own URL FRAGMENT:
//
//   #state=<url of state.json>&sas=<read SAS token>[&socket=<ws url>]
//
// The fragment is never sent to any server or in a Referer, so the SAS
// travels only as far as the blob reads themselves. Every file the page
// reads (state.json, activities/<id>.json, extensions/<ext>/<id>.json) lives
// in state.json's folder and is read WITH the SAS. It used to be derived by
// cutting the state URL at its last '/', which dropped the SAS query string
// from every per-item read, so each one failed with 403 once the data was
// not public.
//
// ASCII only.

/**
 * Parse the page fragment into the blob URLs the page reads.
 *
 * The SAS comes from `sas=` when present, else from the state URL's own
 * query string. A SAS contains '&', so a link whose SAS was pasted WITHOUT
 * encoding splits into stray top-level params (sv=, se=, sp=, sig=, ...);
 * those are reassembled into the token rather than silently dropped, which
 * would lose the signature.
 *
 * @param {string} hash - `location.hash`, with or without the leading '#'
 * @returns {{ stateUrl: string|null, base: string, token: string, socketUrl: string|null }}
 */
export function resolveBlobDataUrls(hash) {
    const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
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
        : parsed.search.replace(/^\?/, '');
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
