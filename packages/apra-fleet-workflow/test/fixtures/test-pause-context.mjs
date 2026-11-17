// Fixture for apra-fleet-workflow-pause-resume.test.mjs (apra-fleet-hzeb.3).
// Run via WorkflowEngine.executeFile(): asserts requestPause/requestResume
// are present as functions on the real per-run context (the one
// runWithContext()/_bindPrimitives() builds for executeFile() callers, not
// just the legacy createContext() path), then exercises a self-initiated
// pause -- with resumeAt/source metadata -- and resumes itself so the run
// completes normally.
export async function main(context) {
    const { agent, requestPause, requestResume } = context;

    const sawRequestPause = typeof requestPause === 'function';
    const sawRequestResume = typeof requestResume === 'function';

    requestPause('usage limit hit', { resumeAt: '2099-01-01T00:00:00.000Z', source: 'usage_limit' });
    await requestResume('limit reset');

    const result = await agent('hello', { member_name: 'fleet-dev' });
    return { sawRequestPause, sawRequestResume, result };
}
