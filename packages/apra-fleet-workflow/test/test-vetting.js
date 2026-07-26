export const meta = { name: 'test-vetting' };

// This script deliberately imports a core Node.js module to trigger the
// BasicSecurityAnalyzer's heuristic (riskScore 80, see vetting.mjs). Vetting
// is advisory-only by default (apra-fleet-unw.7) -- WorkflowEngine.executeFile()
// logs the warning but still runs this script to completion unless the
// caller opts into { strictVetting: true }, in which case executeFile()
// throws before this module is ever imported/executed.
export async function main() {
    const child_process = await import('child_process');
    return { status: 'success', hasExecSync: typeof child_process.execSync === 'function' };
}
