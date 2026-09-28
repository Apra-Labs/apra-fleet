// apra-fleet-i9ag.15.14: single shared definition of "attempt a competing
// HTTP listen() on a port a viewer/server already owns" -- previously
// duplicated near-verbatim as tryBind() in
// apra-fleet-workflow-viewer-bind-exclusivity.test.mjs and
// tryRivalLoopbackBind() in apra-fleet-workflow-bead-description.test.mjs,
// identical bodies differing only in whether the caller passed a bare port
// or a full listen-options object. This is the options-taking (general)
// form; a caller that only has a port passes `{ port, host: '127.0.0.1' }`.
//
// Resolves `{ code: 'EADDRINUSE', close }` when the rival bind was correctly
// refused (the exclusive-bind contract holding), or `{ code: null, close }`
// when the rival's bind unexpectedly succeeded (the silent port-hijack
// condition apra-fleet-i9ag.15.9 fixed) -- `close` always tears the rival
// listener down either way.
import http from 'http';

export function tryRivalBind(opts) {
    return new Promise((resolve) => {
        const rival = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
        rival.once('error', (err) => resolve({ code: err.code, close: async () => {} }));
        rival.listen(opts, () => resolve({
            code: null,
            close: () => new Promise((done) => rival.close(done))
        }));
    });
}
