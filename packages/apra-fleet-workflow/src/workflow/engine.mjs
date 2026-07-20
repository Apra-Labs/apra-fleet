import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { randomUUID } from 'crypto';
import { VettingEngine } from './vetting.mjs';
import { JournalWriter, loadJournal, resolveJournalWritePath } from './journal.mjs';

/**
 * Loads and runs user-authored workflow scripts.
 *
 * TRUST MODEL: workflow scripts are TRUSTED code. They are loaded as real ES
 * modules via dynamic `import()` and execute with full Node.js privileges
 * (filesystem, network, child processes, `process.env`, dynamic `import()`,
 * etc.) -- there is no sandbox. Only run scripts you trust, the same way you
 * would trust any other Node.js module you `import`. See
 * docs/apra-fleet-workflow-architecture.md section 3 for details.
 * `VettingEngine` (vetting.mjs) is an advisory lint that surfaces
 * risky-looking patterns as warnings; it is NOT a security boundary and does
 * not block execution unless a caller explicitly opts into strict mode.
 */
export class WorkflowEngine {
    /**
     * @param {import('./index.mjs').FleetWorkflow} workflowApi
     */
    constructor(workflowApi) {
        this.wf = workflowApi;
        this.vetting = new VettingEngine();
    }

    /**
     * Load a workflow script as a real ES module and run it.
     *
     * The module must export an entry point function as one of `main`,
     * `run`, or `default` (checked in that order) -- this is the
     * standardized pattern all workflow scripts in this repo (examples/*,
     * auto-sprint's runner.js, test fixtures) follow. The entry point is
     * invoked with a single `context` argument (the object returned by
     * `workflowApi.createContext()`), exposing `agent`, `command`,
     * `parallel`, `sequential`, `pipeline`, `transform`, `log`, `phase`,
     * `group`, `endGroup`, `publishState`, `args`, `budget`, etc. Scripts
     * access these via the `context` parameter (e.g.
     * `export async function main(context) { const { agent, log } = context; ... }`)
     * rather than via injected bare globals -- there is no global injection
     * anymore now that scripts are real ES modules.
     *
     * @param {string} scriptPath
     * @param {any} args
     * @param {boolean|{strictVetting?: boolean, journal?: boolean|string|{path:string}, resumeJournal?: string}} [vettingOpts] -
     *   Either a plain options object, or -- for backward compatibility with
     *   the old `forceOverrideRisk` boolean parameter -- a boolean, which is
     *   now a no-op (vetting never blocks by default, so there is nothing
     *   left to "force override"). Recognized object fields:
     *   - `strictVetting` (boolean): opts in to blocking execution of
     *     high-risk scripts.
     *   - `journal` (apra-fleet-unw.11, F6): opts in to persisting this run's
     *     `activity:start`/`activity:end`/`end` events as an append-only
     *     JSONL journal (see journal.mjs). `true` -> default path
     *     `.fleet-workflow/journal-<runId>.jsonl`; a string or
     *     `{ path: string }` -> explicit path. OFF BY DEFAULT: omitting this
     *     (and `resumeJournal`) produces zero journal-related I/O and zero
     *     change to emitted event shapes.
     *   - `resumeJournal` (string path): resumes a previous (possibly
     *     crashed) run from an existing journal file. For each
     *     `agent()`/`command()` call, a deterministic activity key (sequence
     *     index within the run + call type + a hash of the dispatched
     *     prompt/command text + member) is looked up in the journal; a
     *     matching COMPLETED (successful) record is returned directly
     *     without dispatching to the fleet. The FIRST mismatch or missing
     *     entry stops replay and switches to live execution from that point
     *     onward (partial replay, not all-or-nothing -- Claude-CLI style).
     *     Journal records that were started but never finished (a crash
     *     mid-dispatch) are surfaced via a `journal:ambiguous` event and a
     *     console warning as possibly-double-dispatched; they are never
     *     auto-resolved (true idempotency requires fleet-server-side keys,
     *     descoped -- see plan.md). Unless `journal` is also given, the
     *     resumed run continues writing to the SAME file it resumed from.
     */
    async executeFile(scriptPath, args = {}, vettingOpts = {}) {
        const fullPath = path.resolve(scriptPath);
        const opts = typeof vettingOpts === 'boolean' ? {} : (vettingOpts || {});
        const strictVetting = typeof vettingOpts === 'boolean' ? false : !!opts.strictVetting;

        const source = await fs.readFile(fullPath, 'utf-8');
        const vettingResult = await this.vetting.assessRisk(source);
        if (vettingResult.riskScore > 0) {
            console.warn(`[VettingEngine] Script flagged with risk score ${vettingResult.riskScore}/100 (advisory only -- workflow scripts run with full Node privileges and must be trusted; see docs/apra-fleet-workflow-architecture.md).`);
            vettingResult.warnings.forEach(w => console.warn(`  - WARNING: ${w}`));

            if (strictVetting && vettingResult.riskScore > 50) {
                throw new Error(`Workflow script rejected by VettingEngine in strict mode (Risk: ${vettingResult.riskScore}). Vetting is advisory-only by default (not a security boundary); pass { strictVetting: true } only if you want this check to be enforced.`);
            }
        }

        const moduleUrl = pathToFileURL(fullPath).href;
        const mod = await import(moduleUrl);

        const entry = mod.main || mod.run || mod.default;
        if (typeof entry !== 'function') {
            throw new Error(`[WorkflowEngine] ${fullPath} does not export a main(context)/run(context)/default(context) function. Workflow scripts must export one of these as their entry point.`);
        }

        // (apra-fleet-unw.9, F11) Each executeFile() call gets its own
        // isolated per-run context -- args, phase, group, budget -- via
        // FleetWorkflow.runWithContext(), instead of mutating shared
        // `this.wf.args`/`this.wf.currentPhase` instance state. This is what
        // makes two concurrent executeFile() calls against the same
        // FleetWorkflow instance safe: they no longer stomp on each other's
        // args or phase attribution. See the runStorage comment in
        // src/workflow/index.mjs for the full mechanism.
        //
        // (apra-fleet-unw.10) A `runId` is generated here (rather than left
        // to runWithContext()'s internal default) so it's known up front and
        // can be attached to the `end` event emitted from the `finally`
        // block below on BOTH the success and failure/throw paths -- this is
        // what lets the dashboard viewer (src/viewer/index.mjs) finally
        // leave its perpetual "LIVE" state and transition to DONE/FAILED,
        // and is also the runId a script's own `requestStop()`-triggered
        // CancelledError (errors.mjs) will carry.
        const runId = randomUUID();

        // (apra-fleet-unw.11, F6) Journal setup. `journalEnabled` gates
        // EVERYTHING journal-related in FleetWorkflow (the per-run activity
        // sequence counter, replay-key computation) so that a normal call
        // with neither `journal` nor `resumeJournal` set is byte-for-byte
        // identical, in behavior and in emitted event shape, to before this
        // feature existed (acceptance criterion #4).
        const journalEnabled = !!(opts.journal || opts.resumeJournal);
        let replay = null;
        if (opts.resumeJournal) {
            const resumePath = path.resolve(opts.resumeJournal);
            const loaded = await loadJournal(resumePath);
            replay = { completedByKey: loaded.completedByKey, diverged: false };

            // Ambiguity guard: surface (never auto-resolve) any activity
            // that was dispatched but never recorded as finished in the
            // journal being resumed from -- most likely because the prior
            // run crashed mid-dispatch. True idempotency requires
            // fleet-server-side keys and is explicitly descoped (plan.md).
            for (const ambiguousRecord of loaded.ambiguous) {
                console.warn(
                    `[Journal] Ambiguous activity from a previous run (started but never recorded as finished -- ` +
                    `possibly double-dispatched on resume): id=${ambiguousRecord.id} type=${ambiguousRecord.type} ` +
                    `member=${ambiguousRecord.member} label=${ambiguousRecord.label || 'none'}`
                );
                this.wf.emit('journal:ambiguous', { runId, resumedFrom: resumePath, activity: ambiguousRecord });
            }
        }

        const journalWritePath = journalEnabled ? resolveJournalWritePath(opts, runId) : null;
        let journalWriter = null;
        if (journalWritePath) {
            journalWriter = new JournalWriter(this.wf, { runId, filePath: journalWritePath });
            await journalWriter.init();
            await journalWriter.writeRunStart({ scriptPath: fullPath, args });
        }

        let status = 'success';
        let result;
        let error;
        try {
            result = await this.wf.runWithContext(args, entry, { runId, journalEnabled, replay });
            return result;
        } catch (err) {
            console.error('[WorkflowEngine] Execution Failed:', err);
            error = err;
            status = err && err.code === 'CANCELLED' ? 'cancelled' : 'failed';
            throw err;
        } finally {
            this.wf.emit('end', {
                runId,
                status,
                result: status === 'success' ? result : undefined,
                error: error
                    ? { message: error.message, code: error.code, name: error.name }
                    : undefined
            });
            if (journalWriter) {
                await journalWriter.close();
            }
        }
    }

    /**
     * REMOVED: inline-string execution. Workflow scripts are now loaded as
     * real ES modules via `import()`, which requires an actual module (a
     * file on disk, or a `data:`/`blob:` URL you construct yourself) rather
     * than an arbitrary source string handed to an `AsyncFunction`
     * constructor -- that constructor-based path (and the export-stripping
     * regex it depended on) has been removed entirely. Write the script to a
     * file and call `executeFile(path, args)` instead.
     */
    async executeSource() {
        throw new Error(
            '[WorkflowEngine] executeSource() has been removed: workflow scripts are now loaded as real ES ' +
            'modules via import(), which requires an actual module (a file, or a data:/blob: URL you construct ' +
            'yourself) rather than an inline source string. Write the script to a file and call ' +
            'executeFile(path, args) instead.'
        );
    }
}
