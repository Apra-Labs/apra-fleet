// sprint-doctor PROPOSED REGISTRY ENTRY CAPTURE (design:
// fleet-sprint/docs/escalate-to-llm-design.md section 4.3).
//
// A doctor verdict MAY carry `proposedRegistryEntry` (contracts.mjs's
// `registryEntry` definition -- the same 4-field shape as a real
// doctor-registry.mjs entry) when it diagnoses a novel, recurring-looking
// symptom. This module is the ONLY place that proposal is ever touched after
// the verdict passes ajv validation: it sanitizes the entry's free-text
// fields (the same sanitizePrText() every other doctor-executor.mjs
// free-text field goes through before it is written or logged) and appends
// it, verbatim after that sanitization, as one JSON line to a
// `doctor-proposals.jsonl` artifact.
//
// WHAT THIS MODULE NEVER DOES: it never merges the proposal into
// doctor-registry.mjs's REGISTRY_ENTRIES, never imports that module, and
// performs no other mutation anywhere. Growing the registry from a proposal
// is a human PR against doctor-registry.mjs (design doc section 4.3), not an
// engine code path -- the same trust boundary the reviewer's `newTasks`
// field uses: propose in data, apply through the owner.
//
// Kept OUT of doctor-registry.mjs itself so that module stays pure data with
// no I/O, exactly as its own header requires.

import fs from 'node:fs';
import path from 'node:path';
import { sanitizePrText } from './sprint-report.mjs';

/**
 * Sanitizes every free-text leaf of a `proposedRegistryEntry` (already
 * ajv-schema-valid at this point -- contracts.mjs's `registryEntry`
 * definition) through sanitizePrText(), so the proposal committed to disk --
 * and later read by a human, or quoted into the harvest analysis text --
 * can never carry injected shell/markdown control sequences. Structure
 * (which fields exist) is preserved; only string leaf values change.
 * @param {object|null|undefined} entry
 * @returns {object|null} the sanitized entry, or null for a non-object input
 */
export function sanitizeProposedRegistryEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const detect = entry.detect && typeof entry.detect === 'object' ? entry.detect : {};
    const remedy = entry.remedy && typeof entry.remedy === 'object' ? entry.remedy : {};
    const verify = entry.verify && typeof entry.verify === 'object' ? entry.verify : {};
    return {
        id: sanitizePrText(entry.id || ''),
        classification: sanitizePrText(entry.classification || ''),
        detect: {
            reasons: Array.isArray(detect.reasons) ? detect.reasons.map((r) => sanitizePrText(r || '')) : [],
            signatureRe: typeof detect.signatureRe === 'string' ? sanitizePrText(detect.signatureRe) : null,
            scope: sanitizePrText(detect.scope || ''),
        },
        remedy: {
            verb: sanitizePrText(remedy.verb || ''),
            latch: sanitizePrText(remedy.latch || ''),
        },
        verify: {
            kind: sanitizePrText(verify.kind || ''),
        },
        fallback: sanitizePrText(entry.fallback || ''),
        humanReferralTemplate: sanitizePrText(entry.humanReferralTemplate || ''),
    };
}

/**
 * Sanitizes ONE `proposedRegistryEntry` and appends it, plus the consult
 * context that produced it, as a single JSON line to `artifactPath` -- never
 * into doctor-registry.mjs's REGISTRY_ENTRIES, which this module does not
 * even import. Best-effort by construction: any artifact write failure is
 * logged and swallowed, exactly like doctor-ledger.mjs's own
 * appendArtifactLine -- a proposal capture failure must never fail the
 * consult it rides along with.
 * @param {{
 *   artifactPath?: string|null,
 *   proposedRegistryEntry: object,
 *   trigger?: string|null,
 *   beadIds?: string[],
 *   member?: string|null,
 *   classification?: string|null,
 *   confidence?: string|null,
 *   log?: (msg: string) => void,
 * }} opts
 * @returns {object|null} the row captured (sanitized entry plus context), or
 *   null when the input did not sanitize to anything usable (no id)
 */
export function captureDoctorProposal({
    artifactPath = null,
    proposedRegistryEntry,
    trigger = null,
    beadIds = [],
    member = null,
    classification = null,
    confidence = null,
    log = () => {},
} = {}) {
    const sanitized = sanitizeProposedRegistryEntry(proposedRegistryEntry);
    if (!sanitized || !sanitized.id) return null;

    const row = {
        timestamp: Date.now(),
        trigger,
        beadIds: Array.isArray(beadIds) ? beadIds.slice() : [],
        member,
        classification,
        confidence,
        proposedRegistryEntry: sanitized,
    };

    if (artifactPath) {
        try {
            fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
            fs.appendFileSync(artifactPath, `${JSON.stringify(row)}\n`, 'utf8');
        } catch (err) {
            log(`[doctor-proposals] failed to append to artifact ${artifactPath}: ${(err && err.message) || err}`);
        }
    }

    return row;
}
