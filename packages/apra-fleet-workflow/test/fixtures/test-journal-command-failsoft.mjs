// Fixture for apra-fleet-workflow-journal.test.mjs (apra-fleet-unw2.13, N5).
//
// Mirrors the runner.js probeFileExists() shape: a failSoft command() probe
// followed by a phase-gating decision (`deploySkipped`), plus a plain
// (non-failSoft) command() call for contrast. Lets tests assert that a
// resumed/replayed run reconstructs the SAME `{ ok, output, error }` shape
// (and therefore the same downstream `deploySkipped` decision) the original
// live run produced -- not a bare string that silently reads `.ok` as
// `undefined`.
export async function main(context) {
    const { command } = context;
    const probe = await command('test -f deploy-marker', { member_name: 'fleet-dev', label: 'probe', failSoft: true });
    // Mirrors runner.js: a failSoft probe result gates whether a later phase
    // (e.g. Deploy/Integ) runs at all.
    const deploySkipped = !probe.ok;
    const plain = await command('echo plain-output', { member_name: 'fleet-dev', label: 'plain-command' });
    return { probe, deploySkipped, plain };
}
