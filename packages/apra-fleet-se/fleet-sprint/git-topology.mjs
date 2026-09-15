// =============================================================================
// GIT TOPOLOGY -- the fleet's git-side preconditions and primitives
// (apra-fleet-3swo.6.3)
// =============================================================================
//
// Moved VERBATIM out of runner.js. This module owns the three layers the
// orchestrator's git sync sits ON TOP of, none of which are sync brackets
// themselves:
//
//   1. checkMemberTopology() -- the multi-member topology precondition
//      bin/cli.mjs runs BEFORE a sprint starts. Nothing here has run yet when
//      it is called; it decides whether a sprint may start at all.
//   2. classifyGitFailure() / runGitStep() / resolveGitProviderForClassification()
//      -- the ONE git-failure classifier (a thin adapter over
//      VCSModule.classifyFailure()), the single retrying git-command primitive
//      every bracket issues its commands through, and the fail-closed provider
//      lookup that threads a member's own VCS provider into the classifier.
//   3. commandResultToSoftGit() -- the exit-code-based `execute_command` ->
//      soft-git-result adapter the resume-path resync consumes.
//
// WHAT DELIBERATELY STAYED IN runner.js: the sync BRACKETS themselves
// (syncMemberBefore / syncMemberAfter / syncMemberAfterOrdered /
// resyncReacquiredMember). They are this layer's callers, not part of it, and
// they import runGitStep/resolveGitProviderForClassification from here.
//
// resolveGitProviderForClassification is exported ONLY because the brackets
// that still live in runner.js call it. It was module-private before the move
// and is NOT re-exported by runner.js's facade -- it stays reachable only
// through this module.
//
// Dependency-injection stance is unchanged: nothing here does I/O of its own.
// Every git command is issued via an injected command() with an explicit
// `member_name`, and every probe (getIdentity/getOriginUrl/doltProbe) is
// supplied by the caller, so unit tests drive all of it with no live fleet.
// =============================================================================

// classifyGitFailure() delegates to VCSModule -- the ONE place VCS stderr is
// parsed (vcs-module.mjs's own header comment). These two names were imported
// by runner.js for exactly this call before the move.
import { classifyFailure, toGitVerdict } from './vcs-module.mjs';

// ---------------------------------------------------------------------------
// Multi-member topology precondition
// ---------------------------------------------------------------------------
//
// A sprint stands up under one of two topology contracts, and this function is
// the gate that refuses to start when the fleet does not satisfy the one the
// caller named. Mode selection is EXPLICIT (`opts.mode`), never inferred: an
// unknown mode is a hard refusal, not a silent fallback.
//
// LEGACY (shared-workspace): there is no cross-member sync layer, so every
// member must resolve to the same checkout/DB. The orchestrator's `bd`
// commands run against ITS member's beads DB while each doer's `bd close`
// runs against its own, and the sprint git branch is only meaningful if all
// members share working state. Enforced by comparing an identity signal
// (cli.mjs wires it to `git rev-parse HEAD`) across members. Matching HEADs
// at start is a best-effort heuristic, not a guarantee of ongoing shared
// state: two independent checkouts sitting on the same commit would pass.
//
// SYNCED: the orchestrator-bracketed G-pull/G-push layer reconciles members by
// fast-forward pull/push, so differing HEADs between brackets are EXPECTED and
// a shared workspace is not required. The precondition instead becomes: every
// member reports the SAME `git remote get-url origin` (they push/pull the same
// remote branch) AND passes a `bd dolt pull` probe (their beads DB can sync).
//
// Inject-driven, with no direct I/O of its own, so cli.mjs can wire the probes
// to live fleet commands while tests supply per-member signals directly. A
// single member trivially passes. For 2+ members, a member whose signal cannot
// be obtained is a REFUSAL: shared state cannot be proven, so the sprint must
// not silently continue.
/**
 * @param {{
 *   members: string[],
 *   getIdentity?: (member: string) => Promise<string>,
 *   mode?: 'legacy'|'synced',
 *   getOriginUrl?: (member: string) => Promise<string>,
 *   doltProbe?: (member: string) => Promise<unknown>,
 * }} opts
 * @returns {Promise<{ ok: boolean, singleMember: boolean, mode: string, identities?: Array<object>, probes?: Array<object>, message: string }>}
 */
