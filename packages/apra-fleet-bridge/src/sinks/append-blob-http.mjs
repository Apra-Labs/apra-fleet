// A thin REST layer over Azure "Append Blob" operations, with an INJECTED
// fetch -- see the implementation plan's "Append-blob sink specifics" and
// Part D's storage notes (`packages/apra-fleet-se/docs/fleet-bridge-implementation-plan.md`).
//
// The Azure facts this file is built against (verified against the REST
// reference, not re-derived here):
//   - `PUT ...?comp=appendblock` appends a block; the data is immediately
//     readable.
//   - The binding limit is append COUNT: 50,000 per blob. Exceeding it
//     returns 409.
//   - Block size limit (4 MiB / 100 MiB depending on service version).
//     Oversized -> 413.
//   - `x-ms-blob-condition-appendpos` is the byte offset the client expects
//     to append at; mismatch -> 412. This is the documented single-writer
//     idiom: a client uses it to tell whether an append succeeded despite a
//     network failure.
//   - Every response carries `x-ms-blob-append-offset` and
//     `x-ms-blob-committed-block-count`.
//
// THIS MODULE DOES NO POLICY. Every HTTP status -- 2xx, 409, 412, 413, 5xx,
// or anything else -- is returned as plain data (`{ status, ... }`), never
// thrown. `append-blob.mjs` is the only place that decides what a status
// means (retry, absorb, split, roll). The one thing NOT returned as data is
// a genuine transport failure: if the injected `fetch` itself rejects (DNS,
// TCP reset, timeout), that rejection is left to propagate as-is, exactly
// like `supervisor-client.mjs`'s raw network errors -- the caller is
// expected to catch it and treat it as retryable.
//
// Responses are parsed into plain headers/fields here (never handed back as
// raw Response objects) so the sink layer stays testable against a plain
// object shape rather than a fetch Response mock.
//
// INJECTED I/O ONLY, per this package's rule: no real fetch, no `node:fs`.
// The SAS is passed through on every call and never stored, logged, or
// echoed back in any returned field.
//
// ERROR RULE (build-log.md): the only throws in this file are BridgeError,
// and only for a missing injected dependency at construction time
// (CONFIG_MISSING). An HTTP response status is data, never a defect, so it
// is never a throw site.

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';

