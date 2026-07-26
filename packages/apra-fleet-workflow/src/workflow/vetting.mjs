/**
 * @typedef {Object} VettingResult
 * @property {number} riskScore - 0 (safe) to 100 (critical risk)
 * @property {string[]} warnings - List of identified risks or violations
 */

/**
 * Interface for a vetting analyzer.
 * Other developers can implement this interface to add custom checks.
 */
export class WorkflowAnalyzer {
    /**
     * @param {string} sourceCode 
     * @returns {Promise<VettingResult>}
     */
    async analyze(sourceCode) {
        throw new Error("analyze() must be implemented");
    }
}

/**
 * A basic analyzer that scans for patterns worth a developer's attention --
 * fs/child_process imports, process.env access, dynamic eval -- in a
 * workflow script. This is a heuristic lint for code review purposes, not an
 * enforcement mechanism: workflow scripts are trusted code that already runs
 * with full Node.js privileges (see engine.mjs), so none of these patterns
 * are actually "not allowed"; they're just worth a human glancing at before
 * running an unfamiliar script.
 */
export class BasicSecurityAnalyzer extends WorkflowAnalyzer {
    async analyze(sourceCode) {
        let riskScore = 0;
        const warnings = [];

        // In a real system, we'd use an AST parser (like Acorn or Babel) to inspect imports and globals.
        // For this first implementation, we use simple heuristic regex matching.
        // NOTE: as regex matching over source text, this is trivially bypassable (string
        // concatenation, indirect references, etc.) -- it is not a security control, only a lint.

        if (/(?:import|require)\s*\(\s*(?:'|")(?:fs|child_process|crypto|os|net|http)(?:'|")\s*\)/i.test(sourceCode) ||
            /import\s+.*(?:'|")(?:fs|child_process|crypto|os|net|http)(?:'|")/i.test(sourceCode)) {
            riskScore = Math.max(riskScore, 80);
            warnings.push("Imports a core Node.js system module -- worth a review pass, but not blocked (workflow scripts are trusted code with full Node privileges).");
        }

        if (/process\.env/i.test(sourceCode)) {
            riskScore = Math.max(riskScore, 50);
            warnings.push("Accesses process environment variables directly.");
        }

        if (/eval\s*\(/i.test(sourceCode) || /new\s+Function\s*\(/i.test(sourceCode)) {
            riskScore = Math.max(riskScore, 90);
            warnings.push("Uses dynamic code evaluation (eval or new Function).");
        }

        return { riskScore, warnings };
    }
}

/**
 * The Vetting Engine runs workflow scripts through all registered analyzers
 * to generate a cumulative risk assessment before execution.
 *
 * NOTE: this is an advisory lint, not a security boundary. Workflow scripts
 * are TRUSTED code loaded as real ES modules with full Node.js privileges
 * (see engine.mjs); a regex-based heuristic scan cannot meaningfully sandbox
 * arbitrary JavaScript, and this class does not attempt to. Findings are
 * logged as warnings; by default WorkflowEngine.executeFile() never blocks
 * on them. Pass `{ strictVetting: true }` to executeFile() if you want
 * high-risk scripts (riskScore > 50) to throw instead of just warn.
 */
export class VettingEngine {
    constructor() {
        /** @type {WorkflowAnalyzer[]} */
        this.analyzers = [
            new BasicSecurityAnalyzer()
        ];
    }

    /**
     * @param {WorkflowAnalyzer} analyzer 
     */
    registerAnalyzer(analyzer) {
        this.analyzers.push(analyzer);
    }

    /**
     * Assess the risk of a workflow script.
     * @param {string} sourceCode 
     * @returns {Promise<VettingResult>}
     */
    async assessRisk(sourceCode) {
        let maxRisk = 0;
        const allWarnings = [];

        for (const analyzer of this.analyzers) {
            try {
                const result = await analyzer.analyze(sourceCode);
                maxRisk = Math.max(maxRisk, result.riskScore);
                allWarnings.push(...result.warnings);
            } catch (err) {
                console.error(`[VettingEngine] Analyzer failed:`, err);
                // Fail secure by flagging unanalyzable scripts
                maxRisk = Math.max(maxRisk, 100);
                allWarnings.push("An analyzer crashed while analyzing this script.");
            }
        }

        return { riskScore: maxRisk, warnings: allWarnings };
    }
}
