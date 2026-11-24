// Test helper: answers the engine's bd/dolt version probes with the PINNED
// versions (derived from tool-version-pin.mjs so a pin bump never inverts a
// test), for fake member command() collaborators in beads-view tests.
import { BEADS_VERSION, DOLT_VERSION, TOOL_VERSION_PROBES } from '../../fleet-sprint/tool-version-pin.mjs';

/** The result for a version probe command, or null when `cmd` is not one. */
export function answerVersionProbe(cmd, { bd = BEADS_VERSION, dolt = DOLT_VERSION } = {}) {
    if (cmd === TOOL_VERSION_PROBES.bd) return { ok: true, output: `bd version ${bd}\n` };
    if (cmd === TOOL_VERSION_PROBES.dolt) return { ok: true, output: `dolt version ${String(dolt).replace(/^v/, '')}\n` };
    return null;
}

/** A version older/newer than `pin` by one minor ("1.3.0" -> "1.4.0"). */
export function offPinMinor(pin) {
    const [maj, min, pat] = String(pin).replace(/^v/, '').split('.').map(Number);
    return `${maj}.${min + 1}.${pat}`;
}

/** Wrap a command() so version probes are answered with pinned versions first. */
export function withPinnedVersions(command, versions = {}) {
    return async (cmd, opts) => answerVersionProbe(cmd, versions) ?? command(cmd, opts);
}
