// =============================================================================
// Auto-sprint supervisor -- mount-prefix resolution for embedded rendering
// (apra-fleet-i9ag.3.2)
// =============================================================================
//
// The supervisor's pages are served two ways:
//
//   1. DIRECTLY, at the supervisor's own origin (`http://127.0.0.1:<port>/`) --
//      the long-standing case, where every absolute app-path the page emits
//      ('/state', '/events', '/api/sprints', '/sprints/<id>/live', ...)
//      resolves correctly against that origin's root.
//   2. EMBEDDED, inside the apra-fleet console's workflow-package iframe, where
//      the console's `/ext/<id>/*` reverse proxy (src/console/proxy.ts) is the
//      only thing the browser ever talks to. There, a page-emitted '/state'
//      resolves against the CONSOLE root (`<console>/state`), not the mount
//      point (`<console>/ext/se/state`), so every such path 404s: the embedded
//      dashboard is dead (no live refresh, dead links) and a launch from the
//      embedded form cannot work.
//
// The console tells the package which of the two it is in, per request, via the
// `MOUNT_PATH_HEADER` request header (apra-fleet-i9ag.3.1): the exact
// `/ext/<id>` mount path the proxy itself computed. The proxy STRIPS any
// client-supplied instance of that header before it assembles upstream headers,
// so a browser cannot spoof it -- but this module still treats the value as
// UNTRUSTED NETWORK INPUT, because a supervisor may also be reached directly by
// anything that can talk to its port, and a page that interpolates an
// attacker-chosen string into every href/fetch target on the page is an
// open-redirect / script-injection primitive.
//
// So `sanitizeMountPrefix()` FAILS CLOSED: anything that is not an obviously
// safe, single-rooted, dot-segment-free path made of a conservative character
// allowlist yields `''`, which is exactly the serve-direct behaviour (paths
// stay rooted at '/'). A hostile or malformed header can therefore only ever
// cost the sender the embedded-mode rewrite; it can never inject a quote, an
// angle bracket, whitespace, a scheme, or a protocol-relative '//host' into the
// rendered page. Callers rely on that allowlist: the resolved prefix is
// interpolated verbatim into single-quoted JS string literals inside the
// page's inline <script> blocks (dashboard.mjs) and into `href="..."`
// attributes, and only the allowlist makes that safe without a second escaping
// layer.
//
// HEADER-NAME DUPLICATION IS DELIBERATE: `MOUNT_PATH_HEADER` below is the same
// wire name `src/console/proxy.ts` exports as its own `MOUNT_PATH_HEADER`, but
// apra-fleet-se is a separate package that must not import the apra-fleet
// server's TypeScript internals (it runs standalone, against whatever console
// version happens to be deployed). The string IS the contract between them, the
// same way an HTTP status code is; the name is asserted from both sides in
// tests (tests/console-proxy.test.ts here, supervisor-mount-prefix.test.mjs in
// this package).
// =============================================================================

/**
 * The request header the console's `/ext/<id>` proxy sets on every hop to a
 * workflow package, carrying that package's exact mount path (e.g.
 * `/ext/se`). Mirrors `MOUNT_PATH_HEADER` in src/console/proxy.ts -- see this
 * module's doc comment for why the constant is duplicated rather than imported.
 */
export const MOUNT_PATH_HEADER = 'x-apra-fleet-mount-path';

/**
 * The ONLY characters a resolved mount prefix may contain. Deliberately
 * narrower than what a URL path technically allows: unreserved characters,
 * `%` (so an already-percent-encoded id survives), `/` (segment separator) and
 * `-`/`.`/`_`/`~`. Everything else -- quotes, backslashes, angle brackets,
 * whitespace, control characters, `:`, `?`, `#`, `&` -- fails the whole value
 * closed, which is what lets callers interpolate the prefix straight into a JS
 * string literal or an HTML attribute.
 */
const MOUNT_PREFIX_ALLOWED = /^[A-Za-z0-9._~%/-]+$/;

/**
 * Validates and normalises a raw mount-path header value into either a usable
 * prefix (e.g. `/ext/se`, no trailing slash) or `''` (serve-direct: emit
 * app-paths exactly as before). Never throws, for any input.
 *
 * Accepted: a value that starts with exactly one '/', contains only
 * MOUNT_PREFIX_ALLOWED characters, has no empty segment (which also rules out
 * a protocol-relative '//host' start and an '/a//b' oddity) and no '.' or '..'
 * segment in any spelling this function can recognise ('%2e' included).
 * A single trailing '/' is normalised away; '/' alone resolves to ''.
 *
 * Rejected (-> ''): absent/non-string/empty, a relative path, '..'/'../x',
 * '//evil.example', 'http://evil.example', anything with a character outside
 * the allowlist.
 *
 * @param {unknown} raw
 * @returns {string} a prefix starting with '/' and not ending with one, or ''
 */
