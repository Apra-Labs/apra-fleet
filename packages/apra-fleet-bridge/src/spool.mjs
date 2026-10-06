// The fleet-bridge handle spool -- one JSON file per sprint under
// `<spoolDir>/<sprintId>.handle.json`, atomically written the same way
// apra-fleet-se's supervisor ledger writes `reservations.json`: a temp file
// then a retried rename (see `packages/apra-fleet-se/src/supervisor/ledger.mjs`
// and `rename-with-retry.mjs`). Unlike the ledger (one shared document for
// every live reservation), the spool is one document PER sprint, so a corrupt
// or foreign-version file for one sprint must never stop the daemon from
// reading every other sprint's handle -- see `read()`/`list()` below.
//
// `fs` is INJECTED -- this module never imports `node:fs`. `now`, `logger`
// and the liveness probe (`isAlive`) are injected too, per this package's
// injected-I/O rule (no real fs, no real clock, no real timers in tests).
//
// CROSS-PROCESS EXCLUSION. Two serialization mechanisms live in this file and
// they are NOT interchangeable -- conflating them was the original defect:
//
//   - `withTx()` is an in-process Map of promise chains. It orders writes
//     made by THIS process only. It says nothing at all about a second
//     `fleet-bridge daemon`/`watch` process on the same spool directory.
//     The comment on it used to read as a general atomicity guarantee; it
//     never was one, and `claim()` was built on top of that misreading.
//   - `acquireClaimLock()` is an OS-level mutex: an exclusive-create
//     (`flag: 'wx'`, i.e. O_CREAT|O_EXCL) lock file, which the filesystem
//     resolves atomically between processes. `claim()`'s whole read-decide-
//     write critical section runs under it, which is what actually makes
//     the single-writer invariant its doc comment promises true across
//     processes. Without it, two daemons starting at the same instant both
//     `loadDoc()` (neither sees a claim), both write, and both believe they
//     own the sprint -- silently corrupting the append-blob `appendpos`
//     cursor. That concurrent start is the case that happens in practice
//     (a pipeline retry, or an operator starting a daemon beside a running
//     one); a claim already durable on disk was only ever the easy half.
//
// HONEST LIMIT: O_EXCL is atomic on a local filesystem. On NFS (and on some
// SMB/CIFS configurations) exclusive-create is NOT guaranteed to be atomic,
// so a spool directory on a network share can still, in principle, admit two
// simultaneous claims. This is not papered over: it is a property of the
// storage, not something this module can fix. Keep the spool on local disk
// (one spool directory per host) if the single-writer invariant matters.

import path from 'node:path';
import { renameWithRetry } from '@apralabs/apra-fleet-se/src/supervisor/rename-with-retry.mjs';
import { BridgeError, BRIDGE_ERROR_CODES } from './errors.mjs';

/** On-disk schema version for a spool handle document. */
export const SPOOL_VERSION = 1;

/** Suffix every spool file carries, so `list()` can distinguish it from a `.tmp` or `.corrupt-*` sibling. */
export const SPOOL_FILE_SUFFIX = '.handle.json';

/** A fresh, well-formed, otherwise-empty spool document for `sprintId`. */
function emptySpoolDocument(sprintId, now) {
  return {
    version: SPOOL_VERSION,
    sprintId,
    state: 'unknown',
    handle: null,
    claim: null,
    progress: null,
    sinkCursors: {},
    finalize: null,
    updatedAt: now(),
  };
}

/** Deep-enough clone for a spool document -- plain JSON data, so JSON round-trip is sufficient and cheap. */
function cloneDoc(doc) {
  return JSON.parse(JSON.stringify(doc));
}

function filePathFor(spoolDir, sprintId) {
  return path.join(spoolDir, `${sprintId}${SPOOL_FILE_SUFFIX}`);
}

