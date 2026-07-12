import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';

/**
 * Execution journal (apra-fleet-unw.11, F6).
 *
 * Borrows the "resumable runs / journal caching" pattern from Claude CLI's
 * dynamic-workflow model: an append-only JSONL log of the SAME
 * `activity:start`/`activity:end`/`end` events `FleetWorkflow` already emits
 * (see src/workflow/index.mjs), persisted verbatim by a plain event
 * listener -- this module does NOT invent a second, parallel event format.
 *
 * OFF BY DEFAULT: none of this module's code runs unless a caller opts in
 * via `WorkflowEngine.executeFile(script, args, { journal, resumeJournal })`.
 * A normal `executeFile()` call with neither option produces zero directory/
 * file I/O and zero change to the shape of emitted events (see the
 * `journalEnabled` gating in engine.mjs / index.mjs).
 */

export const DEFAULT_JOURNAL_DIR = '.fleet-workflow';

/**
 * Hashes prompt/command text for journal storage. The journal never stores
 * raw prompt/command text for `agent()` calls (which can be large and may
 * contain sensitive content) -- only this hash, used to detect divergence on
 * resume. (`command()`'s existing `activity:start`/`activity:end` events
 * already include the raw, substituted command string as part of their
 * established event contract -- see the `command` field in
 * src/workflow/index.mjs -- so this hash is additional, not a replacement,
 * for that field; it is still what replay matching keys off of.)
 * @param {string|undefined|null} text
 * @returns {string|null}
 */
export function hashText(text) {
    if (text === undefined || text === null) return null;
    return createHash('sha256').update(String(text)).digest('hex');
}

/**
 * Deterministic replay key for a single `agent()`/`command()` call: the
 * call's sequence index within the run (assigned once per logical call, not
 * per schema-repair attempt), its type, the target member, and a hash of the
 * dispatched prompt/command text. First mismatch or first missing entry for
 * this key during a resumed run stops replay and switches to live execution
 * from that point onward (Claude-CLI style partial replay).
 * @param {{ sequence: number, type: 'agent'|'command', member?: string, textHash: string|null }} parts
 * @returns {string}
 */
export function computeActivityKey({ sequence, type, member, textHash }) {
    return `${sequence}:${type}:${member || ''}:${textHash || ''}`;
}

/**
 * Resolves the journal file path an `executeFile()` call should write to
 * (or `null` if journaling is not requested at all), from the same options
 * object `executeFile()` accepts.
 *
 * - `opts.journal === true` -> default path `.fleet-workflow/journal-<runId>.jsonl`
 * - `opts.journal === '<path>'` -> that path
 * - `opts.journal === { path: '<path>' }` -> that path
 * - `opts.journal === false` -> explicitly disabled (even if resumeJournal is set)
 * - no `opts.journal`, but `opts.resumeJournal` set -> continue writing to the
 *   SAME file being resumed from (the journal for a resumed run continues the
 *   original run's journal rather than starting a fresh one)
 * - neither set -> `null` (no journaling)
 * @param {{journal?: boolean|string|{path:string}, resumeJournal?: string}} opts
 * @param {string} runId
 * @returns {string|null}
 */
export function resolveJournalWritePath(opts, runId) {
    if (opts.journal === false) return null;
    if (opts.journal) {
        if (typeof opts.journal === 'string') return path.resolve(opts.journal);
        if (typeof opts.journal === 'object' && opts.journal.path) return path.resolve(opts.journal.path);
        return path.resolve(DEFAULT_JOURNAL_DIR, `journal-${runId}.jsonl`);
    }
    if (opts.resumeJournal) return path.resolve(opts.resumeJournal);
    return null;
}

/**
 * Loads a journal file for resume/replay. Tolerant of a missing file (a
 * `resumeJournal` path that doesn't exist yet is treated as an empty
 * journal -- the whole run simply executes live, same as a fresh run) and of
 * trailing/corrupt partial lines (a crash can leave a half-written final
 * line; it is skipped rather than failing the whole load).
 *
 * @param {string} filePath
 * @returns {Promise<{ completedByKey: Map<string, object>, ambiguous: object[] }>}
 *   `completedByKey` maps a replay key (see computeActivityKey) to the
 *   merged `activity:start` + `activity:end` record for the last time that
 *   key completed (successfully or not -- callers decide whether a
 *   non-success record counts as a replay hit).
 *
 *   (apra-fleet-unw2.13, N5) For `command()` calls, this merged record
 *   carries a `failSoft` boolean (persisted verbatim from the
 *   `activity:start`/`activity:end` events -- see the `failSoft` field on
 *   `activityMeta` in `command()`, src/workflow/index.mjs) telling the
 *   replay path in `command()` whether the ORIGINAL call used
 *   `{ failSoft: true }` and therefore must be replayed as the shaped
 *   `{ ok, output, error }` object rather than the raw output string.
 *   OLD-FORMAT journal lines written before this field existed simply won't
 *   have it -- `rec.failSoft` is `undefined` for those, which the caller in
 *   `command()` treats as `false` (falls back to the pre-fix raw-string
 *   behavior) rather than crashing. That fallback is a known, documented
 *   limitation: a failSoft caller resuming from a pre-fix journal cannot be
 *   perfectly replayed and will see the same bare-string shape it saw
 *   before this fix, until the journal is regenerated by a fresh run.
 *   `ambiguous` lists every `activity:start` record with no matching
 *   `activity:end` in the file -- i.e. an activity that was dispatched but
 *   never recorded as finished, most likely because the run crashed
 *   mid-dispatch. These are surfaced (not resolved) by the caller as a
 *   possibly-double-dispatched warning; true idempotency requires
 *   fleet-server-side keys and is explicitly descoped (see plan.md).
 */