export async function checkMemberTopology({ members, getIdentity, mode = 'legacy', getOriginUrl, doltProbe }) {
    if (!Array.isArray(members) || members.length === 0) {
        return { ok: false, singleMember: false, mode, identities: [], message: '[Topology] Refusing to start: no members configured.' };
    }

    if (mode !== 'legacy' && mode !== 'synced') {
        return {
            ok: false,
            singleMember: members.length === 1,
            mode,
            message: `[Topology] Refusing to start: unknown topology mode '${mode}'. Mode must be selected explicitly as 'legacy' (shared-workspace, same-HEAD) or 'synced' (orchestrator-bracketed git sync, same-origin + dolt probe).`,
        };
    }

    if (members.length === 1) {
        return {
            ok: true,
            singleMember: true,
            mode,
            identities: [{ member: members[0], signal: null, error: null }],
            message: `[Topology] Single-member ${mode} sprint ('${members[0]}') -- shared-state precondition trivially satisfied (nothing to compare).`,
        };
    }

    // -----------------------------------------------------------------------
    // SYNCED mode: same-origin + dolt-probe precondition. HEADs are ALLOWED to
    // differ -- reconciliation is the sync layer's job.
    // -----------------------------------------------------------------------
    if (mode === 'synced') {
        if (typeof getOriginUrl !== 'function' || typeof doltProbe !== 'function') {
            return {
                ok: false,
                singleMember: false,
                mode,
                message: '[Topology] Refusing to start the synced-mode sprint: getOriginUrl and doltProbe must both be provided so the same-origin and dolt-pull preconditions can be checked.',
            };
        }

        const probes = [];
        for (const member of members) {
            let originUrl = null;
            let originError = null;
            let doltOk = false;
            let doltError = null;
            try {
                const raw = await getOriginUrl(member);
                const url = (typeof raw === 'string' ? raw : String(raw)).trim();
                if (url) originUrl = url; else originError = 'empty origin URL';
            } catch (err) {
                originError = (err && err.message) ? err.message : String(err);
            }
            try {
                await doltProbe(member);
                doltOk = true;
            } catch (err) {
                doltError = (err && err.message) ? err.message : String(err);
            }
            probes.push({ member, originUrl, originError, doltOk, doltError });
        }

        // A member that failed EITHER precondition (origin URL unavailable, or
        // a failing dolt probe) is rejected, naming the member and which
        // precondition failed.
        const failedPrecondition = probes.filter((p) => p.originError !== null || !p.doltOk);
        if (failedPrecondition.length > 0) {
            const detail = failedPrecondition.map((p) => {
                const reasons = [];
                if (p.originError !== null) reasons.push(`origin URL unavailable (${p.originError})`);
                // "dolt pull probe" (not "bd dolt pull") deliberately -- this is
                // prose describing what doltProbe() checks, not a literal
                // command; keeping the exact 'bd dolt pull'/'bd dolt push' tokens
                // out of message text keeps this file clean for the
                // dolt-literal-guard.mjs mechanical scan (apra-fleet-417.2.3),
                // which flags any such literal outside a comment/import as a
                // reintroduced direct dolt command.
                if (!p.doltOk) reasons.push(`dolt pull probe failed (${p.doltError})`);
                return `${p.member}: ${reasons.join('; ')}`;
            }).join(', ');
            return {
                ok: false,
                singleMember: false,
                mode,
                probes,
                message:
                    '[Topology] Refusing to start the synced-mode sprint: one or more members failed a sync precondition -- ' +
                    detail +
                    '. In synced mode every member must report the same origin URL AND pass a dolt-pull sync probe. ' +
                    'See docs/architecture.md "Multi-member topology (fleet-sprint)".',
            };
        }

        // All members pass the dolt probe -- now they must share ONE origin.
        const distinctOrigins = [...new Set(probes.map((p) => p.originUrl))];
        if (distinctOrigins.length > 1) {
            return {
                ok: false,
                singleMember: false,
                mode,
                probes,
                message:
                    '[Topology] Refusing to start the synced-mode sprint: the configured members report DIVERGENT origin URLs, so ' +
                    'they do not push/pull the same remote branch and the git sync layer cannot reconcile them. Per-member origins: ' +
                    probes.map((p) => `${p.member}=${p.originUrl}`).join(', ') +
                    '. Every member must report the same `git remote get-url origin`. ' +
                    'See docs/architecture.md "Multi-member topology (fleet-sprint)".',
            };
        }

        return {
            ok: true,
            singleMember: false,
            mode,
            probes,
            message: `[Topology] Synced mode: all ${members.length} configured members share origin '${distinctOrigins[0]}' and passed the dolt-pull probe -- differing HEADs are reconciled by the git sync layer.`,
        };
    }

    // -----------------------------------------------------------------------
    // LEGACY mode: shared-workspace same-HEAD identity check.
    // -----------------------------------------------------------------------
    if (typeof getIdentity !== 'function') {
        return {
            ok: false,
            singleMember: false,
            mode,
            message: '[Topology] Refusing to start the legacy-mode sprint: getIdentity must be provided so the same-HEAD precondition can be checked.',
        };
    }

    const identities = [];
    for (const member of members) {
        try {
            const raw = await getIdentity(member);
            const signal = (typeof raw === 'string' ? raw : String(raw)).trim();
            identities.push({ member, signal: signal || null, error: signal ? null : 'empty identity signal' });
        } catch (err) {
            identities.push({ member, signal: null, error: (err && err.message) ? err.message : String(err) });
        }
    }

    const unresolved = identities.filter((i) => i.error !== null);
    if (unresolved.length > 0) {
        return {
            ok: false,
            singleMember: false,
            mode,
            identities,
            message:
                '[Topology] Refusing to start the multi-member sprint: could not obtain an identity signal from every ' +
                'configured member, so a shared-workspace setup cannot be verified. Per-member results: ' +
                identities.map((i) => `${i.member}=${i.error ? `ERROR(${i.error})` : i.signal}`).join(', ') +
                '. The only supported multi-member mode is a verified shared workspace (all members resolve to the same ' +
                'checkout/DB); otherwise run single-member. See docs/architecture.md "Multi-member topology (fleet-sprint)".',
        };
    }

    const distinct = [...new Set(identities.map((i) => i.signal))];
    if (distinct.length > 1) {
        return {
            ok: false,
            singleMember: false,
            mode,
            identities,
            message:
                '[Topology] Refusing to start the multi-member sprint in legacy mode: the configured members disagree on ' +
                'their identity signals (are on differing HEADs). Re-run with --sync to enable cross-member sync mode, which ' +
                'tolerates differing HEADs and uses orchestrator-bracketed git sync to reconcile them. Per-member signals: ' +
                identities.map((i) => `${i.member}=${i.signal}`).join(', ') +
                '. See docs/architecture.md "Multi-member topology (fleet-sprint)" for details.',
        };
    }

    return {
        ok: true,
        singleMember: false,
        mode,
        identities,
        message: `[Topology] All ${members.length} configured members share the same identity signal (${distinct[0]}) -- shared-state precondition satisfied.`,
    };
}

