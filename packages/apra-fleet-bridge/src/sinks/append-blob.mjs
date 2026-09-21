// The remote, durable append-blob sink -- see the implementation plan's
// Part B sink list and "Append-blob sink specifics"
// (`packages/apra-fleet-se/docs/fleet-bridge-implementation-plan.md`).
//
// WHY THIS FILE IS SHAPED THE WAY IT IS -- read this before changing the
// retry/roll logic:
//
// 1. BATCH, NEVER PER-RECORD. Azure caps an append blob at 50,000 appends
//    total. Over a 48-hour sprint that is one append every ~3.5 seconds; a
//    per-record sink would exhaust that budget and start silently 409'ing
//    mid-sprint. `emit()` only buffers and returns synchronously; a timer
//    (`flushIntervalMs`) flushes the buffer as ONE append, and `flushNow()`
//    lets a caller (`watch.mjs`, at a phase transition) force an early
//    flush so interesting events are not delayed behind the timer.
//
// 2. EXACTLY-ONCE ON RETRY, VIA APPENDPOS. Every append is sent with
//    `x-ms-blob-condition-appendpos` set to this writer's own tracked byte
//    offset. A 412 means the block already landed at that offset (a retry
//    after a network failure, or a replayed flush after a daemon restart)
//    -- it is ABSORBED AS SUCCESS: properties are re-read to resync the
//    cursor, the buffered chunk that was just attempted is dropped (it is
//    already on the blob), and this is logged at info, not treated as a
//    failure. This is what makes "restart without duplicates" a property
//    of the protocol, not hand-rolled bookkeeping.
//
// 3. ROLL BEFORE 409, NOT AFTER. `rollAtBlockCount` (default 45,000, safely
//    under the 50,000 cap) is checked after every successful append; once
//    the blob's committed-block-count reaches it, this sink starts a new
//    `<sprintId>-partN.jsonl` blob and rewrites a block-blob manifest
//    listing every part. `rollAtBlockCount` is a constructor option
//    precisely so a test can force a roll at 2 -- in production this path
//    would otherwise never execute and would rot. An unexpected 409 (this
//    writer's tracking having drifted from the server's truth) is handled
//    the same way, defensively, as a fallback.
//
// 4. 413 SPLITS, 5xx/NETWORK BACKS OFF, BOTH KEEP THE BUFFER. A block over
//    the service's size limit is halved and retried recursively until it
//    fits (or, in the degenerate case of a single record that alone
//    exceeds `maxBlockBytes`, is dropped with a loud `logger.error` --
//    there is no size at which retrying it would ever succeed). A 5xx or a
//    rejected fetch is retried a bounded number of times with a widening
//    backoff (`../throttle.mjs`'s `createBackoff`, reused rather than
//    reimplemented); once exhausted for this flush, the buffer is
//    RETAINED UNCHANGED and the cursor is NOT advanced, so the very next
//    flush (timer or `flushNow()`) tries the identical bytes again --
//    still exactly-once, because appendpos still describes the same
//    boundary.
//
// 5. REDACT BEFORE BUFFERING. Every record is redacted before it is even
//    added to the in-memory buffer, exactly at the point `jsonl-file.mjs`
//    redacts before writing -- so a secret is never one flush away from
//    landing in cloud storage. The SAS itself lives only in this
//    function's closure: it is passed to the http layer on every call and
//    is never assigned to a record, a log line, or the returned cursor.
//
// CROSS-SINK CONSISTENCY (load-bearing, not cosmetic): `jsonl-file.mjs`
// stamps each line with `receivedAt` from its injected `clock.now()`,
// wrapping a non-plain-object redacted record under `{ data: ... }`. A
// planned test asserts this sink's blob content is byte-identical to the
// local JSONL mirror for the same record stream, so `stampAndSerialize()`
// below is a deliberate line-for-line copy of `jsonl-file.mjs`'s emit()
// body. If `jsonl-file.mjs`'s stamping ever changes, this must change with
// it -- there is no shared helper only because sinks/ has none today.
//
// INJECTED I/O ONLY, per this package's rule -- and load-bearing here more
// than anywhere else in the package: this sink is meant to run for up to
// two days. It never touches a real timer. `clock` extends the `now()`
// convention `jsonl-file.mjs` already uses with `setTimeout`/`clearTimeout`,
// because BOTH the periodic flush loop and the 5xx/network backoff delay
// need to schedule work without a real timer existing anywhere -- a fake
// clock in tests can advance instantly and deterministically to whatever
// point makes a given scenario reproducible.
//
// ERROR RULE (build-log.md): the only throws in this file are BridgeError,
// and only for a missing/malformed constructor dependency (CONFIG_MISSING /
// CONFIG_INVALID). Once constructed, `emit()`/`flushNow()`/`stop()` never
// throw: every Azure response status this module does not treat as success
// or as 412-absorbed is handled as data (split, roll, or bounded retry with
// the buffer retained), matching this package's per-sink-isolation
// philosophy (`sinks/index.mjs`'s fan already isolates one sink's failure
// from the rest and from the caller; this sink additionally never hands the
// fan anything to isolate in the first place). A persistently failing
// remote endpoint therefore shows up only as a widening gap between
// `cursor.updatedAt`-style bookkeeping and reality, surfaced by whatever
// reads this sink's stats -- never as a crash of a two-day watch loop.

