// apra-fleet-spp.5: shared parser for the runner.js integ-test-runner
// dispatch prompt's "verification-closure: <ids>. For each, verify ..."
// clause (see fleet-sprint/runner.js's verifyClause, ~line 7862-7864).
//
// The verify-routed bead ids in this clause are comma-separated and, per
// this project's standard decomposed-child id form (e.g. apra-fleet-eft.52),
// MAY themselves contain a literal '.'. A capture anchored on the first '.'
// (e.g. /([^.]+)\./) truncates a dotted id down to its parent prefix and
// would make a mock/consumer act against the WRONG bead. Anchor on the
// actual clause terminator ("For each,") instead, non-greedily, so dots
// inside ids are preserved.
export function extractVerifyIds(prompt) {
    const verifyMatch = prompt.match(/verification-closure:\s*(.+?)\.\s*For each,/);
    if (!verifyMatch) return [];
    return verifyMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
}