// apra-fleet-647.1.3.2: the git stderr/stdout pattern lists that used to live
// here (GIT_DIVERGED_PATTERNS, GIT_AUTH_PATTERNS, GIT_TRANSIENT_PATTERNS) are
// GONE -- classifyGitFailure() below delegates to VCSModule.classifyFailure(),
// the ONE place VCS stderr is parsed (vcs-module.mjs's own header comment).
// The default 'github' provider chain (GitHubVCS -> GenericGitVCS, see
// ./vcs-providers/github.mjs and ./generic-git.mjs) reproduces every pattern
// that lived in the three deleted lists verbatim -- built for exactly this
// migration in apra-fleet-647.1.3.1 -- so this is a delegation, not a
// behavior change.

/**
 * Classify a failed git command's output into the failure classes the sync
 * brackets route differently. Thin adapter over VCSModule.classifyFailure()
 * + toGitVerdict(), mapping the neutral kind taxonomy onto this module's
 * legacy verdict vocabulary with NO verdict change from the deleted
 * pattern-list classifier.
 *
 * apra-fleet-417.7: `provider` is optional and, when supplied, selects the
 * member's own resolved VCS provider chain (e.g. 'azure-devops',
 * 'bitbucket') instead of the default 'github' chain -- this is what makes
 * azure-devops.mjs's TF401019 and bitbucket.mjs's app-password rules
 * reachable at runtime; they are NOT inherited by the default chain (see
 * vcs-nongithub-auth-selfheal.test.mjs). Omitting it (every call site that
 * cannot resolve a provider) reproduces the prior provider-agnostic default
 * exactly -- NO verdict change for GitHub members or any caller that does
 * not pass one.
 *
 * @param {string} output - the raw git stderr/stdout of the failed command
 * @param {string} [provider] - the member's resolved VCS provider; falls back
 *   to VCSModule's default ('github') chain when omitted/falsy.
 * @returns {'diverged'|'auth'|'transient'|'unknown'}
 */
