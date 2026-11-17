// =============================================================================
// PHASE MODULE: Clock Skew Check (Sprint Setup).
//
// Advisory-only probe of each branch-ensured member's wall clock against the
// hub's, so a skewed member clock is surfaced as a WARNING in the sprint log
// instead of silently making the stall detector kill healthy dispatches later
// in the sprint. Never throws, never aborts: both probe attempts are
// failSoft, and every helper below degrades a bad reading to "unparsable".
//
// Called from phases/ensure-sprint-branch.mjs, inside group('Sprint Setup'),
// right after the Ensure Sprint Branch checkout loop -- so it probes exactly
// the members that phase ensured, and the phase label sits in the same group.
//
// GUARD COVERAGE: registered as 'phases/clock-skew-check.mjs' in
// ../guarded-modules.mjs. Two command() call sites (the POSIX probe and its
// PowerShell fallback), both member_name-bearing.
// =============================================================================

// Cross-shell epoch probes. The phase brackets one of these with a hub-side
// Date.now() before and after, without assuming which shell the member runs.
//   - POSIX: `date +%s` (epoch SECONDS) is supported by GNU, BSD/macOS and
//     busybox date alike. A millisecond format (%3N) is GNU-only: BSD date
//     prints a literal "3N", which would leave every macOS member unmeasured.
//     Second resolution is ample against a threshold measured in tens of
//     seconds; the phase widens the bracket to whole seconds to match.
//   - Windows: PowerShell's DateTimeOffset gives epoch milliseconds directly.
// On a PowerShell member the POSIX probe fails (`date` is Get-Date there) and
// the fallback runs; on a POSIX member the PowerShell probe is never reached.
export const CLOCK_SKEW_PROBE_POSIX = 'date +%s';
export const CLOCK_SKEW_PROBE_WINDOWS = '[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()';

// Epoch seconds stay at most 11 digits until the year 5138; epoch millis are
// 13 digits today. Anything this short is a seconds reading.
const MAX_EPOCH_SECONDS_DIGITS = 11;

// Extracts an epoch-millis integer from a probe's stdout. Never throws: a
// probe can emit anything from a shell without the expected command. Takes
// the first all-digit token in the trimmed output, scaling a seconds reading
// (<= 11 digits) to millis; anything else -- "date: illegal option", a
// literal "%3N"/"3N" suffix, PowerShell error text -- yields null, never NaN.
export function parseEpochMillis(stdout) {
    const trimmed = typeof stdout === 'string' ? stdout.trim() : '';
    if (!trimmed) return null;
    const [firstToken] = trimmed.split(/\s+/);
    if (!/^\d+$/.test(firstToken)) return null;
    const value = parseInt(firstToken, 10);
    if (!Number.isFinite(value)) return null;
    return firstToken.length <= MAX_EPOCH_SECONDS_DIGITS ? value * 1000 : value;
}

// Advisory clock-skew threshold: a quarter of the stall threshold, read from
// the same STALL_THRESHOLD_MS env var the stall detector honours, with the
// same parseInt-with-fallback shape. Falls back to 120000/4 on an unset or
// unparsable value.
export function clockSkewThresholdMs(env) {
    const raw = env ? env.STALL_THRESHOLD_MS : undefined;
    const parsed = parseInt(raw ?? '120000', 10);
    return (Number.isFinite(parsed) ? parsed : 120000) / 4;
}

// Pure decision helper. hubT0/hubT1 bracket the member-side probe; a member
// reading inside [hubT0, hubT1] is zero skew (probe round-trip latency is not
// skew). NEVER throws: a bad reading degrades to an "unparsable" result.
export function evaluateClockSkew({ hubT0, hubT1, memberEpochMs, thresholdMs }) {
    if (typeof memberEpochMs !== 'number' || !Number.isFinite(memberEpochMs)) {
        return { ok: false, skewMs: null, exceeded: false, reason: 'unparsable' };
    }

    let skewMs;
    if (memberEpochMs > hubT1) {
        skewMs = memberEpochMs - hubT1;
    } else if (memberEpochMs < hubT0) {
        skewMs = memberEpochMs - hubT0;
    } else {
        skewMs = 0;
    }

    return {
        ok: true,
        skewMs,
        exceeded: Math.abs(skewMs) > thresholdMs,
        reason: null,
    };
}

/**
 * Runs the Clock Skew Check phase over every branch-ensured member.
 *
 * @param {{
 *   command: Function,
 *   log: (msg: string) => void,
 *   phase: (label: string) => void,
 *   branchEnsureMembers: string[],
 *   env?: Record<string, string|undefined>,
 * }} state
 * @returns {Promise<void>}
 */
export async function runClockSkewCheckPhase({ command, log, phase, branchEnsureMembers, env = process.env }) {
    phase('Clock Skew Check');
    const thresholdMs = clockSkewThresholdMs(env);
    for (const member of branchEnsureMembers) {
        const hubT0 = Date.now();
        // Try the POSIX probe first; fall back to the PowerShell probe only if
        // it failed or its output was not an epoch reading. The hub's own OS
        // says nothing about the member's, so there is no platform branch.
        let probeResult = await command(CLOCK_SKEW_PROBE_POSIX, {
            member_name: member,
            silent: true,
            failSoft: true,
            label: `Probe clock on member '${member}'`,
        });
        let memberEpochMs = probeResult.ok ? parseEpochMillis(probeResult.output) : null;
        if (memberEpochMs === null) {
            probeResult = await command(CLOCK_SKEW_PROBE_WINDOWS, {
                member_name: member,
                silent: true,
                failSoft: true,
                label: `Probe clock on member '${member}'`,
            });
            memberEpochMs = probeResult.ok ? parseEpochMillis(probeResult.output) : null;
        }
        const hubT1 = Date.now();

        // A seconds-resolution reading truncates toward the start of its
        // second, so the lower bracket bound is floored to match; otherwise a
        // perfectly synced member would read up to 999ms "behind".
        const result = evaluateClockSkew({ hubT0: Math.floor(hubT0 / 1000) * 1000, hubT1, memberEpochMs, thresholdMs });

        if (!result.ok) {
            log(
                `Clock Skew Check: could not read the clock probe on member '${member}' -- skew was not measured.`
            );
        } else if (result.exceeded) {
            const direction = result.skewMs > 0 ? 'ahead of' : 'behind';
            const skewSeconds = (Math.abs(result.skewMs) / 1000).toFixed(1);
            log(
                `WARNING: Clock Skew Check: member '${member}' clock is ${direction} the hub by ` +
                `${Math.abs(result.skewMs)}ms (~${skewSeconds}s) -- stall detection may falsely abort this sprint ` +
                `for this member; resync the member clock.`
            );
        }
    }
}
