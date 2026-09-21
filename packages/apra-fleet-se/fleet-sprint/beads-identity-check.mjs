// =============================================================================
// Beads identity precondition: prove which .beads every member will mutate
// BEFORE the sprint issues its first mutating bd command.
//
// fleet-sprint never runs bd itself -- every bd goes to a member and runs in
// that member's workFolder, so bd's own cwd discovery decides which database
// a sprint mutates. Nothing else in the engine verifies that the database a
// member resolves to is the project the supervisor launched the sprint for.
// This module runs the three read-only probes from beads-identity.mjs on the
// orchestrator member first and then on every other distinct member, compares
// each answer against the expected identity, and throws BeadsIdentityError on
// the first probe failure or mismatch. The expected identity is either the
// supervisor's (`--expect-beads`, args.expectBeads) or, absent that, the
// orchestrator member's own probed identity -- in which case only the OTHER
// members are compared and the log says so.
//
// Every command() call here names its member explicitly (dispatch-safety
// guard) and is issued failSoft + silent, like every other read-only probe in
// this package. Each member is probed at most once per run.
// =============================================================================

import {
    BEADS_IDENTITY_PROBES,
    parseBeadsIdentity,
    compareIdentity,
    formatBeadsIdentity,
} from './beads-identity.mjs';
import { BeadsIdentityError, BEADS_IDENTITY_FAILURE_REASONS } from './errors.mjs';

// Short: three cheap local reads per member. A member that cannot answer
// `bd where` inside a minute is not a member this sprint should mutate.
export const BEADS_IDENTITY_PROBE_TIMEOUT_S = 60;

const LABEL = 'beads-identity';

function outputOf(res) {
    if (res && typeof res === 'object') return typeof res.output === 'string' ? res.output : '';
    return typeof res === 'string' ? res : '';
}

function failureOf(res) {
    if (res && typeof res === 'object' && res.ok === false) return String(res.error || 'command failed');
    return null;
}

function summarizeRaw(text) {
    const t = String(text || '').trim();
    if (!t) return '(no output)';
    return t.length > 400 ? `${t.slice(0, 400)}...` : t;
}

/**
 * A per-run prober: runs the three identity probes on a member through the
 * injected command() and memoizes the result so a member is probed once.
 *
 * @param {{ command: Function, timeoutS?: number }} opts
 * @returns {{ probe: (member: string) => Promise<{ identity: object, raw: object, failures: Array<{probe: string, error: string}> }> }}
 */
export function createBeadsIdentityProber({ command, timeoutS = BEADS_IDENTITY_PROBE_TIMEOUT_S }) {
    if (typeof command !== 'function') {
        throw new TypeError('createBeadsIdentityProber({ command }): command must be a function');
    }
    const cache = new Map();

    async function runProbes(member) {
        const raw = {};
        const failures = [];
        for (const [key, cmd] of Object.entries(BEADS_IDENTITY_PROBES)) {
            let res;
            try {
                res = await command(cmd, { member_name: member, silent: true, failSoft: true, label: LABEL, timeout_s: timeoutS });
            } catch (err) {
                res = { ok: false, output: '', error: err && err.message ? err.message : String(err) };
            }
            const failed = failureOf(res);
            raw[key] = outputOf(res);
            if (failed !== null) failures.push({ probe: cmd, error: failed });
        }
        return { identity: parseBeadsIdentity(raw), raw, failures };
    }

    return {
        probe(member) {
            let pending = cache.get(member);
            if (!pending) {
                pending = runProbes(member);
                cache.set(member, pending);
            }
            return pending;
        },
    };
}

