// sprint-doctor dispatch-health ledger (design:
// fleet-sprint/docs/escalate-to-llm-design.md section 1.1).
//
// A small in-memory (plus JSONL-appended, for post-mortem) recorder,
// populated at the dispatch catch/outcome sites the runner already has --
// no new instrumentation planes. This module is deliberately a standalone,
// pure recorder: it imports nothing from runner.js and performs no
// dispatching itself, so the trigger layer (doctor-triggers.mjs) and any
// post-mortem tooling can share one recorder without either depending on
// the engine's own control flow. Wiring this ledger into the real
// catch/outcome sites is a separate, later task in this lane.
//
// `createSprintHealthLedger()` returns a small stateful recorder object
// rather than a class -- matching the factory-function shape used
// elsewhere in this package (e.g. `acquireSprintLock()` in
// sprint-lock.mjs) rather than introducing a new construction style.

import fs from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// errorSignature normalization
// ---------------------------------------------------------------------------
//
// The load-bearing part of the ledger: "identical signature repeated" vs
// "different failure each time" is the primary environment-vs-engine
// discriminator the trigger layer and the doctor's own triage rely on
// (design doc sections 1.1, 3.1). A signature is built from the failure
// `reason` plus the first line of its message, with everything that varies
// per-occurrence but NOT per-failure-class stripped: bead ids, bare
// numbers, absolute/relative paths, hex blobs and timestamps. This module
// ships to any target project (see docs/generic-engine-boundary.md), so the
// bead-id pattern below is a SHAPE match (hyphenated, digit-bearing token),
// never a specific tracker's prefix.

// ISO-8601-ish date/time: 2026-09-22T12:25:16.029Z, 2026-09-22 12:25:16,
// with optional fractional seconds and Z/offset suffix.
const TIMESTAMP_RE = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;

// Path-like runs: POSIX absolute/relative (/a/b/c, packages/x/y.mjs) and
// Windows drive-letter paths (C:\a\b). Requires at least one separator so
// a bare word is never mistaken for a path.
const PATH_RE = /(?:[A-Za-z]:)?(?:\/|\\)[\w.\-]+(?:(?:\/|\\)[\w.\-]+)+/g;

// Hex blobs (git shas, hashes): 7+ hex digits, at least one letter a-f so a
// bare decimal number is left for NUMBER_RE below (and so 7-digit phone-
// number-shaped decimals aren't mistaken for hashes either).
const HEX_BLOB_RE = /\b(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{7,64}\b/g;

// ID-like tokens: a hyphenated alnum run (bead ids, member/run ids) --
// post-filtered below to only fire when the token actually contains a
// digit, so a genuinely word-ish hyphenated phrase (e.g. "not-logged-in")
// is left intact as substantive message content.
const ID_LIKE_RE = /\b[a-zA-Z][a-zA-Z0-9]*(?:-[a-zA-Z0-9]+)+(?:\.[0-9]+)*\b/g;

// Whatever bare digits remain after the passes above (line numbers, ports,
// counts, byte offsets, ...).
const NUMBER_RE = /\b\d+\b/g;

/**
 * Builds a normalized error signature from a dispatch failure's structured
 * `reason` and raw `message`, so two occurrences of "the same failure" -- as
 * opposed to two genuinely different failures -- collapse to the identical
 * string. Only the FIRST line of `message` is considered (stack traces and
 * multi-line detail are not part of the identity).
 * @param {string|null|undefined} reason
 * @param {string|null|undefined} message
 * @returns {string}
 */
export function normalizeErrorSignature(reason, message) {
    const reasonPart = reason ? String(reason) : 'unknown';
    const firstLine = message ? String(message).split(/\r?\n/, 1)[0] : '';
    const normalized = firstLine
        .replace(TIMESTAMP_RE, '<TS>')
        .replace(PATH_RE, '<PATH>')
        .replace(HEX_BLOB_RE, '<HEX>')
        .replace(ID_LIKE_RE, (m) => (/\d/.test(m) ? '<ID>' : m))
        .replace(NUMBER_RE, '<NUM>')
        .replace(/\s+/g, ' ')
        .trim();
    return normalized ? `${reasonPart}: ${normalized}` : reasonPart;
}

// ---------------------------------------------------------------------------
// The ledger itself
// ---------------------------------------------------------------------------

/**
 * @param {{ artifactPath?: string, log?: (msg: string) => void }} [opts]
 *   `artifactPath` -- JSONL file each recorded row is appended to (one JSON
 *   object per line), written beside the run state. Omit to keep the ledger
 *   in-memory only (e.g. for tests). `log` -- best-effort diagnostic sink
 *   for artifact write failures; defaults to a no-op, matching the
 *   `log = () => {}` convention used elsewhere in this package (see
 *   `withDispatchWatchdog` in dispatch-failure.mjs).
 * @returns {{
 *   recordDispatch: (row: object) => object,
 *   rows: () => object[],
 *   rowsForBead: (id: string) => object[],
 *   rowsForMember: (name: string) => object[],
 *   signatureFrequency: () => Record<string, number>,
 * }}
 */
export function createSprintHealthLedger({ artifactPath, log = () => {} } = {}) {
    const rows = [];

    function appendArtifactLine(row) {
        // Best-effort by construction: any artifact write failure is logged
        // and swallowed -- recording must never be able to fail a dispatch.
        if (!artifactPath) return;
        try {
            fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
            fs.appendFileSync(artifactPath, `${JSON.stringify(row)}\n`, 'utf8');
        } catch (err) {
            log(`[doctor-ledger] failed to append to artifact ${artifactPath}: ${(err && err.message) || err}`);
        }
    }

    /**
     * Records one dispatch outcome. Keeps the row in memory and appends it
     * as one JSON line to the artifact (if configured). Returns the stored
     * row (with its `timestamp` filled in) for a caller that wants it, but
     * callers are not required to use the return value.
     */
    function recordDispatch(entry = {}) {
        const beadIds = Array.isArray(entry.beadIds)
            ? entry.beadIds.slice()
            : entry.beadIds
                ? [entry.beadIds]
                : [];
        const row = {
            timestamp: Date.now(),
            cycle: entry.cycle ?? null,
            phaseLabel: entry.phaseLabel ?? null,
            role: entry.role ?? null,
            member: entry.member ?? null,
            beadIds,
            ok: !!entry.ok,
            reason: entry.reason ?? null,
            errorSignature: entry.errorSignature ?? null,
            durationS: entry.durationS ?? null,
            tier: entry.tier ?? null,
            costUsd: entry.costUsd ?? null,
        };
        rows.push(row);
        appendArtifactLine(row);
        return row;
    }

    function rowsAll() {
        return rows.slice();
    }

    function rowsForBead(id) {
        return rows.filter((r) => r.beadIds.includes(id));
    }

    function rowsForMember(name) {
        return rows.filter((r) => r.member === name);
    }

    /**
     * Signature -> occurrence-count table, aggregated across EVERY member --
     * not just one -- which is what makes environment-vs-engine triage
     * possible later (design doc section 3.1: an identical signature across
     * unrelated beads AND multiple members points at a shared substrate
     * rather than any one bead or member).
     */
    function signatureFrequency() {
        const freq = {};
        for (const row of rows) {
            if (!row.errorSignature) continue;
            freq[row.errorSignature] = (freq[row.errorSignature] || 0) + 1;
        }
        return freq;
    }

    return { recordDispatch, rows: rowsAll, rowsForBead, rowsForMember, signatureFrequency };
}