import { BridgeError, BRIDGE_ERROR_CODES } from '../errors.mjs';
import { createBackoff } from '../throttle.mjs';
import { stampAndSerialize } from './record.mjs';
import { createRedactor } from '../log-safe.mjs';

/** On-disk/in-memory schema version for the cursor this sink exposes. */
export const CURSOR_VERSION = 1;

/** Bounded attempts for a 5xx/network-retryable failure within one flush, before giving up until the next flush. */
export const MAX_RETRY_ATTEMPTS = 3;

/** Bounded forced-roll attempts for an unexpected 409 within one chunk send, before giving up until the next flush. */
export const MAX_FORCED_ROLLS = 1;

function isFn(v) {
  return typeof v === 'function';
}

function safeMessage(err) {
  return err && err.message ? err.message : String(err);
}

function isSuccessStatus(status) {
  return typeof status === 'number' && status >= 200 && status < 300;
}

/**
 * Normalize an injected `logger` (any subset of info/warn/error) to
 * always-callable, never-throwing methods.
 *
 * WHY `redactMessage` IS NOT OPTIONAL HERE: every message this module logs
 * is built from a blob name, a status code, or `safeMessage(err)` -- and
 * that last one is a string this module did not author. A transport error
 * raised by the injected `fetch` can legitimately quote the URL it failed
 * on, and every URL this sink builds carries the SAS. Sending each message
 * through the same redactor the records go through means the SAS cannot
 * reach a log line even along a path nobody anticipated, which is a
 * cheaper guarantee than auditing every future error shape Azure or
 * undici might produce.
 */
function normalizeLogger(logger, redactMessage) {
  const base = logger && typeof logger === 'object' ? logger : {};
  const safe = isFn(redactMessage) ? (msg) => { try { return redactMessage(msg); } catch { return '[unredactable log message]'; } } : (msg) => msg;
  const wrap = (fn) => (isFn(fn) ? (msg) => { try { fn(safe(msg)); } catch { /* logging must never break the sink */ } } : () => {});
  return { info: wrap(base.info), warn: wrap(base.warn), error: wrap(base.error) };
}

/** `<sprintId>.jsonl` for part 1, `<sprintId>-partN.jsonl` for N > 1 -- the naming the roll logic and any reader must agree on. */
export function blobNameForPart(sprintId, partNumber) {
  return partNumber <= 1 ? `${sprintId}.jsonl` : `${sprintId}-part${partNumber}.jsonl`;
}

/** The manifest blob name for a sprint -- one block blob, rewritten whole on every roll. */
export function manifestBlobNameFor(sprintId) {
  return `${sprintId}.manifest.json`;
}


