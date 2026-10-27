// A minimal KB server stand-in for the http-backed fixture sessions.
//
// It answers only GET <variant>/api/kb/query and GET <variant>/api/kb/list (the
// no-bump read the member owner-tag lookup uses), with one INFERRED entry that
// belongs to a member none of the fixture sessions are. Two variants, chosen
// by the URL path prefix the session's KB config points at:
//   /tagged    the entry carries its tags (owner tag of another member)
//   /untagged  the same entry with no tags field (ownership undecidable)
//   /other-project  a server for a different project: every request is a 409
//              PROJECT_MISMATCH, exactly as kb-server answers a client slug it
//              does not serve
// Every other request (on the first two variants) is a 404: a recorded case that reaches any other route
// fails loudly instead of recording a stand-in's invented answer.
//
// Node builtins only, like the rest of this directory's harness code.

import http from 'node:http';

export const HTTP_FOREIGN_ENTRY_ID = '9d4e7a10-3b2c-4f5e-8a61-2c7d0e9b4f13';
export const HTTP_FOREIGN_OWNER_TAG = 'member:contract-http-foreign-owner';
export const HTTP_STAND_IN_VARIANTS = ['tagged', 'untagged', 'other-project'];

function foreignEntry(withTags) {
  const entry = {
    id: HTTP_FOREIGN_ENTRY_ID,
    type: 'knowledge',
    confidence: 'INFERRED',
    title: 'Widget batching (captured by another member)',
    summary: 'The widget stage batches work per tick; captured by a member outside this session.',
    content: 'The widget stage batches work per tick.',
    source_files: [],
    symbols: [],
    flagged_for_review: false,
    contradiction_of: null,
    stale: false,
  };
  return withTags ? { ...entry, tags: [HTTP_FOREIGN_OWNER_TAG] } : entry;
}

function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://stand-in');
  const [, variant, ...rest] = url.pathname.split('/');
  const route = `/${rest.join('/')}`;
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (variant === 'other-project') {
    send(409, {
      error: 'this KB server serves a different project',
      code: 'PROJECT_MISMATCH',
      server_project: 'contract-other-project',
      client_project: req.headers['x-kb-project'] ?? '(none)',
    });
    return;
  }
  if (req.method === 'GET' && (route === '/api/kb/query' || route === '/api/kb/list') && HTTP_STAND_IN_VARIANTS.includes(variant)) {
    const results = [foreignEntry(variant === 'tagged')];
    send(200, { results, total: results.length });
    return;
  }
  send(404, { error: `kb-http-stand-in has no route ${req.method} ${url.pathname}` });
}

/**
 * Starts the stand-in on a free loopback port.
 * @returns {Promise<{ urlFor: (variant: string) => string, close: () => Promise<void> }>}
 */
export async function startKbHttpStandIn() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => handle(req, res));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    urlFor: (variant) => {
      if (!HTTP_STAND_IN_VARIANTS.includes(variant)) {
        throw new Error(`kb-http-stand-in: unknown variant "${variant}" (expected ${HTTP_STAND_IN_VARIANTS.join(' or ')})`);
      }
      return `http://127.0.0.1:${port}/${variant}`;
    },
    // closeAllConnections: a keep-alive client socket would otherwise hold close() open.
    close: () => new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
