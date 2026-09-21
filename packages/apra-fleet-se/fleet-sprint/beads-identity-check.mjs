// =============================================================================
// Beads identity precondition: prove which .beads every member will mutate
// BEFORE the sprint issues its first mutating bd command.
//
// fleet-sprint never runs bd itself -- every bd goes to a member and runs in
// that member's workFolder, so bd's own cwd discovery decides which database
// a sprint mutates. Nothing else in the engine verifies that the database a
// member resolves to is the project the supervisor launched the sprint for.
// This module runs the three read-only probes from beads-identity.mjs on the
// orchestrator member first and then on every other distinct member, and
// compares each answer against the expected identity. The expected identity
// is either the supervisor's (`--expect-beads`, args.expectBeads) or, absent
// that, the orchestrator member's own probed identity -- in which case only
// the OTHER members are compared and the log says so.
//
// Severity model (deliberate):
//   - MISMATCH is FATAL: a field that resolved on BOTH sides and differs
//     means the member's bd points at a different project. Throws
//     BeadsIdentityError (reason MISMATCH) before any bd mutation.
//   - an UNRESOLVED probe is a WARNING: a probe that failed, or answered
//     something unparseable/empty, leaves that field out of the comparison.
//     The warning names the member, the field, the probe, the error and the
//     fix, so the operator can repair it; the first real bd on that member
//     surfaces a genuinely broken member exactly as it does today. Every
//     warning is logged with the `[beads-identity] WARNING:` prefix, and
//     collected into the published `beadsIdentity` state (`warnings`, plus
//     a per-member `unresolved` field list) so the viewer can show it.
//
// Every command() call here names its member explicitly (dispatch-safety
// guard) and is issued failSoft + silent, like every other read-only probe in
// this package. Each member is probed at most once per run.
// =============================================================================

import {
    BEADS_IDENTITY_PROBES,
    COMPARED_FIELDS,
    parseBeadsIdentity,
    compareIdentity,
    formatBeadsIdentity,
} from './beads-identity.mjs';
import { BeadsIdentityError, BEADS_IDENTITY_FAILURE_REASONS } from './errors.mjs';

// Short: three cheap local reads per member. A member that cannot answer
// `bd where` inside a minute is not a member this sprint should mutate.
export const BEADS_IDENTITY_PROBE_TIMEOUT_S = 60;

const LABEL = 'beads-identity';
export const BEADS_IDENTITY_WARNING_PREFIX = '[beads-identity] WARNING: ';

// Which probe each compared field comes from, and the operator-facing fix
// when that field could not be resolved on a member. Generic on purpose: no
// product paths, no host-specific text.
const FIELD_PROBE = Object.freeze({
    prefix: 'where',
    syncRemote: 'syncRemote',
    repoRemote: 'repoRemote',
});

export const BEADS_IDENTITY_FIELD_FIX = Object.freeze({
    prefix: "run 'bd where' in the member's workFolder; ensure bd is installed there and the folder contains the project's .beads",
    syncRemote: "set it on that member with 'bd config set sync.remote <url>' in its workFolder",
    repoRemote: "the member's workFolder is not a git clone with an 'origin' remote; re-register the member with a real clone or add the remote",
});

function outputOf(res) {
    if (res && typeof res === 'object') return typeof res.output === 'string' ? res.output : '';
    return typeof res === 'string' ? res : '';
}

function failureOf(res) {
    if (res && typeof res === 'object' && res.ok === false) return String(res.error || 'command failed');
    return null;
}

// One line (a warning is one log line), capped.
function summarizeRaw(text) {
    const t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '(no output)';
    return t.length > 400 ? `${t.slice(0, 400)}...` : t;
}