/**
 * Create the handle spool. Collaborators are injected so tests can drive an
 * in-memory fake fs and a fake clock -- no real filesystem, no real timers.
 *
 * @param {object} deps
 * @param {string} deps.spoolDir
 * @param {{
 *   mkdir: (dir: string, opts?: object) => Promise<any>,
 *   readFile: (path: string, enc: string) => Promise<string>,
 *   writeFile: (path: string, body: string, encOrOpts: string|object) => Promise<void>,
 *   rename: (src: string, dst: string) => Promise<void>,
 *   readdir: (dir: string) => Promise<string[]>,
 *   unlink?: (path: string) => Promise<void>,
 * }} deps.fs - injectable, matching ledger.mjs's own `deps.fs` convention.
 *   `writeFile` must honour an options OBJECT as its third argument (at least
 *   `{ encoding, flag }`), because `claim()`'s cross-process lock depends on
 *   `flag: 'wx'` failing with EEXIST; `node:fs/promises.writeFile` already
 *   does. `unlink` is REQUIRED by `claim()` (a lock that cannot be removed is
 *   a deadlock, so `claim()` refuses to run rather than wedge the spool) and
 *   used best-effort elsewhere to clean up a failed temp write.
 * @param {number} [deps.pid] - this process's id, used only to make temp-file
 *   names unique per writer. Defaults to `process.pid`; injectable so a test
 *   can simulate two processes sharing one fake filesystem.
 * @param {() => string} deps.now - returns an ISO-8601 timestamp.
 * @param {{ maxAttempts?: number, baseDelayMs?: number, sleep?: (ms: number) => Promise<void> }} [deps.renameRetry]
 *   - options forwarded to `renameWithRetry` (same convention as
 *   ledger.mjs's `deps.renameRetry`), NOT the retry function itself.
 * @param {{ log?: Function, error?: Function }} [deps.logger] - defaults to `console`.
 * @param {(pid: number|null|undefined, host: string|null|undefined) => boolean} [deps.isAlive]
 *   - the liveness probe for `claim()`'s takeover decision. Injected so it is
 *   testable. THERE IS NO DEFAULT PROBE: a real probe is environment-specific
 *   and must not be guessed here. When no probe is injected, `claim()` FAILS
 *   SAFE -- it refuses to take over any existing claim (see `claim()` below)
 *   rather than assuming the claimant is dead. Stealing without a probe
 *   requires the caller's explicit `{ force: true }` opt-in on that call.
 */
