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
 * A basic analyzer that scans for obvious malicious patterns like fs/child_process imports
 * or process.env access, which shouldn't be in a declarative workflow script.
 */
export class BasicSecurityAnalyzer extends WorkflowAnalyzer {
    async analyze(sourceCode) {
        let riskScore = 0;
        const warnings = [];

        // In a real system, we'd use an AST parser (like Acorn or Babel) to inspect imports and globals.
        // For this first implementation, we use simple heuristic regex matching.
        
        if (/(?:import|require)\s*\(\s*(?:'|")(?:fs|child_process|crypto|os|net|http)(?:'|")\s*\)/i.test(sourceCode) ||
            /import\s+.*(?:'|")(?:fs|child_process|crypto|os|net|http)(?:'|")/i.test(sourceCode)) {
            riskScore = Math.max(riskScore, 80);
            warnings.push("Imports a core Node.js system module which is not allowed in pure workflows.");
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
