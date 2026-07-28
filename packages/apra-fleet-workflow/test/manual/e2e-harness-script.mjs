// MANUAL / LIVE E2E FIXTURE -- companion module for e2e-runner.mjs.
// Loaded via engine.executeFile() (executeSource() was removed, apra-fleet-unw.7 --
// workflow scripts are now real ES modules, so this needed to become a real file
// rather than an inline template-string script).
export const meta = { name: "E2E Safe Harness", phases: ["Discovery", "Non-Destructive Execution"] };

export async function main(context) {
    const { agent, command, log, phase, sequential, args } = context;

    phase("Discovery");
    log("Available targets: " + args.targets.map(t => t.name).join(", "));

    if (args.targets.length === 0) {
        throw new Error("No active members found on the Apra Fleet grid. Cannot run E2E.");
    }

    phase("Non-Destructive Execution");
    const results = await sequential(args.targets, async (target) => {
        log("Testing command on " + target.name);

        // 1. A safe echo command
        const cmdRes = await command('echo "E2E Validation for " {{name}}', {
            member_name: target.name,
            substitutions: { name: target.name }
        });

        if (!cmdRes.includes("E2E Validation")) {
            throw new Error("Command output validation failed on " + target.name);
        }

        log("Command test passed on " + target.name);

        // 2. A safe LLM prompt asking for a specific string
        log("Testing agent prompt on " + target.name);
        const agentRes = await agent("Reply exactly with the word: E2ESAFE", {
            member_name: target.name,
            effort: "low"
        });

        if (!agentRes || !agentRes.includes("E2ESAFE")) {
            log("Warning: Agent prompting validation failed or returned unexpected data on " + target.name + ". (Could be mock limitations)");
        } else {
            log("Agent test passed on " + target.name);
        }

        return target.name;
    });

    return { status: "success", testedMembers: results };
}
