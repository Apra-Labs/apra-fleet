/**
 * Local model proxy. Claude Code talks to this (ANTHROPIC_BASE_URL); this
 * talks to the real API. Works with API keys and subscription logins alike
 * -- auth headers are forwarded untouched.
 *
 * Fails closed: if a request cannot be scrubbed it is refused, never sent.
 */
import http from 'node:http';
import https from 'node:https';
import { Redactor, SseRestorer, type ScrubEvent } from './redact.js';

export interface ProxyDeps {
  upstream: string;
  redactor: () => Redactor;
  onEvents?: (events: ScrubEvent[]) => void;
  onError?: (message: string) => void;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'content-length', 'accept-encoding']);

function refuse(res: http.ServerResponse, status: number, message: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `lazyfleet: ${message}` } }));
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function isMessagesPath(url: string): boolean {
  return /^\/v1\/messages(?:\/count_tokens)?(?:\?|$)/.test(url);
}

export function createProxyHandler(deps: ProxyDeps) {
  const upstream = new URL(deps.upstream);
  const client = upstream.protocol === 'http:' ? http : https;

  return async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch {
      refuse(res, 400, 'could not read request');
      return;
    }

    const redactor = deps.redactor();
    const isJson = /json/i.test(String(req.headers['content-type'] ?? ''));
    if (body.length > 0) {
      if (!isJson) {
        // Only JSON is expected on this API; anything else could carry
        // content we cannot inspect, so it does not leave the machine.
        refuse(res, 415, 'refusing to forward a non-JSON body it cannot check for secrets');
        return;
      }
      try {
        const parsed = JSON.parse(body.toString('utf-8'));
        const events: ScrubEvent[] = [];
        let scrubbed: any;
        if (isMessagesPath(url)) {
          const r = redactor.scrubRequest(parsed);
          scrubbed = r.body;
          events.push(...r.events);
        } else {
          scrubbed = redactor.scrubDeep(parsed, events);
        }
        body = Buffer.from(JSON.stringify(scrubbed), 'utf-8');
        if (events.length) deps.onEvents?.(events);
      } catch (e) {
        deps.onError?.(`scrub failed on ${req.method} ${url}: ${(e as Error).message}`);
        refuse(res, 500, 'could not check this request for secrets, so it was not sent');
        return;
      }
    }

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
    }
    headers.host = upstream.host;
    // Compressed responses would hide tool calls from the restorer.
    headers['accept-encoding'] = 'identity';
    if (body.length > 0 || req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      headers['content-length'] = body.length;
    }

    const basePath = upstream.pathname.replace(/\/$/, '');
    const upReq = client.request(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || undefined,
        path: basePath + url,
        method: req.method,
        headers,
      },
      upRes => relayResponse(upRes, res, redactor, url, deps),
    );
    upReq.on('error', e => {
      deps.onError?.(`upstream error: ${e.message}`);
      refuse(res, 502, `could not reach ${upstream.host}: ${e.message}`);
    });
    req.on('close', () => {
      if (!res.writableFinished) upReq.destroy();
    });
    upReq.end(body);
  };
}

function relayResponse(
  upRes: http.IncomingMessage,
  res: http.ServerResponse,
  redactor: Redactor,
  url: string,
  deps: ProxyDeps,
): void {
  const ctype = String(upRes.headers['content-type'] ?? '');
  const headers: http.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(upRes.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase()) && v !== undefined) headers[k] = v;
  }
  const encoded = upRes.headers['content-encoding'] && upRes.headers['content-encoding'] !== 'identity';

  if (!isMessagesPath(url) || encoded) {
    if (encoded && isMessagesPath(url)) deps.onError?.('upstream sent a compressed reply; tool calls were not restored');
    res.writeHead(upRes.statusCode ?? 502, headers);
    upRes.pipe(res);
    return;
  }

  if (/text\/event-stream/i.test(ctype)) {
    res.writeHead(upRes.statusCode ?? 200, headers);
    res.flushHeaders();
    const restorer = new SseRestorer(redactor);
    upRes.setEncoding('utf-8');
    upRes.on('data', (chunk: string) => {
      const out = restorer.push(chunk);
      if (out) res.write(out);
    });
    upRes.on('end', () => res.end(restorer.end()));
    upRes.on('error', () => res.destroy());
    res.on('close', () => upRes.destroy());
    return;
  }

  const chunks: Buffer[] = [];
  upRes.on('data', c => chunks.push(c));
  upRes.on('end', () => {
    let buf = Buffer.concat(chunks);
    if (/json/i.test(ctype) && (upRes.statusCode ?? 0) < 300) {
      try {
        buf = Buffer.from(JSON.stringify(redactor.restoreResponse(JSON.parse(buf.toString('utf-8')))), 'utf-8');
      } catch {
        // Not the shape we expected; hand it over as-is.
      }
    }
    headers['content-length'] = buf.length;
    res.writeHead(upRes.statusCode ?? 502, headers);
    res.end(buf);
  });
  upRes.on('error', () => res.destroy());
}