/** Read a numeric response header, tolerating absence or a non-numeric value. */
function headerNumber(headers, name) {
  if (!headers || typeof headers.get !== 'function') return null;
  const raw = headers.get(name);
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Read a string response header, tolerating absence. */
function headerString(headers, name) {
  if (!headers || typeof headers.get !== 'function') return null;
  const raw = headers.get(name);
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Build a blob URL: `<accountUrl>/<containerName>/<blobName>?<query>&<sas>`.
 * `sas` may or may not carry a leading '?' or '&' -- normalized here so
 * callers can pass either a raw query string or one already prefixed.
 * @param {{ accountUrl: string, containerName: string, blobName: string, sas: string, query?: string }} parts
 * @returns {string}
 */
function blobUrl({ accountUrl, containerName, blobName, sas, query }) {
  const base = String(accountUrl || '').replace(/\/+$/, '');
  const parts = [];
  if (query) parts.push(query);
  if (sas) parts.push(String(sas).replace(/^[?&]+/, ''));
  const qs = parts.length > 0 ? `?${parts.join('&')}` : '';
  return `${base}/${containerName}/${blobName}${qs}`;
}

/** Read a fetch Response's body once, tolerating a fake that has no `text()`. Never throws. */
async function readBody(res) {
  if (!res || typeof res.text !== 'function') return '';
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Normalize a fetch Response (or Response-like fake) into the plain shape
 * every method below returns. `status` is always present; the rest are
 * `null` when the response did not carry that header (e.g. an error
 * response with no append-specific headers at all).
 * @param {{ status: number, headers?: { get: (name: string) => string|null }, text?: () => Promise<string> }} res
 */
async function toResult(res) {
  const headers = res && res.headers;
  return {
    status: res ? res.status : 0,
    appendOffset: headerNumber(headers, 'x-ms-blob-append-offset'),
    committedBlockCount: headerNumber(headers, 'x-ms-blob-committed-block-count'),
    contentLength: headerNumber(headers, 'content-length'),
    errorCode: headerString(headers, 'x-ms-error-code'),
    body: await readBody(res),
  };
}

/**
 * Create the Azure Append Blob REST client.
 *
 * @param {object} deps
 * @param {(url: string, init: { method: string, headers?: Record<string,string>, body?: any }) => Promise<any>} deps.fetch
 *   - injected; a fetch-like function. No default -- unlike
 *   `supervisor-client.mjs`, there is no legitimate "talk to the real
 *   Azure endpoint by accident" default in a build with zero live
 *   credentials, so this is required, not merely preferred.
 * @returns {{
 *   createAppendBlob: (args: { accountUrl: string, containerName: string, blobName: string, sas: string }) => Promise<object>,
 *   appendBlock: (args: { accountUrl: string, containerName: string, blobName: string, sas: string, body: string, appendPos: number|null }) => Promise<object>,
 *   getProperties: (args: { accountUrl: string, containerName: string, blobName: string, sas: string }) => Promise<object>,
 *   putBlockBlob: (args: { accountUrl: string, containerName: string, blobName: string, sas: string, body: string, contentType?: string }) => Promise<object>,
 * }}
 * @throws {BridgeError} CONFIG_MISSING when `fetch` is not a function
 */
export function createAppendBlobHttp(deps = {}) {
  const fetchImpl = deps.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'createAppendBlobHttp requires an injected fetch', {});
  }

  /**
   * `PUT` with `x-ms-blob-type: AppendBlob` -- creates a fresh, empty
   * append blob (Azure semantics: this OVERWRITES any existing blob of the
   * same name, which is exactly why `append-blob.mjs` must call this only
   * for a brand-new sprint, never on a resumed cursor).
   */
  async function createAppendBlob({ accountUrl, containerName, blobName, sas }) {
    const url = blobUrl({ accountUrl, containerName, blobName, sas });
    const res = await fetchImpl(url, {
      method: 'PUT',
      headers: { 'x-ms-blob-type': 'AppendBlob', 'Content-Length': '0' },
    });
    return toResult(res);
  }

  /**
   * `PUT ...?comp=appendblock`. `appendPos` is sent as
   * `x-ms-blob-condition-appendpos` whenever it is a number (including 0);
   * omitted entirely when null/undefined, which lets a caller deliberately
   * append unconditionally if it ever needs to (not used by the sink
   * today, which always sends a position).
   */
  async function appendBlock({ accountUrl, containerName, blobName, sas, body, appendPos }) {
    const url = blobUrl({ accountUrl, containerName, blobName, sas, query: 'comp=appendblock' });
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (typeof appendPos === 'number' && Number.isFinite(appendPos)) {
      headers['x-ms-blob-condition-appendpos'] = String(appendPos);
    }
    const res = await fetchImpl(url, { method: 'PUT', headers, body });
    return toResult(res);
  }

  /**
   * `HEAD` (Get Blob Properties) -- used after a 412 to re-derive the true
   * committed length/block-count when this writer's own tracking might be
   * stale (a retry after a network failure, or a replayed flush after a
   * daemon restart).
   */
  async function getProperties({ accountUrl, containerName, blobName, sas }) {
    const url = blobUrl({ accountUrl, containerName, blobName, sas });
    const res = await fetchImpl(url, { method: 'HEAD' });
    return toResult(res);
  }

  /**
   * `PUT` with `x-ms-blob-type: BlockBlob` -- (re)writes the manifest that
   * lists every part blob for a sprint. Block blobs have no append-count
   * cap, so a full overwrite on every roll is fine.
   */
  async function putBlockBlob({ accountUrl, containerName, blobName, sas, body, contentType }) {
    const url = blobUrl({ accountUrl, containerName, blobName, sas });
    const res = await fetchImpl(url, {
      method: 'PUT',
      headers: { 'x-ms-blob-type': 'BlockBlob', 'Content-Type': contentType || 'application/json' },
      body,
    });
    return toResult(res);
  }

  return { createAppendBlob, appendBlock, getProperties, putBlockBlob };
}
