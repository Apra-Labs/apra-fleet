import * as fs from 'fs/promises';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { VettingEngine } from './vetting.mjs';

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
     * @param {boolean|{strictVetting?: boolean}} [vettingOpts] - Either a
     *   plain options object (`{ strictVetting: true }` opts in to blocking
     *   execution of high-risk scripts), or -- for backward compatibility
     *   with the old `forceOverrideRisk` boolean parameter -- a boolean,
     *   which is now a no-op (vetting never blocks by default, so there is
     *   nothing left to "force override").
     */
    async executeFile(scriptPath, args = {}, vettingOpts = {}) {
        const fullPath = path.resolve(scriptPath);
        const strictVetting = typeof vettingOpts === 'boolean' ? false : !!vettingOpts.strictVetting;

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
        try {
            return await this.wf.runWithContext(args, entry);
        } catch (err) {
            console.error('[WorkflowEngine] Execution Failed:', err);
            throw err;
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
