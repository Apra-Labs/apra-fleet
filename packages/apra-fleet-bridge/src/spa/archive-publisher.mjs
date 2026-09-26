// archive-publisher.mjs -- the I/O half of the D1 archive SPA.
//
// `spa/archive.mjs` is pure: it turns a terminal sprint state into a list
// of `{ path, contentType, body }` files and does no I/O at all, precisely
// so the same bundle can be written to disk or uploaded to blob storage.
// This module is the blob-storage half, and it is deliberately the ONLY
// thing standing between that pure builder and a real container.
//
// WHY FINALIZE IS THE CALL SITE (a decision, recorded because the design
// only half-states it): the implementation plan says "At `finalize`, export
// the terminal sprint as a self-contained static site", and names the
// layout `<container>/sprints/<sprintId>/`. It does not say what happens
// when the upload fails, nor who supplies the extensions, so those two are
// this package's choices -- see `publish()` below and verbs/finalize.mjs's
// archive step for each one's reasoning.
//
// WHY BLOCK BLOBS, NOT APPEND BLOBS: an archive file is written once, whole.
// The 50,000-append cap and the appendpos protocol that dominate
// `sinks/append-blob.mjs` are irrelevant here; `putBlockBlob` overwrites,
// which is exactly right for re-running finalize against the same sprint.
//
// WHY UPLOAD FAILURE IS DATA, NOT A THROW: by the time this runs, the
// sprint is over and its carry-over has already been published. Failing
// finalize -- and therefore the pipeline -- because a storage account was
// unreachable would turn a cosmetic loss (no shareable archive page) into a
// loud, misleading sprint failure. But a failure that is merely swallowed
// is the pattern this package keeps getting bitten by, so `publish()`
// returns a structured, per-file account of exactly what landed and what
// did not, and the caller is required to surface it. Nothing here decides
// it is acceptable; it only refuses to decide it is fatal.
//
// `ok` / `indexUrl` / `partial`, and why they are three separate facts, not
// one: `indexUrl` is set if and only if index.html ITSELF uploaded
// successfully (never inferred from the overall upload count -- a transient
// 5xx on index.html plus every other file succeeding must never report a
// link to a page that was never written). `ok` is exactly `indexUrl !==
// null`: an operator's real question is "do I have a working archive link",
// and a single dropped auxiliary asset (a screenshot, an activity blob) must
// not withhold an otherwise-good link over that question. `partial` is the
// narrower fact "the link is good, but something else did not make it" --
// `ok && failures.length > 0` -- for a consumer that wants to say so without
// treating it as the same failure as a missing index.
//
// SECRETS: the SAS lives only in this closure, is handed to the injected
// http layer on every call, and never appears in a returned field, a log
// message, or the `baseUrl` this module reports. `baseUrl` is deliberately
// the unsigned URL -- it is meant to be pasted into a work-item comment,
// and a signed one pasted there would be a credential leak with a
// multi-hour lifetime.
//
// INJECTED I/O ONLY: no fetch, no fs. `http` is `sinks/append-blob-http.mjs`'s
// client, reused rather than reimplemented so there is one place that knows
// how a blob URL is built.
//
// ERROR RULE: the only throws here are BridgeError, and only for a missing
// or malformed construction dependency.

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';
import { buildArchiveBundle } from './archive.mjs';

/** Where an archived sprint lives inside the container -- pinned by the implementation plan's D1 layout. */
export const ARCHIVE_PREFIX = 'sprints';

function safeMessage(err) {
  return err && err.message ? err.message : String(err);
}

function normalizeLogger(logger) {
  const base = logger && typeof logger === 'object' ? logger : {};
  const wrap = (fn) => (typeof fn === 'function' ? (msg) => { try { fn(msg); } catch { /* logging must never break a publish */ } } : () => {});
  return { info: wrap(base.info), warn: wrap(base.warn), error: wrap(base.error) };
}

/**
 * @param {object} deps
 * @param {string} deps.accountUrl
 * @param {string} deps.containerName
 * @param {string} deps.sas - closure-only; never returned or logged.
 * @param {{ putBlockBlob: Function }} deps.http - injected; see `sinks/append-blob-http.mjs`.
 * @param {Array<object>} [deps.extensions] - dashboard extensions, passed straight through to
 *   `buildArchiveBundle` as data (this module never names one -- see archive.mjs's DOMAIN NEUTRALITY note).
 * @param {{ info?: Function, warn?: Function, error?: Function }} [deps.logger]
 * @returns {{ publish: (args: { sprintId: string, state: object }) => Promise<object> }}
 * @throws {BridgeError} CONFIG_MISSING / CONFIG_INVALID
 */