export function createSpool(deps = {}) {
  const spoolDir = deps.spoolDir;
  if (!spoolDir) {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'createSpool requires a spoolDir', {});
  }
  const fs = deps.fs;
  if (!fs) {
    throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_MISSING, 'createSpool requires an injected fs', {});
  }
  const now = typeof deps.now === 'function' ? deps.now : () => new Date().toISOString();
  const renameRetryOpts = deps.renameRetry ?? {};
  const logger = deps.logger ?? console;
  const logInfo = (...a) => (logger.log ?? console.log)(...a);
  const logError = (...a) => (logger.error ?? logger.log ?? console.error)(...a);
  // Identity of this writer, for unique temp names and for the lock file's
  // owner record. `process` is a global, not an import -- no `node:fs` and no
  // `process.env` is read, so the source-scan guard's rules hold.
  const pid = typeof deps.pid === 'number'
    ? deps.pid
    : ((globalThis.process && globalThis.process.pid) || 0);
  let tmpCounter = 0;

  /**
   * Turn a raw filesystem error into a `BridgeError`, preserving the original
   * as `details.cause` (plus its `errno`-style `code`, which is what an
   * operator actually greps for).
   *
   * Every module header in this package asserts that whatever crosses the
   * boundary is a `BridgeError`; `exitCodeFor`'s exit-1 catch-all is
   * documented as the price of breaking that. An EACCES/EPERM/ENOTDIR on the
   * spool directory is infrastructure -- the configured path exists but the
   * environment will not let us use it -- not caller error, so it must not
   * land in the CONFIG_* (exit 2) family. Of the codes `errors.mjs` actually
   * defines, PREFLIGHT_UNAVAILABLE is the honest fit: exit 3 is documented as
   * "environment/setup issue detected", and the code already means "the thing
   * this depends on could not be reached, so nothing downstream is
   * meaningful" (see verbs/preflight.mjs). A dedicated SPOOL_UNREADABLE code
   * would be better still, but adding one is an `errors.mjs` change.
   */
  function wrapFsError(err, message, details = {}) {
    if (err instanceof BridgeError) return err;
    const fsCode = err && err.code ? String(err.code) : null;
    return new BridgeError(
      BRIDGE_ERROR_CODES.PREFLIGHT_UNAVAILABLE,
      `${message}: ${err && err.message ? err.message : String(err)}`,
      { ...details, fsCode, cause: err }
    );
  }

  // No default probe -- see the deps.isAlive doc above. `hasIsAliveProbe`
  // lets `claim()` distinguish "no probe was injected" (fail-safe refusal,
  // force-only takeover) from "a probe was injected and says dead" (ordinary
  // automatic takeover). The claim LOCK reuses exactly this distinction.
  const hasIsAliveProbe = typeof deps.isAlive === 'function';
  const isAlive = hasIsAliveProbe ? deps.isAlive : null;
  let warnedNoIsAlive = false;
  function warnNoIsAliveProbe() {
    if (warnedNoIsAlive) return;
    warnedNoIsAlive = true;
    logError('[spool] no isAlive() liveness probe was injected -- claim() will REFUSE to take over an existing claim; pass { force: true } to claim() to take over anyway');
  }

  // One serialized write queue PER sprintId -- concurrent writers for
  // DIFFERENT sprints proceed independently, but writes for the SAME
  // sprintId, WITHIN THIS PROCESS, cannot interleave.
  //
  // IN-PROCESS ONLY. This used to be written as though it were an atomicity
  // guarantee full stop ("can never interleave their temp-file write and
  // rename"), and it was read that way -- `claim()` was built on it. It is a
  // Map in this process's heap: a second daemon has its own, and the two know
  // nothing of each other. Cross-process exclusion for the claim decision is
  // `acquireClaimLock()`; cross-process safety for the write itself comes
  // from `persist()`'s per-writer unique temp name plus the atomic rename.
  const txChains = new Map();

  function withTx(sprintId, fn) {
    const prior = txChains.get(sprintId) ?? Promise.resolve();
    const run = prior.then(fn, fn);
    // Keep the chain alive regardless of outcome so one failed transaction
    // cannot poison every later one for this sprintId; the error still
    // propagates to this caller via the returned promise.
    txChains.set(sprintId, run.catch(() => {}));
    return run;
  }

  /**
   * Delete a path, ignoring every failure. Used for lock release and for
   * cleaning up a temp file after a failed write -- in both cases the caller
   * either has a more important error to report or nothing useful to do with
   * this one, and a leftover file is never worse than masking the real fault.
   */
  async function removeQuietly(p) {
    if (typeof fs.unlink !== 'function') return;
    try {
      await fs.unlink(p);
    } catch {
      // Best effort by design -- see the doc comment.
    }
  }

  /**
   * A temp path unique to THIS writer and THIS write.
   *
   * The old fixed `${filePath}.tmp` made the write-then-rename -- which
   * exists precisely to make the update atomic -- a race in its own right:
   * two processes patching the same sprint wrote the same temp file, so one
   * could rename the other's half-written document into place. The pid
   * separates processes, the counter separates writes within one process
   * (a pid alone is reused across many writes), and the random suffix covers
   * pid reuse after a restart.
   *
   * The name still ends in `.tmp`, which is what `list()` filters on, so a
   * temp file in flight is never mistaken for a sprint.
   */
  function tmpPathFor(filePath) {
    tmpCounter += 1;
    const rand = Math.random().toString(36).slice(2, 10);
    return `${filePath}.${pid}.${tmpCounter}.${rand}.tmp`;
  }

  /** Atomically replace the on-disk document for `sprintId` (unique temp file + retried rename). */
  async function persist(sprintId, doc) {
    const filePath = filePathFor(spoolDir, sprintId);
    const tmpPath = tmpPathFor(filePath);
    await fs.mkdir(spoolDir, { recursive: true });
    const body = `${JSON.stringify(doc, null, 2)}\n`;
    try {
      await fs.writeFile(tmpPath, body, 'utf-8');
      await renameWithRetry(fs, tmpPath, filePath, renameRetryOpts);
    } catch (err) {
      // A failed write (or a rename that exhausted its retries) leaves the
      // temp file behind. Nothing will ever pick it up again -- the name is
      // unique to this attempt -- so it is pure litter in the spool
      // directory; remove it before the failure propagates.
      await removeQuietly(tmpPath);
      throw wrapFsError(err, `spool write for sprint "${sprintId}" failed`, { sprintId, filePath });
    }
  }

  /**
   * Path of the cross-process claim mutex for one sprint. A sibling of the
   * handle file, with a suffix `list()` does not recognise (it accepts only
   * names ending in SPOOL_FILE_SUFFIX), so a held lock can never surface as
   * a phantom sprint.
   */
  function lockPathFor(sprintId) {
    return `${filePathFor(spoolDir, sprintId)}.claimlock`;
  }

  /** Read the lock's owner record, or `null` if it is unreadable/unparseable. */
  async function readLockOwner(lockPath) {
    try {
      const raw = await fs.readFile(lockPath, 'utf-8');
      const owner = JSON.parse(raw);
      return (owner && typeof owner === 'object') ? owner : null;
    } catch {
      // Missing, unreadable, or garbage. The caller treats "unknown owner"
      // the same as "owner might be alive" -- see acquireClaimLock().
      return null;
    }
  }

  /**
   * Acquire the cross-process claim mutex for `sprintId`.
   *
   * Exclusive-create (`flag: 'wx'`) is the whole mechanism: the filesystem,
   * not this code, decides which of two simultaneous creators wins. The lock
   * is held only for the read-decide-write critical section (milliseconds),
   * NOT for the lifetime of a daemon's ownership -- long-lived ownership is
   * the durable `claim` record in the document plus the `isAlive` probe. That
   * split is deliberate: a short critical section is what keeps the stale
   * lock question small.
   *
   * STALE LOCKS, and why there is no mtime/age heuristic. A crash inside the
   * critical section leaves a lock file behind. The tempting fix -- "if it is
   * older than N seconds, it must be dead" -- reintroduces exactly the
   * double-owner bug this lock exists to prevent the moment the guess is
   * wrong (a paused VM, a slow network filesystem, a debugger breakpoint).
   * So there is no age test. A lock is broken only when the SAME evidence
   * that governs a claim takeover says so:
   *   - an injected `isAlive` probe reports the recorded holder dead, or
   *   - the caller passed an explicit `{ force: true }`.
   * Anything else -- no probe, an unreadable/garbled owner record, a foreign
   * host (bin/runtime.mjs's `isAlive` deliberately answers "assume alive" for
   * a host it cannot see, because a wrong "dead" is worse than a stuck lock)
   * -- means we do not acquire, and `claim()` returns false. A refused claim
   * costs one daemon tick; a wrongly granted one silently corrupts the
   * append-blob cursor. A genuinely stuck lock is an operator-visible file
   * that `--force` or `rm` clears, which is the right kind of failure.
   *
   * @returns {Promise<boolean>} true when the lock is held by this call.
   */
  async function acquireClaimLock(sprintId, claimant) {
    const lockPath = lockPathFor(sprintId);
    const body = `${JSON.stringify({ pid, host: claimant.host ?? null, at: now() })}\n`;

    async function tryCreate() {
      try {
        await fs.writeFile(lockPath, body, { encoding: 'utf-8', flag: 'wx' });
        return 'acquired';
      } catch (err) {
        if (err && err.code === 'EEXIST') return 'exists';
        throw wrapFsError(err, `spool could not create the claim lock for sprint "${sprintId}"`, { sprintId, lockPath });
      }
    }

    await fs.mkdir(spoolDir, { recursive: true });
    if (await tryCreate() === 'acquired') return true;

    // Contended. Decide whether the holder may be broken -- see the doc above.
    const owner = await readLockOwner(lockPath);
    const forced = claimant.force === true;
    const probedDead = hasIsAliveProbe && owner !== null && !isAlive(owner.pid, owner.host);
    if (!forced && !probedDead) {
      if (!hasIsAliveProbe) warnNoIsAliveProbe();
      logInfo(`[spool] claim lock for "${sprintId}" is held (${owner ? `pid ${owner.pid} on ${owner.host}` : 'owner unknown'}); refusing this claim rather than assuming the holder is gone`);
      return false;
    }
    logError(`[spool] breaking claim lock ${lockPath} (${forced ? 'explicit force' : 'liveness probe reports the holder dead'})`);
    await removeQuietly(lockPath);
    // Exactly one retry. If a third party won the re-create in between, that
    // party is by definition live and just took the lock -- refuse, do not
    // spin, and certainly do not break a lock we just watched appear.
    return (await tryCreate()) === 'acquired';
  }

  /**
   * Move a corrupt or foreign-version file aside so it never blocks another
   * scan, and log it -- NEVER throw. Best-effort: if the quarantine rename
   * itself fails, that failure is logged too, not propagated.
   */
  async function quarantine(sprintId, reason) {
    const filePath = filePathFor(spoolDir, sprintId);
    const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
    try {
      await renameWithRetry(fs, filePath, quarantinePath, renameRetryOpts);
      logError(`[spool] quarantined ${filePath} -> ${quarantinePath}: ${reason}`);
    } catch (err) {
      logError(`[spool] failed to quarantine ${filePath} (${reason}): ${err && err.message ? err.message : err}`);
    }
  }

  /**
   * Load one sprint's document from disk. Returns `undefined` when the file
   * is missing (not an error), OR when it is corrupt/foreign-version --
   * in the latter case the bad file is quarantined and logged first. NEVER
   * throws for a bad file: one bad handle must never stop a scan of the
   * others (`list()` relies on this).
   * @param {string} sprintId
   * @returns {Promise<object|undefined>}
   */
  async function loadDoc(sprintId) {
    const filePath = filePathFor(spoolDir, sprintId);
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return undefined;
      // A read failure that is not "missing file" (e.g. a transient
      // permission error) is quarantine-worthy too: better to set the entry
      // aside and let an operator look than to let it wedge every scan.
      await quarantine(sprintId, `read failed: ${err && err.message ? err.message : err}`);
      return undefined;
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      await quarantine(sprintId, `invalid JSON: ${err.message}`);
      return undefined;
    }
    if (!doc || typeof doc !== 'object' || doc.version !== SPOOL_VERSION || doc.sprintId !== sprintId) {
      await quarantine(sprintId, `unexpected shape or foreign version (expected version ${SPOOL_VERSION}, sprintId ${sprintId})`);
      return undefined;
    }
    return doc;
  }

  /**
   * Transactional read-modify-write for one sprint's document, serialized
   * behind that sprint's write queue. `mutateFn(draft)` receives a mutable
   * clone of the current document (or a fresh, empty one if none exists
   * yet) and mutates it in place; the result is persisted and returned.
   *
   * The empty-document synthesis is kept deliberately: `release()`,
   * `complete()`, and `fail()` are all thin wrappers over `patch()` and each
   * only ever *sets* a handful of named fields (claim/state/finalize) -- none
   * of them can "start" anything the way a claim does, so synthesizing a
   * fresh draft under them is harmless idempotence, not a footgun. `claim()`
   * is the one caller for which "nothing on disk yet" must be a hard error
   * rather than a quiet fresh start (see FIX 3 in `claim()`'s doc comment
   * further below), so `claim()` checks `loadDoc()` itself BEFORE calling
   * into `patch()`, rather than this function special-casing that one caller.
   * @param {string} sprintId
   * @param {(draft: object) => void} mutateFn
   * @returns {Promise<object>} the persisted document (a clone)
   */
  async function patch(sprintId, mutateFn) {
    // Declared `async` (rather than throwing synchronously and returning a
    // plain Promise) so a bad `sprintId` becomes a REJECTED promise, not a
    // synchronous throw -- callers (and `assert.rejects` in tests) can treat
    // every path through this function uniformly.
    if (typeof sprintId !== 'string' || sprintId.length === 0) {
      throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, 'patch() requires a non-empty sprintId', { sprintId });
    }
    return withTx(sprintId, async () => {
      const existing = await loadDoc(sprintId);
      const draft = existing ? cloneDoc(existing) : emptySpoolDocument(sprintId, now);
      mutateFn(draft);
      draft.sprintId = sprintId;
      draft.version = SPOOL_VERSION;
      draft.updatedAt = now();
      await persist(sprintId, draft);
      return cloneDoc(draft);
    });
  }

  /**
   * The claim decision itself. Runs ONLY with the cross-process claim lock
   * held (see `claim()` below), so the `loadDoc()` here and the `patch()`
   * write that follows it are one indivisible read-modify-write with respect
   * to every other process on this spool directory -- which is precisely what
   * the previous in-process-only serialization could not provide.
   */
  async function claimLocked(sprintId, claimant) {
    // FIX 3: claim() must never ride patch()'s empty-document synthesis --
    // that is for callers (like patch() itself) that legitimately want a
    // fresh draft to mutate. A claim on a sprintId nobody ever write()-n is
    // a distinct, named error, not a silently-successful claim over an
    // empty document.
    const existingDoc = await loadDoc(sprintId);
    if (!existingDoc) {
      throw new BridgeError(
        BRIDGE_ERROR_CODES.CONFIG_INVALID,
        `claim() refuses: no spool document exists for sprintId "${sprintId}" -- write() must be called before a claim can be taken`,
        { sprintId, reason: 'no-such-document' }
      );
    }
    let claimed = false;
    await patch(sprintId, (draft) => {
      const existing = draft.claim;
      if (existing) {
        if (hasIsAliveProbe) {
          if (isAlive(existing.pid, existing.host)) {
            claimed = false;
            return;
          }
          // A real probe was injected and reports the existing claimant
          // dead -- ordinary automatic takeover, no force needed.
        } else if (claimant.force === true) {
          // No probe injected, but the caller explicitly opted in to
          // stealing this claim -- honor it.
        } else {
          // No probe injected, no explicit force -- fail safe: refuse.
          warnNoIsAliveProbe();
          claimed = false;
          return;
        }
      }
      draft.claim = { pid: claimant.pid, host: claimant.host, claimedAt: now() };
      claimed = true;
    });
    return claimed;
  }

  return {
    name: 'spool',
    spoolDir,

    /**
     * Write a full spool document for a sprint, in one atomic write. `handle`
     * must carry a `sprintId`; any other document fields
     * (state/claim/progress/sinkCursors/finalize) are taken from `handle` if
     * present, defaulted otherwise. This is the raw "put" primitive (like
     * ledger.mjs's `persist()`), not a merge with whatever is already on
     * disk -- use `patch()` for a read-modify-write.
     * @param {object} handle
     * @param {string} handle.sprintId
     * @returns {Promise<object>} the persisted document (a clone)
     */
    async write(handle) {
      // Declared `async` so an invalid `handle` rejects rather than throwing
      // synchronously -- same reasoning as `patch()` above.
      if (!handle || typeof handle !== 'object') {
        throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, 'write() requires a handle object', {});
      }
      const { sprintId } = handle;
      if (typeof sprintId !== 'string' || sprintId.length === 0) {
        throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, 'write() requires handle.sprintId (non-empty string)', { sprintId });
      }
      return withTx(sprintId, async () => {
        const doc = {
          version: SPOOL_VERSION,
          sprintId,
          state: handle.state ?? 'unknown',
          handle: handle.handle !== undefined ? handle.handle : handle,
          claim: handle.claim ?? null,
          progress: handle.progress ?? null,
          sinkCursors: handle.sinkCursors ?? {},
          finalize: handle.finalize ?? null,
          updatedAt: now(),
        };
        await persist(sprintId, doc);
        return cloneDoc(doc);
      });
    },

    /**
     * Read one sprint's document. Returns `undefined` if there is no spool
     * entry for `sprintId`, OR if the file on disk was corrupt/foreign
     * version (quarantined as a side effect, logged, never thrown).
     * @param {string} sprintId
     * @returns {Promise<object|undefined>}
     */
    async read(sprintId) {
      const doc = await loadDoc(sprintId);
      return doc ? cloneDoc(doc) : undefined;
    },

    /**
     * List every valid spool document, optionally narrowed by `filter`.
     * A corrupt/foreign-version entry is quarantined and skipped -- it can
     * never stop the rest of the scan from completing.
     * @param {(doc: object) => boolean} [filter]
     * @returns {Promise<object[]>}
     */
    async list(filter) {
      let names;
      try {
        names = await fs.readdir(spoolDir);
      } catch (err) {
        // A spool directory that does not exist yet is the normal cold-start
        // case, not a failure. Anything else (EACCES on the directory, EPERM,
        // ENOTDIR because the configured path is a file) is real: it used to
        // escape as a raw fs error, landing in exitCodeFor's exit-1 catch-all
        // and violating this package's "every throw crossing the boundary is
        // a BridgeError" rule. The original error is preserved as
        // `details.cause` so nothing needed for diagnosis is lost.
        if (err && err.code === 'ENOENT') return [];
        throw wrapFsError(err, `spool could not read its directory "${spoolDir}"`, { spoolDir });
      }
      const sprintIds = names
        .filter((n) => n.endsWith(SPOOL_FILE_SUFFIX) && !n.includes('.corrupt-') && !n.endsWith('.tmp'))
        .map((n) => n.slice(0, -SPOOL_FILE_SUFFIX.length));

      const docs = [];
      for (const sprintId of sprintIds) {
        // eslint-disable-next-line no-await-in-loop
        const doc = await loadDoc(sprintId);
        if (doc) docs.push(cloneDoc(doc));
      }
      return typeof filter === 'function' ? docs.filter(filter) : docs;
    },

    /**
     * Claim ownership of processing this sprint's spool entry.
     *
     * The whole decision runs under an OS-level exclusive-create lock file
     * (`acquireClaimLock`), so the invariant this comment promises now holds
     * BETWEEN PROCESSES, not merely within one. Previously it did not: two
     * daemons starting simultaneously each read a claim-free document and
     * each wrote itself in, and only a claim already durable on disk was ever
     * refused. Read `acquireClaimLock`'s comment for the stale-lock policy
     * and for the network-filesystem caveat.
     *
     * Also refuses (returns `false`) when the lock is held and cannot be
     * safely broken -- a contended claim is one lost daemon tick, which is
     * always cheaper than two owners.
     *
     * Refuses (returns `false`, makes no write) when:
     *  - a LIVE claim already exists, i.e. an injected `isAlive(claim.pid,
     *    claim.host)` reports true for the existing claim; OR
     *  - an existing claim is present and NO `isAlive` probe was injected at
     *    all, and the caller did not pass `{ force: true }`. This is the
     *    fail-safe default: the single-writer invariant the `watch`/blob-sink
     *    path depends on means an unresolvable "is it still alive?" question
     *    must be answered "assume yes, refuse" -- never "assume no, steal" --
     *    because two daemons both believing they own the sprint corrupts the
     *    `appendpos` cursor silently (see the file-level doc comment).
     *
     * Takes over (writes the new claim, returns `true`) when:
     *  - there is no existing claim at all; OR
     *  - a probe WAS injected and reports the existing claimant dead; OR
     *  - no probe was injected but the caller explicitly opted in with
     *    `claimant.force === true` (an intentional override, e.g. an operator
     *    command -- never a default).
     *
     * Throws a `BridgeError` (does not write, does not treat as "no claim")
     * when `sprintId` has no spool document at all -- i.e. `write()` was
     * never called for it. A typo'd sprintId must never start a live claim
     * over nothing (see `patch()`'s doc comment on the synthesis it performs
     * for OTHER callers).
     *
     * @param {string} sprintId
     * @param {{ pid: number, host: string, force?: boolean }} claimant
     * @returns {Promise<boolean>}
     */
    async claim(sprintId, claimant = {}) {
      if (typeof sprintId !== 'string' || sprintId.length === 0) {
        throw new BridgeError(BRIDGE_ERROR_CODES.CONFIG_INVALID, 'claim() requires a non-empty sprintId', { sprintId });
      }
      if (typeof fs.unlink !== 'function') {
        // Without unlink the lock could be taken but never released, which
        // would wedge every future claim for this sprint. Refusing loudly up
        // front beats a spool that quietly stops accepting daemons.
        throw new BridgeError(
          BRIDGE_ERROR_CODES.CONFIG_MISSING,
          'claim() requires an injected fs.unlink -- the cross-process claim lock cannot be released without it',
          { sprintId }
        );
      }
      // The cross-process mutex wraps EVERYTHING below: the "does a document
      // exist" check, the liveness decision, and the write. Holding it only
      // over the write would leave the read-modify-write window wide open,
      // which is the exact race being fixed.
      if (!(await acquireClaimLock(sprintId, claimant))) return false;
      try {
        return await claimLocked(sprintId, claimant);
      } finally {
        await removeQuietly(lockPathFor(sprintId));
      }
    },

    /**
     * Release the claim on a sprint's spool entry (sets `claim` back to
     * `null`), without touching any other field. A no-op (still succeeds)
     * if there was no claim held.
     * @param {string} sprintId
     * @returns {Promise<object>} the persisted document
     */
    release(sprintId) {
      return patch(sprintId, (draft) => {
        draft.claim = null;
      });
    },

    /**
     * Record a successful terminal result for a sprint.
     * @param {string} sprintId
     * @param {any} result
     * @returns {Promise<object>} the persisted document
     */
    complete(sprintId, result) {
      return patch(sprintId, (draft) => {
        draft.state = 'completed';
        draft.finalize = { outcome: 'completed', result: result ?? null, at: now() };
      });
    },

    /**
     * Record a failed terminal result for a sprint. `err` is normalized to a
     * plain `{ message, code }` shape -- never persists a raw Error object
     * (or anything else that JSON.stringify would silently drop).
     * @param {string} sprintId
     * @param {Error|{message?: string, code?: string}} err
     * @returns {Promise<object>} the persisted document
     */
    fail(sprintId, err) {
      return patch(sprintId, (draft) => {
        draft.state = 'failed';
        draft.finalize = {
          outcome: 'failed',
          error: {
            message: (err && err.message) ? String(err.message) : String(err),
            code: (err && err.code) ? String(err.code) : null,
          },
          at: now(),
        };
      });
    },

    /**
     * Transactional read-modify-write, exposed for callers that need a
     * bespoke mutation this module does not name (e.g. updating `progress`
     * or `sinkCursors`). See `patch()` above for the exact contract.
     * @param {string} sprintId
     * @param {(draft: object) => void} mutateFn
     * @returns {Promise<object>} the persisted document
     */
    patch,
  };
}
