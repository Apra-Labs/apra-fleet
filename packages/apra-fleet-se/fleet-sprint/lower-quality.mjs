// =============================================================================
// Lower-quality-of-service visibility (parent feature b4g.65).
//
// When any sprint member's own fleet MCP was not verified at sprint init
// (member-init-probe.mjs records: { member, verified, reason, fix }), the KB
// and code tools are not usable there and its roles run on injected knowledge
// only. The sprint stays unblocked, but the operator must SEE the lower
// quality: one banner string, derived here once and reused by the viewer
// state, the sprint-summary WARN and the PR body line. Pure functions.
// =============================================================================

/**
 * @param {Array<{member?: string, verified?: boolean, reason?: string|null, fix?: string|null}>} records
 * @returns {{ total: number, unverified: object[], banner: string|null }}
 */
export function lowerQuality(records) {
    const recs = (Array.isArray(records) ? records : []).filter((r) => r && typeof r === 'object');
    const unverified = recs.filter((r) => r.verified !== true);
    const banner = unverified.length > 0
        ? `KB/code unavailable on ${unverified.length} of ${recs.length} members -- lower quality, expect higher token spend`
        : null;
    return { total: recs.length, unverified, banner };
}

/**
 * Log the banner as a WARN line (nothing when every member is verified).
 * `when` is 'init' or 'summary'; returns the banner or null.
 *
 * @param {Function} log
 * @param {string} prefix log prefix (e.g. '[member-init]')
 * @param {Array<object>} records
 * @param {'init'|'summary'} when
 */
export function logLowerQualityWarn(log, prefix, records, when) {
    const { banner } = lowerQuality(records);
    if (!banner) return null;
    log(`${prefix} WARN ${when === 'summary' ? 'sprint summary: ' : ''}${banner}`);
    return banner;
}