function assertProbed(member, probed) {
    if (probed.failures.length > 0) {
        const detail = probed.failures.map((f) => `'${f.probe}' -> ${summarizeRaw(f.error)}`).join('; ');
        throw new BeadsIdentityError(
            `Beads identity check failed: member '${member}' could not report its beads database ` +
            `(no beads database found in the member's workFolder, or the probe failed): ${detail}`,
            { reason: BEADS_IDENTITY_FAILURE_REASONS.PROBE_FAILED, member, details: { raw: probed.raw } }
        );
    }
    if (!probed.identity.beadsDir) {
        throw new BeadsIdentityError(
            `Beads identity check failed: member '${member}' returned no parseable beads database from ` +
            `'${BEADS_IDENTITY_PROBES.where}' (no beads database found in the member's workFolder?). ` +
            `Output: ${summarizeRaw(probed.raw.where)}`,
            { reason: BEADS_IDENTITY_FAILURE_REASONS.PROBE_FAILED, member, details: { raw: probed.raw } }
        );
    }
}

function assertMatches(member, expected, actual) {
    const cmp = compareIdentity(expected, actual);
    if (cmp.ok) return;
    const lines = cmp.mismatches.map((m) => `${m.field}: expected '${m.expected || '(unset)'}', actual '${m.actual || '(unset)'}'`);
    throw new BeadsIdentityError(
        `Beads identity check failed: member '${member}' resolves to a different beads database than expected ` +
        `(${actual.beadsDir}) -- ${lines.join('; ')}. Refusing to mutate beads on it.`,
        { reason: BEADS_IDENTITY_FAILURE_REASONS.MISMATCH, member, mismatches: cmp.mismatches, details: { actual, expected } }
    );
}

/**
 * The precondition itself. Probes the orchestrator member, then every other
 * distinct member, and throws BeadsIdentityError before returning if any
 * probe fails or any identity mismatches `expected`.
 *
 * @param {{
 *   command: Function, log?: Function, publishState?: Function,
 *   orchestratorMember: string, members: string[],
 *   expected?: object|null, prober?: object, timeoutS?: number,
 * }} opts
 * @returns {Promise<{ expected: object, members: Record<string, object>, expectedFrom: 'args'|'orchestrator' }>}
 */
export async function verifyBeadsIdentity({ command, log = () => {}, publishState, orchestratorMember, members, expected = null, prober, timeoutS }) {
    if (typeof orchestratorMember !== 'string' || !orchestratorMember) {
        throw new TypeError('verifyBeadsIdentity: orchestratorMember must be a non-empty string');
    }
    const p = prober || createBeadsIdentityProber({ command, timeoutS });
    const ordered = [orchestratorMember, ...(Array.isArray(members) ? members : [])]
        .filter((m, i, arr) => typeof m === 'string' && m && arr.indexOf(m) === i);

    const orchestratorProbe = await p.probe(orchestratorMember);
    assertProbed(orchestratorMember, orchestratorProbe);

    let expectedFrom = 'args';
    let expectedIdentity = expected;
    if (!expectedIdentity) {
        expectedFrom = 'orchestrator';
        expectedIdentity = { ...orchestratorProbe.identity };
        log(`[beads-identity] no expected beads identity was supplied; taking the expectation from the orchestrator member '${orchestratorMember}'.`);
    } else {
        assertMatches(orchestratorMember, expectedIdentity, orchestratorProbe.identity);
    }

    const result = { expected: expectedIdentity, members: {}, expectedFrom };
    result.members[orchestratorMember] = orchestratorProbe.identity;
    log(formatBeadsIdentity(orchestratorProbe.identity, { label: `beads ok: ${orchestratorMember}` }));

    for (const member of ordered) {
        if (member === orchestratorMember) continue;
        const probed = await p.probe(member);
        assertProbed(member, probed);
        assertMatches(member, expectedIdentity, probed.identity);
        result.members[member] = probed.identity;
        log(formatBeadsIdentity(probed.identity, { label: `beads ok: ${member}` }));
    }

    if (typeof publishState === 'function') {
        publishState('beadsIdentity', { expected: result.expected, expectedFrom, members: result.members });
    }
    return result;
}
