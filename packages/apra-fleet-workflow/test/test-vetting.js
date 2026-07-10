export const meta = { name: 'test-vetting' };

async function main() {
    // This should trigger the BasicSecurityAnalyzer
    const child_process = import('child_process');
    console.log("If this runs, vetting failed!");
}