/**
 * A per-run prober: runs the three identity probes on a member through the
 * injected command() and memoizes the result so a member is probed once.
 *
 * @param {{ command: Function, timeoutS?: number }} opts
 * @returns {{ probe: (member: string) => Promise<{ identity: object, raw: object, failures: Array<{probe: string, key: string, error: string}> }> }}
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
            if (failed !== null) failures.push({ probe: cmd, key, error: failed });
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

// Why a probe key resolved to nothing on this member: its recorded failure,
// else the (unparseable or empty) output it did return.
function probeDetail(probed, key) {
    const failure = probed.failures.find((f) => f.key === key);
    if (failure) return summarizeRaw(failure.error);
    const out = String(probed.raw[key] || '').trim();
    if (!out) return 'empty output';
    // `bd config get` answers an unset key with exit 0 and value "": the
    // probe worked, the value is simply not configured.
    if (key === 'syncRemote') return 'sync.remote is unset';
    return `unparseable output: ${summarizeRaw(out)}`;
}

// The member's `bd where` produced no database path: nothing to compare.
function noDatabaseWarning(member, probed) {
    return `member '${member}' reports no beads database in its workFolder ` +
        `('${BEADS_IDENTITY_PROBES.where}' -> ${probeDetail(probed, 'where')}); nothing to compare, the first bd command on it will surface the problem. ` +
        `To fix: ${BEADS_IDENTITY_FIELD_FIX.prefix}.`;
}

// One compared field is empty on the member's side.
function unresolvedFieldWarning(member, field, probed) {
    const key = FIELD_PROBE[field];
    return `member '${member}' could not report ${field} ('${BEADS_IDENTITY_PROBES[key]}' -> ${probeDetail(probed, key)}); not compared. ` +
        `To fix: ${BEADS_IDENTITY_FIELD_FIX[field]}.`;
}

// One compared field is empty on the EXPECTED side (the supplied
// --expect-beads carries no value for it, or the orchestrator it was derived
// from could not report it), so no member can be checked on it.
function unresolvedExpectedWarning(field, expectedFrom, orchestratorMember) {
    const source = expectedFrom === 'orchestrator'
        ? `the orchestrator member '${orchestratorMember}' it was derived from could not report ${field}`
        : `the supplied expected beads identity carries no ${field}`;
    return `${source}; ${field} is not compared on any member this sprint. ` +
        `To fix: ${BEADS_IDENTITY_FIELD_FIX[field]}${expectedFrom === 'orchestrator' ? ' (on the orchestrator member), or launch via the supervisor so --expect-beads is supplied' : ''}.`;
}

function noExpectationWarning(orchestratorMember, probed) {
    return `no expected beads identity was supplied and the orchestrator member '${orchestratorMember}' could not report its beads database ` +
        `('${BEADS_IDENTITY_PROBES.where}' -> ${probeDetail(probed, 'where')}); no cross-member beads identity check will happen this sprint. ` +
        `To restore it: fix the orchestrator member's beads (${BEADS_IDENTITY_FIELD_FIX.prefix}), or launch via the supervisor so --expect-beads is supplied.`;
}

function assertMatches(member, expected, actual, cmp) {
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
 * distinct member. Throws BeadsIdentityError (reason MISMATCH) before
 * returning when a field that resolved on both sides differs; every probe
 * that could not resolve a field is a logged + published warning instead.
 *
 * @param {{
 *   command: Function, log?: Function, publishState?: Function,
 *   orchestratorMember: string, members: string[],
 *   expected?: object|null, prober?: object, timeoutS?: number,
 * }} opts
 * @returns {Promise<{
 *   expected: object|null, expectedFrom: 'args'|'orchestrator'|'none',
 *   members: Record<string, object>, warnings: string[],
 * }>}
 *   `members[name]` is that member's probed identity record plus
 *   `unresolved: string[]` (the compared fields it could not report). A
 *   member with no beads database at all has NO entry -- only a warning.
 */
export async function verifyBeadsIdentity({ command, log = () => {}, publishState, orchestratorMember, members, expected = null, prober, timeoutS }) {
    if (typeof orchestratorMember !== 'string' || !orchestratorMember) {
        throw new TypeError('verifyBeadsIdentity: orchestratorMember must be a non-empty string');
    }
    const p = prober || createBeadsIdentityProber({ command, timeoutS });
    const ordered = [orchestratorMember, ...(Array.isArray(members) ? members : [])]
        .filter((m, i, arr) => typeof m === 'string' && m && arr.indexOf(m) === i);

    const warnings = [];
    const warn = (text) => {
        warnings.push(text);
        log(`${BEADS_IDENTITY_WARNING_PREFIX}${text}`);
    };
    const result = { expected: null, expectedFrom: 'args', members: {}, warnings };

    const orchestratorProbe = await p.probe(orchestratorMember);
    const orchestratorHasDb = !!orchestratorProbe.identity.beadsDir;

    let expectedIdentity = expected;
    if (!expectedIdentity) {
        if (orchestratorHasDb) {
            result.expectedFrom = 'orchestrator';
            expectedIdentity = { ...orchestratorProbe.identity };
            log(`[beads-identity] no expected beads identity was supplied; taking the expectation from the orchestrator member '${orchestratorMember}'.`);
        } else {
            result.expectedFrom = 'none';
            warn(noExpectationWarning(orchestratorMember, orchestratorProbe));
        }
    }
    result.expected = expectedIdentity;

    // Fields the expectation itself lacks: warned once, up front, so the
    // per-member loop below never repeats them for every member.
    const expectedUnresolved = new Set();
    if (expectedIdentity) {
        for (const field of COMPARED_FIELDS) {
            if (!String(expectedIdentity[field] ?? '').trim()) {
                expectedUnresolved.add(field);
                warn(unresolvedExpectedWarning(field, result.expectedFrom, orchestratorMember));
            }
        }
    }

    // Checks one probed member: warns for what it could not report, throws
    // on a genuine mismatch, records the identity (or nothing at all when
    // it has no database). `compare` is false for the orchestrator when the
    // expectation was taken from it.
    function settle(member, probed, compare) {
        if (!probed.identity.beadsDir) {
            warn(noDatabaseWarning(member, probed));
            return;
        }
        const cmp = expectedIdentity
            ? compareIdentity(expectedIdentity, probed.identity, { skipUnresolved: true })
            : { ok: true, mismatches: [], unresolved: [] };
        const unresolved = [];
        for (const field of COMPARED_FIELDS) {
            if (String(probed.identity[field] ?? '').trim()) continue;
            unresolved.push(field);
            // The orchestrator's own gaps were already reported above as the
            // expectation's gaps when the expectation came from it.
            if (compare || !expectedUnresolved.has(field)) warn(unresolvedFieldWarning(member, field, probed));
        }
        if (compare) assertMatches(member, expectedIdentity, probed.identity, cmp);
        result.members[member] = { ...probed.identity, unresolved };
        log(formatBeadsIdentity(probed.identity, { label: `beads ok: ${member}` }));
    }

    settle(orchestratorMember, orchestratorProbe, !!expected);

    for (const member of ordered) {
        if (member === orchestratorMember) continue;
        const probed = await p.probe(member);
        settle(member, probed, !!expectedIdentity);
    }

    if (typeof publishState === 'function') {
        publishState('beadsIdentity', {
            expected: result.expected,
            expectedFrom: result.expectedFrom,
            members: result.members,
            warnings: [...warnings],
        });
    }
    return result;
}