/**
 * @param {object} deps
 * @param {string} deps.accountUrl
 * @param {string} deps.containerName
 * @param {string} deps.sas - lives only in this closure; never stored on the cursor, a record, or a log line.
 * @param {string} deps.sprintId
 * @param {number} [deps.flushIntervalMs] - default 10_000.
 * @param {number} [deps.rollAtBlockCount] - default 45_000 (safely under Azure's 50,000-append cap).
 * @param {number} [deps.maxBlockBytes] - default 4 MiB.
 * @param {object|null} [deps.cursor] - a previously-persisted cursor (this sink's own `get cursor()` shape) to
 *   resume from. When present, the blob is assumed to already exist and is NEVER recreated (creating an
 *   append blob overwrites it). When null, this is a brand-new sprint: the blob and its manifest are created on start.
 * @param {{ createAppendBlob: Function, appendBlock: Function, getProperties: Function, putBlockBlob: Function }} deps.http
 *   - injected; see `append-blob-http.mjs`.
 * @param {{ now: () => string|number, setTimeout: (fn: Function, ms: number) => any, clearTimeout: (id: any) => void }} deps.clock
 *   - injected; no real timers anywhere in this module.
 * @param {(record: any) => any} [deps.redact] - strips secrets before a record is serialized/buffered.
 *   Optional -- when omitted, defaults to `log-safe.mjs`'s `createRedactor()` (key-name +
 *   credential-URL masking), same convention as `jsonl-file.mjs`, so a caller who forgets
 *   this no longer gets NO redaction at all. A value that IS provided but is not a function
 *   is still a caller mistake worth a loud CONFIG_MISSING.
 * @param {{ info?: Function, warn?: Function, error?: Function }} [deps.logger] - defaults to no-ops.
 * @returns {{ start: () => void, emit: (record: any) => void, flushNow: () => Promise<void>, stop: () => Promise<void>, cursor: object }}
 * @throws {BridgeError} CONFIG_MISSING / CONFIG_INVALID
 */