export function createArchivePublisher(deps = {}) {
  const { accountUrl, containerName, sas, http, extensions = [], logger } = deps;

  for (const [name, value] of [['accountUrl', accountUrl], ['containerName', containerName], ['sas', sas]]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, `createArchivePublisher requires a non-empty ${name}`, { field: name });
    }
  }
  if (!http || typeof http.putBlockBlob !== 'function') {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'createArchivePublisher requires an injected http with putBlockBlob()', {});
  }
  if (!Array.isArray(extensions)) {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, 'createArchivePublisher: extensions, when provided, must be an array', {});
  }

  const log = normalizeLogger(logger);
  const base = String(accountUrl).replace(/\/+$/, '');

  return {
    /**
     * Build and upload one finished sprint's archive bundle. Never throws:
     * every outcome, including "the state was unusable" and "every upload
     * failed", comes back as data for the caller to report.
     *
     * @param {{ sprintId: string, state: object }} args
     * @returns {Promise<{
     *   attempted: number, uploaded: number,
     *   failures: Array<{ path: string, reason: string }>,
     *   indexUrl: string|null, ok: boolean, partial: boolean, error: string|null,
     * }>}
     */
    async publish({ sprintId, state } = {}) {
      const empty = { attempted: 0, uploaded: 0, failures: [], indexUrl: null, ok: false, partial: false, error: null };
      if (typeof sprintId !== 'string' || sprintId.length === 0) {
        return { ...empty, error: 'archive: no sprintId was supplied; nothing was uploaded' };
      }

      let files;
      try {
        ({ files } = buildArchiveBundle({ state, extensions }));
      } catch (err) {
        // A malformed terminal state is worth reporting, never worth
        // failing an otherwise-successful finalize over.
        return { ...empty, error: `archive: could not build the bundle: ${safeMessage(err)}` };
      }

      const prefix = `${ARCHIVE_PREFIX}/${encodeURIComponent(sprintId)}`;
      const failures = [];
      let uploaded = 0;
      let indexPublished = false;

      for (const file of files) {
        const blobName = `${prefix}/${file.path}`;
        let status = null;
        let reason = null;
        try {
          // eslint-disable-next-line no-await-in-loop
          const res = await http.putBlockBlob({
            accountUrl, containerName, sas, blobName, body: file.body, contentType: file.contentType,
          });
          status = res && res.status;
          if (typeof status === 'number' && status >= 200 && status < 300) {
            uploaded += 1;
            // Track index.html's OWN outcome, not just that SOMETHING
            // uploaded -- see this module's header and the reviewer note
            // this fixes: a transient failure on index.html plus every
            // other file succeeding must never report a link to a page
            // that was never written.
            if (file.path === 'index.html') indexPublished = true;
            continue;
          }
          reason = `status ${status}`;
        } catch (err) {
          reason = safeMessage(err);
        }
        failures.push({ path: file.path, reason });
      }

      // The unsigned URL, on purpose -- see this module's header. Keyed on
      // indexPublished (index.html's own upload outcome), never on the
      // overall file count.
      const indexUrl = indexPublished ? `${base}/${containerName}/${prefix}/index.html` : null;

      // `ok` answers the question an operator actually has: "is there a
      // working archive link". It is deliberately NOT "did every last
      // auxiliary asset also upload" -- a dropped screenshot or activity
      // blob is a real, worth-logging gap, but it must not suppress a
      // perfectly good index link (the inverse of the bug above: previously
      // `ok` required `failures.length === 0`, so one missing auxiliary
      // file silently withheld an otherwise-usable link). `partial` carries
      // the narrower "index is fine, but something else is missing" fact
      // for any consumer that wants to say so explicitly.
      const ok = indexPublished;
      const partial = ok && failures.length > 0;

      if (!ok) {
        log.error(`archive: index.html failed to upload for sprint ${sprintId} (${uploaded}/${files.length} other file(s) uploaded, ${failures.length} failure(s)) -- no archive link is available`);
      } else if (partial) {
        log.warn(`archive: index published for sprint ${sprintId}, but ${failures.length} of ${files.length} file(s) failed to upload (index itself succeeded): ${failures.map((f) => f.path).join(', ')}`);
      } else {
        log.info(`archive: published ${uploaded} file(s) for sprint ${sprintId}`);
      }

      return {
        attempted: files.length,
        uploaded,
        failures,
        indexUrl,
        ok,
        partial,
        error: null,
      };
    },
  };
}

export default createArchivePublisher;
