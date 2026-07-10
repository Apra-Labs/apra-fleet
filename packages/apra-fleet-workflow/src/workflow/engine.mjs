import * as fs from 'fs/promises';
import * as path from 'path';
import { VettingEngine } from './vetting.mjs';

/**
 * A simple workflow engine that parses a user-defined JavaScript workflow script
 * and executes it within an isolated AsyncFunction context, injecting the FleetWorkflow globals.
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
     * Parse and execute a workflow script.
     * @param {string} scriptPath 
     * @param {any} args 
     * @param {boolean} [forceOverrideRisk=false] - If true, ignores vetting risk thresholds
     */
    async executeFile(scriptPath, args = {}, forceOverrideRisk = false) {
        const fullPath = path.resolve(scriptPath);
        const source = await fs.readFile(fullPath, 'utf-8');
        return this.executeSource(source, args, forceOverrideRisk);
    }

    /**
     * @param {string} sourceCode 
     * @param {any} args 
     * @param {boolean} [forceOverrideRisk=false]
     */
    async executeSource(sourceCode, args = {}, forceOverrideRisk = false) {
        const vettingResult = await this.vetting.assessRisk(sourceCode);
        if (vettingResult.riskScore > 0) {
            console.warn(`[VettingEngine] Script flagged with risk score ${vettingResult.riskScore}/100.`);
            vettingResult.warnings.forEach(w => console.warn(`  - WARNING: ${w}`));
            
            if (vettingResult.riskScore > 50 && !forceOverrideRisk) {
                throw new Error(`Workflow script rejected by VettingEngine (Risk: ${vettingResult.riskScore}). Pass forceOverrideRisk=true to execute anyway.`);
            }
        }

        this.wf.args = args; // update args for this run

        // Remove the `export` keyword from `export const meta =` so it doesn't break AsyncFunction
        // This is a naive translation layer so we don't have to spin up full ES modules.
        const cleanSource = sourceCode.replace(/export\s+(const\s+meta\s*=)/g, '$1');

        const ctx = this.wf.createContext();
        const argKeys = Object.keys(ctx);
        const argValues = Object.values(ctx);

        // We wrap the user script in an AsyncFunction to evaluate it.
        // The script can contain top-level awaits, agent() calls, etc.
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        
        try {
            const runner = new AsyncFunction(...argKeys, `
                ${cleanSource}
                
                // If there's a default export function, run it, 
                // else assume the script execution IS the workflow.
                if (typeof main !== 'undefined') {
                    return await main();
                } else if (typeof run !== 'undefined') {
                    return await run();
                }
                
                return typeof meta !== 'undefined' ? meta : null;
            `);

            return await runner(...argValues);
        } catch (err) {
            console.error('[WorkflowEngine] Execution Failed:', err);
            throw err;
        }
    }
}