export function createAppendBlobSink(deps = {}) {
  const {
    accountUrl,
    containerName,
    sas,
    sprintId,
    flushIntervalMs = 10_000,
    rollAtBlockCount = 45_000,
    maxBlockBytes = 4 * 1024 * 1024,
    cursor: initialCursor = null,
    http,
    clock,
    redact: redactOpt,
    logger,
  } = deps;

  for (const [name, value] of [['accountUrl', accountUrl], ['containerName', containerName], ['sas', sas], ['sprintId', sprintId]]) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, `createAppendBlobSink requires a non-empty ${name}`, { field: name });
    }
  }
  if (!http || !isFn(http.createAppendBlob) || !isFn(http.appendBlock) || !isFn(http.getProperties) || !isFn(http.putBlockBlob)) {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'createAppendBlobSink requires an injected http with createAppendBlob/appendBlock/getProperties/putBlockBlob', {});
  }
  if (!clock || !isFn(clock.now) || !isFn(clock.setTimeout) || !isFn(clock.clearTimeout)) {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'createAppendBlobSink requires an injected clock with now()/setTimeout()/clearTimeout()', {});
  }
  let redact;
  if (redactOpt === undefined) {
    redact = createRedactor();
  } else if (!isFn(redactOpt)) {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'createAppendBlobSink: redact, when provided, must be a function', {});
  } else {
    redact = redactOpt;
  }
  for (const [name, value] of [['flushIntervalMs', flushIntervalMs], ['rollAtBlockCount', rollAtBlockCount], ['maxBlockBytes', maxBlockBytes]]) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, `createAppendBlobSink requires a positive ${name}`, { field: name, value });
    }
  }
  if (initialCursor !== null && (typeof initialCursor !== 'object' || Array.isArray(initialCursor))) {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, 'createAppendBlobSink: cursor, when provided, must be a plain object', {});
  }

  const log = normalizeLogger(logger, redact);

  // -- mutable state ----------------------------------------------------------

  const resuming = initialCursor !== null;
  let partNumber = resuming && Number.isInteger(initialCursor.partNumber) && initialCursor.partNumber > 0 ? initialCursor.partNumber : 1;
  let blobName = resuming && typeof initialCursor.blobName === 'string' && initialCursor.blobName.length > 0
    ? initialCursor.blobName
    : blobNameForPart(sprintId, partNumber);
  let appendPos = resuming && typeof initialCursor.appendPos === 'number' && Number.isFinite(initialCursor.appendPos)
    ? initialCursor.appendPos
    : 0;
  let committedBlockCount = resuming && typeof initialCursor.committedBlockCount === 'number' && Number.isFinite(initialCursor.committedBlockCount)
    ? initialCursor.committedBlockCount
    : 0;
  // `sealedParts` holds one entry per part this sink has already rolled
  // AWAY from -- never the current/active part, which `writeManifest()`
  // computes live from `partNumber`/`blobName`/`appendPos`/`committedBlockCount`
  // below. Shape is the one build-log.md pins for the manifest (the D1
  // archive SPA reads it): `{ part, blob, bytes, blocks, sealed }`.
  // A resumed cursor's `parts` is filtered to only entries already in that
  // shape -- a pre-existing cursor from before this shape existed carried a
  // flat array of blob-name strings, which is silently dropped here rather
  // than guessed at; the next roll rewrites the manifest correctly regardless.
  let sealedParts = resuming && Array.isArray(initialCursor.parts)
    ? initialCursor.parts
      .filter((p) => p && typeof p === 'object' && !Array.isArray(p) && typeof p.blob === 'string')
      .map((p) => ({ part: p.part, blob: p.blob, bytes: p.bytes, blocks: p.blocks, sealed: true }))
    : [];

  let buffer = []; // array of already-stamped-and-serialized JSON lines, newline-terminated

  // -- health bookkeeping ------------------------------------------------
  //
  // WHY THIS EXISTS AT ALL: `emit()` only buffers, and every flush path
  // above is deliberately non-throwing, so a sink whose every append is
  // 403'ing looks IDENTICAL from the outside to one that is working --
  // `sinks/index.mjs`'s fan counts an emit as a success the moment the
  // record lands in this array. That is precisely the "reported success
  // while doing nothing" shape this package has been bitten by, so the
  // sink itself has to publish whether its writes are actually landing.
  // `health()` is that surface; `sinks/health.mjs` is what escalates it.
  // Nothing here changes a single control-flow decision -- it only
  // records what the existing decisions did.
  let consecutiveFlushFailures = 0;
  let successfulFlushes = 0;
  let lastSuccessAt = null;
  let lastFailureAt = null;
  let lastFailure = null;

  function noteFlushOk() {
    consecutiveFlushFailures = 0;
    successfulFlushes += 1;
    lastSuccessAt = clock.now();
  }

  /** `message` is redacted on the way in: it is often `safeMessage(err)`, whose text this module did not author. */
  function noteFlushFailure(message) {
    consecutiveFlushFailures += 1;
    lastFailureAt = clock.now();
    try {
      lastFailure = redact(String(message));
    } catch {
      lastFailure = '[unredactable failure message]';
    }
  }
  let started = false;
  let stopped = false;
  let initState = resuming ? 'ready' : 'pending'; // 'pending' | 'ready' -- resumed blobs are assumed to already exist
  let timerId = null;
  let flushChain = Promise.resolve();
  const backoff = createBackoff();

  /** A promise that resolves after `ms`, scheduled on the injected clock -- never a real timer. */
  function delay(ms) {
    return new Promise((resolve) => { clock.setTimeout(resolve, ms); });
  }

  function common() {
    return { accountUrl, containerName, sas };
  }

  /** The manifest entry for the CURRENT (not-yet-sealed) part, computed live from mutable state. */
  function currentPartEntry() {
    return { part: partNumber, blob: blobName, bytes: appendPos, blocks: committedBlockCount, sealed: false };
  }

  /** (Re)write the manifest block blob listing every part, in order -- every already-sealed part, then the current one. */
  async function writeManifest() {
    const parts = [...sealedParts, currentPartEntry()];
    const body = JSON.stringify({ version: 1, sprintId, parts });
    try {
      const res = await http.putBlockBlob({ ...common(), blobName: manifestBlobNameFor(sprintId), body, contentType: 'application/json' });
      if (!isSuccessStatus(res.status)) {
        log.error(`append-blob: manifest write for ${sprintId} returned status ${res.status}`);
      }
    } catch (err) {
      log.error(`append-blob: manifest write for ${sprintId} failed: ${safeMessage(err)}`);
    }
  }

  // `ensureInitialized()` is called from two independent places (the
  // fire-and-forget kick-off in `ensureStarted()` and the top of every
  // `doFlushOnce()`), which can overlap before either has set
  // `initState`. `initPromise` de-duplicates concurrent callers onto the
  // SAME in-flight attempt so the blob is never created twice for one
  // sprint; a failed attempt clears it so the next caller starts a fresh
  // attempt rather than being stuck awaiting a settled rejection.
  let initPromise = null;

  /** Create the blob for a brand-new sprint (never called for a resumed cursor -- see file header). */
  function ensureInitialized() {
    if (initState === 'ready') return Promise.resolve();
    if (!initPromise) {
      initPromise = (async () => {
        try {
          const res = await http.createAppendBlob({ ...common(), blobName });
          if (!isSuccessStatus(res.status)) {
            log.error(`append-blob: create blob ${blobName} returned status ${res.status}; will retry on next flush`);
            return;
          }
          await writeManifest();
          initState = 'ready';
        } catch (err) {
          log.error(`append-blob: create blob ${blobName} failed: ${safeMessage(err)}; will retry on next flush`);
        } finally {
          initPromise = null;
        }
      })();
    }
    return initPromise;
  }

  /** Start a new part blob and rewrite the manifest. Returns true on success. */
  async function performRoll() {
    const nextPartNumber = partNumber + 1;
    const nextBlobName = blobNameForPart(sprintId, nextPartNumber);
    try {
      const res = await http.createAppendBlob({ ...common(), blobName: nextBlobName });
      if (!isSuccessStatus(res.status)) {
        log.error(`append-blob: roll to ${nextBlobName} failed (status ${res.status}); staying on ${blobName}`);
        return false;
      }
    } catch (err) {
      log.error(`append-blob: roll to ${nextBlobName} failed: ${safeMessage(err)}; staying on ${blobName}`);
      return false;
    }
    // Seal the part we are rolling AWAY from, capturing its final byte/block
    // counts before they are reset for the new part below.
    sealedParts = [...sealedParts, { part: partNumber, blob: blobName, bytes: appendPos, blocks: committedBlockCount, sealed: true }];
    partNumber = nextPartNumber;
    blobName = nextBlobName;
    appendPos = 0;
    committedBlockCount = 0;
    await writeManifest();
    log.info(`append-blob: rolled ${sprintId} to ${blobName} at committed-block-count ${rollAtBlockCount}`);
    return true;
  }

  /** Absorb a 412: the block already landed. Re-derive the true cursor from the server. */
  async function absorbConditionFailure() {
    try {
      const res = await http.getProperties({ ...common(), blobName });
      if (typeof res.contentLength === 'number') appendPos = res.contentLength;
      if (typeof res.committedBlockCount === 'number') committedBlockCount = res.committedBlockCount;
      log.info(`append-blob: 412 on ${blobName} absorbed as success (already landed); cursor resynced to appendPos=${appendPos}`);
    } catch (err) {
      // Cannot resync -- keep the tracked appendPos as-is. The NEXT attempt will
      // 412 again (harmless, re-absorbed) or succeed if our tracking was in fact right.
      log.warn(`append-blob: 412 on ${blobName} absorbed, but getProperties failed to resync: ${safeMessage(err)}`);
    }
  }

  /**
   * Send exactly `lines` as one block, handling 412/413/409/5xx/network
   * per the file header. Returns `{ ok: true }` when every byte in `lines`
   * is confirmed landed (including "already landed" via 412), or
   * `{ ok: false, remainingLines }` when it must be retried on a later
   * flush (buffer retained, cursor unchanged for those bytes).
   * @param {string[]} lines
   * @param {number} attempt - 5xx/network retry counter for THIS chunk.
   * @param {number} rollsUsed - forced-roll counter for THIS chunk (409 fallback path).
   * @returns {Promise<{ ok: boolean, remainingLines: string[] }>}
   */
  async function sendChunk(lines, attempt = 0, rollsUsed = 0) {
    if (lines.length === 0) return { ok: true, remainingLines: [] };

    const body = lines.join('');
    const bytes = Buffer.byteLength(body, 'utf8');

    let outcome;
    try {
      const res = await http.appendBlock({ ...common(), blobName, body, appendPos });
      outcome = { kind: 'response', res };
    } catch (err) {
      outcome = { kind: 'network-error', err };
    }

    if (outcome.kind === 'network-error') {
      if (attempt + 1 >= MAX_RETRY_ATTEMPTS) {
        log.warn(`append-blob: network error sending ${lines.length} record(s) after ${attempt + 1} attempt(s), giving up until next flush: ${safeMessage(outcome.err)}`);
        return { ok: false, remainingLines: lines };
      }
      await delay(backoff.next());
      return sendChunk(lines, attempt + 1, rollsUsed);
    }

    const { status } = outcome.res;

    if (isSuccessStatus(status)) {
      appendPos += bytes;
      committedBlockCount = typeof outcome.res.committedBlockCount === 'number' ? outcome.res.committedBlockCount : committedBlockCount + 1;
      backoff.reset();
      if (committedBlockCount >= rollAtBlockCount) {
        await performRoll();
      }
      return { ok: true, remainingLines: [] };
    }

    if (status === 412) {
      await absorbConditionFailure();
      // The chunk we just tried is already on the blob -- drop it, do not retry it.
      return { ok: true, remainingLines: [] };
    }

    if (status === 413) {
      if (lines.length === 1) {
        log.error(`append-blob: a single record (${bytes} bytes) exceeds the service block size limit and cannot be split further; dropping it`);
        return { ok: true, remainingLines: [] };
      }
      const mid = Math.ceil(lines.length / 2);
      const first = await sendChunk(lines.slice(0, mid), attempt, rollsUsed);
      if (!first.ok) {
        return { ok: false, remainingLines: [...first.remainingLines, ...lines.slice(mid)] };
      }
      const second = await sendChunk(lines.slice(mid), attempt, rollsUsed);
      return second.ok ? { ok: true, remainingLines: [] } : second;
    }

    if (status === 409) {
      // Defensive fallback: our own committed-block-count tracking should
      // always roll before this happens (see rollAtBlockCount), so this
      // path is for when server truth has drifted from this writer's
      // tracking. Bounded to MAX_FORCED_ROLLS so a persistently wrong
      // container/blob configuration cannot loop forever.
      if (rollsUsed >= MAX_FORCED_ROLLS) {
        log.error(`append-blob: got 409 on ${blobName} after a forced roll; giving up on this chunk until next flush`);
        return { ok: false, remainingLines: lines };
      }
      const rolled = await performRoll();
      if (!rolled) {
        return { ok: false, remainingLines: lines };
      }
      return sendChunk(lines, attempt, rollsUsed + 1);
    }

    // Any other status (5xx, or an unanticipated 4xx) is treated the same
    // as a network error: retry with backoff, buffer retained. This is the
    // fail-safe default -- the appendpos precondition makes a retry safe
    // even if the previous attempt actually landed (it would simply 412).
    if (attempt + 1 >= MAX_RETRY_ATTEMPTS) {
      log.warn(`append-blob: status ${status} sending ${lines.length} record(s) after ${attempt + 1} attempt(s), giving up until next flush`);
      return { ok: false, remainingLines: lines };
    }
    await delay(backoff.next());
    return sendChunk(lines, attempt + 1, rollsUsed);
  }

  /** One flush attempt: drain whatever is currently buffered as a single logical send (which may internally split/roll/retry). Never throws. */
  async function doFlushOnce() {
    try {
      if (initState !== 'ready') {
        await ensureInitialized();
        if (initState !== 'ready') {
          // Leave the buffer for the next attempt -- and count it: a blob
          // that never gets created is the most total form of this sink
          // failing, so it must not be the one case health() calls fine.
          noteFlushFailure(`blob ${blobName} is not initialized yet (create or manifest write has not succeeded)`);
          return;
        }
      }
      // An empty buffer is neither a success nor a failure: a quiet minute
      // must not reset a failure streak that nothing has actually fixed.
      if (buffer.length === 0) return;
      const chunkLines = buffer;
      buffer = [];
      const result = await sendChunk(chunkLines);
      if (!result.ok) {
        // Retain in original order; anything emitted meanwhile goes after.
        buffer = [...result.remainingLines, ...buffer];
        noteFlushFailure(`${result.remainingLines.length} record(s) retained for the next flush (see the append-blob warning above for the status or transport error)`);
      } else {
        noteFlushOk();
      }
    } catch (err) {
      // Should not happen (every branch above is handled), but this sink
      // must never throw out of a flush -- see the file header's error rule.
      log.error(`append-blob: unexpected error during flush: ${safeMessage(err)}`);
      noteFlushFailure(safeMessage(err));
    }
  }

  /**
   * Serialize concurrent flush triggers (timer tick vs. explicit
   * `flushNow()`) so only one append is ever in flight. Named distinctly
   * from the returned `flushNow` method (below) to avoid any ambiguity
   * about which one a reader is looking at -- the method delegates to
   * this.
   */
  function runFlushNow() {
    flushChain = flushChain.then(doFlushOnce, doFlushOnce);
    return flushChain;
  }

  function scheduleNextFlush() {
    if (stopped) return;
    timerId = clock.setTimeout(async () => {
      timerId = null;
      await runFlushNow();
      scheduleNextFlush();
    }, flushIntervalMs);
  }

  function ensureStarted() {
    if (started) return;
    started = true;
    // Fire-and-forget: start() itself stays synchronous, matching
    // sinks/index.mjs's fan, which calls start() without awaiting it.
    void ensureInitialized();
    scheduleNextFlush();
  }

  return {
    name: 'append-blob',

    /** Begin the periodic flush timer (and, for a brand-new sprint, kick off blob/manifest creation). Idempotent. */
    start() {
      ensureStarted();
    },

    /**
     * Redact, stamp and buffer one record. Auto-starts on first use, same
     * convention as `jsonl-file.mjs`. A no-op once `stop()` has been
     * called. Synchronous and non-blocking -- see the file header's
     * "batch, never per-record" rule.
     * @param {any} record
     */
    emit(record) {
      if (stopped) return;
      ensureStarted();
      buffer.push(stampAndSerialize(record, redact, clock));
    },

    /** Force an out-of-band flush now (e.g. at a phase transition), independent of the timer. Never throws. */
    flushNow() {
      return runFlushNow();
    },

    /** Stop the timer and attempt one final best-effort flush. Idempotent. Never throws. */
    async stop() {
      if (stopped) return;
      stopped = true;
      if (timerId !== null) {
        clock.clearTimeout(timerId);
        timerId = null;
      }
      await runFlushNow();
    },

    /**
     * Whether this sink's writes are actually landing -- see the health
     * bookkeeping block above for WHY a sink has to say so itself. Pure
     * read of already-recorded state: calling it never triggers I/O and
     * never changes a decision. Carries no SAS and no record content;
     * `target` is container/blob only, and `lastFailure` has been through
     * the same redactor every record goes through.
     * @returns {{ name: string, healthy: boolean, consecutiveFailures: number,
     *   successfulFlushes: number, pendingRecords: number, lastSuccessAt: any,
     *   lastFailureAt: any, lastFailure: string|null, target: string }}
     */
    health() {
      return {
        name: 'append-blob',
        healthy: consecutiveFlushFailures === 0,
        consecutiveFailures: consecutiveFlushFailures,
        successfulFlushes,
        pendingRecords: buffer.length,
        lastSuccessAt,
        lastFailureAt,
        lastFailure,
        target: `${containerName}/${blobName}`,
      };
    },

    /**
     * The current cursor, safe to persist (e.g. into the handle spool's
     * `sinkCursors`) and to pass back in as `deps.cursor` on restart. NEVER
     * carries the SAS or any record content.
     */
    get cursor() {
      return {
        version: CURSOR_VERSION,
        sprintId,
        blobName,
        partNumber,
        appendPos,
        committedBlockCount,
        parts: [...sealedParts],
      };
    },
  };
}