export function classifyGitFailure(output, provider) {
    return toGitVerdict(classifyFailure(output, provider ? { provider } : undefined).kind);
}

/**
 * Run a single git command via the injected command() with failSoft, retrying
 * ONLY transient failures up to `maxTransientRetries` times. A diverged (or
 * unknown) failure is returned immediately, never retried.
 *
 * An optional injected `onAuthFailure` async callback adds a DISTINCT, bounded
 * one-shot self-heal path, deliberately NOT folded into the
 * `maxTransientRetries` loop. When a command fails with an 'auth'
 * classification (see classifyGitFailure) and `onAuthFailure` is provided, it
 * is called EXACTLY ONCE (never in a loop, even if the retry fails with 'auth'
 * again); if it resolves without throwing, the SAME command is retried exactly
 * once more. If `onAuthFailure` throws, or is omitted, the failed result is
 * returned as-is for the caller to turn into its typed
 * GitSyncError/GitDivergedError.
 *
 * apra-fleet-647.1.3.3: an 'unknown' classification (any provider auth/failure
 * text classifyGitFailure could not otherwise recognize) gets the SAME bounded
 * one-shot self-heal + single retry as 'auth', rather than failing immediately
 * -- an unrecognized provider auth string is far more likely to be a stale
 * credential than a genuinely fatal condition, and one bounded self-heal
 * attempt is cheap. This shares the single `authHealAttempted` latch with the
 * 'auth' path, so the self-heal still fires AT MOST ONCE per runGitStep call
 * regardless of whether it was triggered by 'auth' or 'unknown'. A 'diverged'
 * classification is excluded from this and is still returned immediately,
 * never retried -- see the module header's SINGLE-WRITER TOKEN PASSING stance.
 *
 * apra-fleet-417.7: an optional `provider` (the member's own resolved VCS
 * provider, e.g. from VCSModule.resolveProvider()) is threaded straight into
 * classifyGitFailure() so a vendor-specific AUTH rule (azure-devops.mjs's
 * TF401019, bitbucket.mjs's app-password literal) is reachable here, not just
 * from a caller that names the provider directly against classifyFailure().
 * Omitting it (unresolvable/absent provider) falls back to today's default
 * 'github' chain -- no throw, no new failure mode, no verdict change for
 * GitHub members.
 *
 * @returns {Promise<{ ok: boolean, output: string, error: string|null, kind?: 'diverged'|'auth'|'transient'|'unknown' }>}
 */