export async function loadJournal(filePath) {
    let raw;
    try {
        raw = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
        if (err && err.code === 'ENOENT') {
            return { completedByKey: new Map(), ambiguous: [] };
        }
        throw err;
    }

    const startsById = new Map();
    const endsById = new Map();
    const completedByKey = new Map();

    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec;
        try {
            rec = JSON.parse(trimmed);
        } catch {
            // Tolerate a corrupt/partial trailing line (e.g. the process was
            // killed mid-write) -- skip it rather than failing the load.
            continue;
        }
        if (rec.event === 'activity:start' && rec.id) {
            startsById.set(rec.id, rec);
        } else if (rec.event === 'activity:end' && rec.id) {
            endsById.set(rec.id, rec);
            const startRec = startsById.get(rec.id);
            const replayKey = rec.replayKey || (startRec && startRec.replayKey);
            if (replayKey) {
                // Last one wins: if the same key was resumed/replayed more
                // than once across multiple crash/resume cycles, the most
                // recent completion is what should be trusted.
                completedByKey.set(replayKey, { ...startRec, ...rec });
            }
        }
    }

    const ambiguous = [];
    for (const [id, startRec] of startsById) {
        if (!endsById.has(id)) {
            ambiguous.push(startRec);
        }
    }

    return { completedByKey, ambiguous };
}

/**
 * Append-only JSONL journal writer. Attaches to a `FleetWorkflow` instance's
 * existing `activity:start`/`activity:end`/`end` events (filtered to a
 * single `runId`) and persists them verbatim, one JSON object per line, plus
 * a synthetic `run:start` record written up front. Writes are serialized
 * through an internal promise chain so concurrent event emissions (e.g. from
 * `parallel()` branches of the same run) can never interleave/corrupt lines.
 */
export class JournalWriter {
    /**
     * @param {import('./index.mjs').FleetWorkflow} fleetWorkflow
     * @param {{ runId: string, filePath: string }} opts
     */
    constructor(fleetWorkflow, { runId, filePath }) {
        this.wf = fleetWorkflow;
        this.runId = runId;
        this.filePath = filePath;
        this._chain = Promise.resolve();

        this._onActivityStart = (meta) => {
            if (meta.runId === this.runId) this._enqueue({ event: 'activity:start', ...meta });
        };
        this._onActivityEnd = (meta) => {
            if (meta.runId === this.runId) this._enqueue({ event: 'activity:end', ...meta });
        };
        this._onEnd = (meta) => {
            if (meta.runId === this.runId) this._enqueue({ event: 'run:end', ...meta });
        };
    }

    /** Creates the journal directory (if needed) and starts listening. */
    async init() {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        this.wf.on('activity:start', this._onActivityStart);
        this.wf.on('activity:end', this._onActivityEnd);
        this.wf.on('end', this._onEnd);
    }

    /**
     * Writes the run-start record. Best-effort: `args`/`scriptPath` are
     * stringified defensively (non-serializable args must not crash the
     * run).
     * @param {{ scriptPath: string, args: any }} meta
     */
    async writeRunStart(meta) {
        const record = { event: 'run:start', runId: this.runId, timestamp: Date.now(), scriptPath: meta.scriptPath };
        try {
            record.args = JSON.parse(JSON.stringify(meta.args ?? {}));
        } catch {
            record.args = undefined;
        }
        this._enqueue(record);
        await this._chain;
    }

    _enqueue(record) {
        this._chain = this._chain.then(() => fs.appendFile(this.filePath, JSON.stringify(record) + '\n', 'utf-8'));
        return this._chain;
    }

    /** Detaches listeners and waits for all queued writes to flush. */
    async close() {
        this.wf.off('activity:start', this._onActivityStart);
        this.wf.off('activity:end', this._onActivityEnd);
        this.wf.off('end', this._onEnd);
        await this._chain;
    }
}