export function sanitizeMountPrefix(raw) {
    if (typeof raw !== 'string') return '';
    // No trim(): whitespace is not "tidied up" here, it fails the value closed
    // via the allowlist below. A caller sending ' /ext/se' is sending something
    // this contract does not define, and guessing at its intent is exactly the
    // implicit behaviour this module exists to avoid.
    if (raw.length === 0) return '';
    if (raw.charAt(0) !== '/') return '';
    // Protocol-relative ('//evil.example') -- a browser reads that as a HOST,
    // so it must never reach an href. Also covered by the empty-segment check
    // below; rejected explicitly here because it is the specific hostile shape
    // this guard exists for.
    if (raw.charAt(1) === '/') return '';
    if (!MOUNT_PREFIX_ALLOWED.test(raw)) return '';
    const normalized = raw.length > 1 && raw.endsWith('/') ? raw.slice(0, -1) : raw;
    // '/' alone (or '//' caught above) carries no mount information -- it is
    // the serve-direct case spelled differently.
    if (normalized === '/' || normalized.length === 0) return '';
    for (const segment of normalized.slice(1).split('/')) {
        if (segment.length === 0) return '';
        // '%2e' is '.' once the browser/server decodes it, so '%2e%2e' is a
        // '..' traversal wearing a hat. Compared after decoding that one
        // escape rather than running decodeURIComponent() (which throws on a
        // malformed escape and would widen what this function accepts).
        const decoded = segment.toLowerCase().split('%2e').join('.');
        if (decoded === '.' || decoded === '..') return '';
    }
    return normalized;
}

/**
 * Resolves the mount prefix for ONE request. Accepts either a Node request
 * object (`{ headers }`) or a bare headers bag, so route handlers can pass
 * `req` straight through. Node lower-cases inbound header names, so the direct
 * lookup normally hits; the case-insensitive scan is the fallback for a
 * hand-built headers object in a test or a non-Node caller.
 *
 * A header sent more than once arrives as an array in Node -- ambiguous
 * provenance for a value this trusted, so it fails closed like any other
 * malformed input.
 *
 * @param {{ headers?: Record<string, string|string[]|undefined> }|Record<string, string|string[]|undefined>|null|undefined} source
 * @returns {string} sanitizeMountPrefix()'s result for the header, or ''
 */
export function resolveMountPrefix(source) {
    if (!source || typeof source !== 'object') return '';
    const headers = (source.headers && typeof source.headers === 'object') ? source.headers : source;
    let value = headers[MOUNT_PATH_HEADER];
    if (value === undefined) {
        for (const key of Object.keys(headers)) {
            if (key.toLowerCase() === MOUNT_PATH_HEADER) {
                value = headers[key];
                break;
            }
        }
    }
    if (Array.isArray(value)) return '';
    return sanitizeMountPrefix(value);
}

/**
 * Turns one absolute app-path into a mount-aware one: `/state` ->
 * `/ext/se/state` under a prefix, and `/state` unchanged with no prefix (so
 * the serve-direct render is bit-for-bit what it always was).
 *
 * Prefixes EXACTLY ONCE: an app-path that already starts with the prefix is
 * returned untouched, so a double application (a caller that threads the
 * prefix AND a pre-prefixed path) cannot produce `/ext/se/ext/se/state`.
 * A non-absolute path (already relative, or a full URL, or a '#fragment') is
 * returned unchanged -- it does not resolve against the origin root, so it was
 * never broken by being mounted.
 *
 * ES5-only on purpose (`var`/`function`, no template literals, no closures over
 * module scope): this function is ALSO shipped to the browser verbatim via
 * `.toString()` inside dashboard.mjs's inline page scripts, where
 * renderSprintSection() calls it to build each live-refreshed row's links.
 *
 * @param {string} mountPrefix - sanitizeMountPrefix()/resolveMountPrefix() output, or ''
 * @param {string} appPath - an absolute app-path, e.g. '/sprints/x/live'
 * @returns {string}
 */
export function mountHref(mountPrefix, appPath) {
    var prefix = typeof mountPrefix === 'string' ? mountPrefix : '';
    var path = typeof appPath === 'string' ? appPath : '';
    if (prefix.length === 0) return path;
    if (path.length === 0 || path.charAt(0) !== '/') return path;
    if (path === prefix || path.slice(0, prefix.length + 1) === prefix + '/') return path;
    return prefix + path;
}