export async function runGitStep({ command, member, cmd, label, log, maxTransientRetries, onAuthFailure, provider }) {
    let attempt = 0;
    let authHealAttempted = false;
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const res = await command(cmd, { member_name: member, silent: true, failSoft: true, label });
        if (res && res.ok) return res;
        const error = res ? res.error : 'unknown command failure';
        const kind = classifyGitFailure(error, provider);
        if (kind === 'transient' && attempt < maxTransientRetries) {
            attempt += 1;
            log(`[Sync] transient git failure for member '${member}' (${label}); retry ${attempt}/${maxTransientRetries}: ${error}`);
            continue;
        }
        if ((kind === 'auth' || kind === 'unknown') && typeof onAuthFailure === 'function' && !authHealAttempted) {
            authHealAttempted = true;
            log(`[Sync] ${kind} git failure for member '${member}' (${label}); invoking self-heal (provision_vcs_auth) once before a single bounded retry: ${error}`);
            try {
                await onAuthFailure({ member, label, cmd, error, kind: 'git' });
            } catch (healErr) {
                log(`[Sync] self-heal for member '${member}' (${label}) failed; not retrying further: ${healErr.message}`);
                return { ok: false, output: res ? res.output : '', error, kind };
            }
            log(`[Sync] self-heal for member '${member}' (${label}) completed; retrying the failed git command once.`);
            continue;
        }
        return { ok: false, output: res ? res.output : '', error, kind };
    }
}

/**
 * Resolve `member`'s VCS provider via an injected `resolveMemberProvider`
 * (see createMemberVcsProviderResolver below) for threading into
 * classifyGitFailure(), failing CLOSED to `undefined` (today's default
 * 'github' chain) on any error or when no resolver was injected -- this must
 * never throw, since a provider-resolution hiccup must never abort a sync
 * bracket that would otherwise succeed on the default chain.
 *
 * @param {((member: string) => Promise<string|undefined>)|undefined} resolveMemberProvider
 * @param {string} member
 * @param {Function} log
 * @returns {Promise<string|undefined>}
 */
export async function resolveGitProviderForClassification(resolveMemberProvider, member, log) {
    if (typeof resolveMemberProvider !== 'function') return undefined;
    try {
        return await resolveMemberProvider(member);
    } catch (err) {
        log(`[Sync] could not resolve member '${member}'s VCS provider for git-failure classification (falling back to the default provider chain, no verdict change for GitHub members): ${err.message}`);
        return undefined;
    }
}

/**
 * (apra-fleet-p2to.4.2) Map an `execute_command` tool result to the SOFT git
 * runner contract resyncReacquiredMember() consumes:
 *   { ok: boolean, stdout?: string, error?: string }
 *
 * `ok` MUST be derived from the command's real EXIT CODE, never from an
 * `isError` flag: the fleet server's `execute_command` tool does NOT set
 * `isError` on a non-zero exit (see src/services/tool-registry.ts wrapTool() --
 * it returns `{ content, structuredContent: { exitCode } }` with no isError,
 * and src/tools/execute-command.ts formats the text as `Exit code: N\n...`).
 * Reading `isError` here would make EVERY git command look successful, which is
 * catastrophic for `git merge-base --is-ancestor` where the whole point is that
 * a NON-zero exit (1 = "not an ancestor") is the meaningful signal: misreading
 * it as ok=true collapses 'ahead'/'diverged' into 'behind-or-equal' and lets
 * resyncReacquiredMember() run `git checkout -B <branch> origin/<branch>`,
 * resetting away committed-but-unpushed work. So: prefer the structured
 * `exitCode`, else parse the `Exit code: N` line out of the text, and only as a
 * last resort (no exit code recoverable at all -- e.g. a transport-level string
 * failure from the tool) fall back to the `isError` flag.
 *
 * @param {any} res - an `execute_command` MCP result (`{ content, structuredContent }`),
 *   a plain string, or `{ isError, ... }`.
 * @returns {{ ok: boolean, stdout: string, error: string|undefined }}
 */
export function commandResultToSoftGit(res) {
    let text = '';
    if (typeof res === 'string') {
        text = res;
    } else if (res && Array.isArray(res.content)) {
        text = res.content
            .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
            .join('\n');
    } else if (res && typeof res.text === 'string') {
        text = res.text;
    }

    let exitCode;
    if (res && res.structuredContent && typeof res.structuredContent.exitCode === 'number') {
        exitCode = res.structuredContent.exitCode;
    } else {
        const m = /Exit code:\s*(-?\d+)/.exec(text);
        if (m) exitCode = Number(m[1]);
    }

    const ok = exitCode !== undefined ? exitCode === 0 : !(res && res.isError);
    return { ok, stdout: text, error: ok ? undefined : (text || 'unknown error') };
}
