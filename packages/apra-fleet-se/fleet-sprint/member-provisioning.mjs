// Member-provisioning helpers -- extracted move-only out of runner.js
// (apra-fleet-3swo.6.12). This module owns:
//
//   1. createMemberSessionGuard -- the pre-resume `stop_prompt` guard that
//      kills a prior, presumed-dead-or-timed-out session on a member before a
//      resume re-dispatch, so two live sessions never duplicate one logical
//      dispatch's side effects.
//   2. createUnattendedAutoProvisioner -- best-effort sets a member's
//      `unattended: 'auto'` registration before it is dispatched as deployer/
//      integ-test-runner/regression-test-runner, cached per member for the
//      lifetime of the returned function.
//   3. createDeployPermissionsProvisioner -- best-effort self-heal that reads
//      deploy.md's own `## Permissions` section off the first target member
//      it provisions and proactively grants every listed prefix via
//      compose_permissions, so a runbook permissions change does not have to
//      wait for a dispatch to fail before anyone notices.
//   4. stageCommandBodyMemberSide -- stages free-text content to a fresh,
//      member-LOCAL temp file via a shell-agnostic `node -e` one-liner (base64
//      argv, no `$`-expansion/backticks/template literals), so a `bd
//      --body-file` read always finds its file on the same filesystem the
//      subsequent `bd` command runs on.
//
// WHAT DID NOT MOVE -- resolveSettleShell. It sat in the middle of this group
// in runner.js and is module-private wiring: it resolves a member's settle
// shell from the per-sprint sprintState that sprint-state.mjs introduced,
// which is composition-root wiring rather than an implementation helper.
// test/sprint-state.test.mjs also anchors it to runner.js by symbol. It stays
// defined and exported from runner.js; nothing here imports it back, since
// none of the four moved symbols call it.
//
// runner.js re-exports every symbol it previously exported from this region,
// so existing importers of fleet-sprint/runner.js resolve unchanged.
//
// GUARD REGISTRATION: this module is registered in ./guarded-modules.mjs as
// part of this extraction (see that file's STANDING RULE). It carries the two
// member_name-bearing command() call sites this extraction took out of
// runner.js: createDeployPermissionsProvisioner's `node -e ...` read of
// deploy.md's Permissions section, and stageCommandBodyMemberSide's `node -e
// ...` member-side temp-file write. Both already avoid shell-level variable
// expansion (base64-encoded argv, no `$`/backtick/template-literal
// interpolation), which is exactly the invariant shell-command-guard.mjs
// enforces and reads GUARDED_MODULES to find.
// A third command() site was added later: createPermissionConfigPreflight's
// file-exists probe, built per member OS/shell by SeOsCommands.fileExistsProbe
// from a validated literal work-folder-relative path (no environment reads).

import os from 'node:os';
import path from 'node:path';
import { ApraFleet } from '@apralabs/apra-fleet-client';
import { resultText } from './mcp-result.mjs';
import { MemberPermissionConfigError } from './errors.mjs';
import { FILE_PROBE_PRESENT, FILE_PROBE_ABSENT } from './se-posix.mjs';

/**
 * Guards every "resume" re-dispatch below against spawning a second
 * concurrent session on a member whose PRIOR process for that same logical
 * dispatch is presumed dead or timed out but may still be alive -- two live
 * sessions for one dispatch duplicate whatever side effects the orphaned one
 * performs.
 *
 * Before firing a resume, call the fleet's own `stop_prompt` tool
 * (src/tools/stop-prompt.ts) for that member: it kills whatever process is
 * still on record and is a no-op when nothing is running, so pid liveness is
 * never reimplemented here.
 *
 * `callTool` is injected (the caller's MCP client), so this stays
 * transport-agnostic and unit-testable without a live fleet server. When it
 * is omitted, `killIfAlive()` is a no-op -- there is no live fleet connection
 * to guard against, matching every other best-effort client in this file when
 * its transport is absent.
 *
 * Best-effort by design: a `stop_prompt` failure is logged and swallowed
 * rather than blocking the resume -- the resume is what the sprint needs to
 * make progress, and this guard REDUCES rather than gates the chance of a
 * duplicate concurrent session.
 *
 * @param {{ callTool?: (name: string, args: object) => Promise<any>, log?: Function }} opts
 * @returns {{ killIfAlive: (member: string) => Promise<void> }}
 */
export function createMemberSessionGuard(opts = {}) {
    const { callTool, log = () => {} } = opts;
    const active = typeof callTool === 'function';

    return {
        async killIfAlive(member) {
            if (!active || !member) return;
            try {
                const result = await callTool('stop_prompt', { member_name: member });
                log(`[member-session-guard] pre-resume stop_prompt for '${member}': ${resultText(result) || '(no detail)'}`);
            } catch (err) {
                log(`[member-session-guard] pre-resume stop_prompt for '${member}' failed (non-fatal; resume proceeds): ${err.message}`);
            }
        },
    };
}

/**
 * Best-effort provisions a member for unattended execution (`unattended:
 * 'auto'`) before dispatching it as deployer, integ-test-runner, or
 * regression-test-runner -- roles that run real deploy commands and test
 * suites via a runbook and must never stall on an interactive permission
 * prompt. Provisioning is a one-way member-registration change and is
 * deliberately NOT reverted after the dispatch: `unattended` lives on the
 * member (update_member), not on the dispatch, so there is nothing to revert
 * to without also clobbering whatever the user set intentionally. In a
 * single-member sprint the same member also plays doer/reviewer/etc, so it
 * ends up unattended='auto' too -- accepted, not a bug.
 *
 * Cached per member for the lifetime of the returned function, so a sprint
 * with many deploy/integ/regression dispatches across cycles calls
 * update_member at most once per member. A failure (fleet unreachable,
 * member not found) is logged and swallowed -- exactly like
 * createMemberVcsProviderResolver above -- so a provisioning hiccup degrades
 * to whatever permission mode the member already had, rather than aborting
 * the phase.
 *
 * `callTool` is injected (the caller's MCP client), so this stays
 * transport-agnostic and unit-testable without a live fleet server.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, log?: Function }} opts
 * @returns {(member: string) => Promise<void>}
 */
export function createUnattendedAutoProvisioner(opts = {}) {
    const { callTool, log = () => {} } = opts;
    const fleetApi = new ApraFleet({ callTool });
    /** @type {Set<string>} members already confirmed unattended='auto' this run. */
    const provisioned = new Set();

    return async function ensureUnattendedAuto(member) {
        if (provisioned.has(member)) return;
        try {
            await fleetApi.updateMember({ member_name: member, unattended: 'auto' });
            provisioned.add(member);
            log(`[unattended] member '${member}' set to unattended='auto' for this dispatch.`);
        } catch (err) {
            log(`[unattended] could not set unattended='auto' on member '${member}' (continuing with its existing permission mode): ${err.message}`);
        }
    };
}

/**
 * Best-effort, self-heals the "Missing permission" class of deploy/integ/
 * regression-test failure BEFORE it happens: reads deploy.md's own
 * `## Permissions` section -- the exact list the deployer/integ-test-runner/
 * regression-test-runner agent prompts already cross-check at their own
 * Step 0a/0 -- and proactively grants every listed prefix to the target
 * member via compose_permissions. Without this, a runbook permissions
 * change (e.g. the `apra-fleet start` -> `apra-fleet run` swap, #395) only
 * gets noticed when a dispatch fails, and only gets fixed once an operator
 * greps deploy.md by hand and runs compose_permissions manually -- exactly
 * the failure mode this closes the loop on.
 *
 * Reads deploy.md via `command()` against the FIRST target member it is asked
 * to provision (that member is about to be dispatched as deployer/
 * integ-test-runner/regression-test-runner, so its own checkout is the source
 * of truth for what it is about to run) and caches the parsed prefix list for
 * the lifetime of the returned function -- one read per sprint run, since
 * deploy.md does not change mid-run on a healthy pipeline. Also caches per
 * TARGET member, like createUnattendedAutoProvisioner above, so repeat cycles
 * don't re-grant. Deliberately does NOT read via a separate orchestrator
 * member: the orchestrator role may be shared/unreservable across concurrent
 * sprints and carries no git checkout of its own to read from.
 *
 * Failure at any step (probe fails, deploy.md missing/unparseable,
 * compose_permissions unreachable, a listed prefix hitting the
 * NEVER_AUTO_GRANT denylist) is logged and swallowed. This is pure
 * best-effort acceleration -- the deployer's own Step 0a check remains the
 * authoritative, fail-closed backstop regardless of whether this succeeds.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, command: Function, log?: Function }} opts
 * @returns {(member: string) => Promise<void>}
 */
export function createDeployPermissionsProvisioner(opts = {}) {
    const { callTool, command, log = () => {} } = opts;
    const fleetApi = new ApraFleet({ callTool });
    /** @type {Set<string>} members already granted deploy.md's permissions this run. */
    const provisioned = new Set();
    /** @type {string[] | null | undefined} undefined = not yet attempted. */
    let cachedPrefixes;

    async function loadRequiredPrefixes(targetMember) {
        if (cachedPrefixes !== undefined) return cachedPrefixes;
        try {
            const res = await command(
                `node -e "const fs=require('fs'); if(fs.existsSync('deploy.md')) process.stdout.write(fs.readFileSync('deploy.md','utf8'))"`,
                { member_name: targetMember, silent: true, label: `Read deploy.md permissions`, failSoft: true },
            );
            if (!res.ok || !res.output) {
                cachedPrefixes = null;
            } else {
                const section = res.output.split(/^## Permissions/m)[1]?.split(/^## /m)[0] ?? '';
                const prefixes = [...section.matchAll(/^-\s*`([^`]+)`/gm)].map(m => m[1]);
                cachedPrefixes = prefixes.length ? prefixes : null;
            }
        } catch (err) {
            log(`[deploy-permissions] could not read deploy.md's Permissions section (continuing without auto-provisioning): ${err.message}`);
            cachedPrefixes = null;
        }
        return cachedPrefixes;
    }

    return async function ensureDeployPermissions(member) {
        if (!member || provisioned.has(member)) return;
        const prefixes = await loadRequiredPrefixes(member);
        if (!prefixes) return;
        try {
            const result = await fleetApi.composePermissions({
                member_name: member,
                role: 'doer',
                grant: prefixes,
                grant_reason: "deploy.md's declared Permissions section, auto-provisioned before dispatch",
            });
            provisioned.add(member);
            log(`[deploy-permissions] ensured deploy.md's required permissions on '${member}': ${result}`);
        } catch (err) {
            log(`[deploy-permissions] could not auto-provision deploy.md permissions on '${member}' (continuing -- the deployer's own Step 0a check remains the backstop): ${err.message}`);
        }
    };
}

/**
 * Sprint roles whose members get compose_permissions' read-mostly 'reviewer'
 * profile. A member serving ANY other role (or a mix) gets 'doer', the
 * superset, so re-composing never narrows what one of its roles needs.
 */
export const PERMISSION_CONFIG_REVIEWER_ROLES = Object.freeze(['reviewer', 'plan-reviewer', 'ci-watcher']);
const REVIEWER_ROLE_SET = new Set(PERMISSION_CONFIG_REVIEWER_ROLES);

/**
 * compose_permissions role for a member serving `roles`.
 * @param {string[]} roles
 * @returns {'doer'|'reviewer'}
 */
export function composeRoleForRoles(roles) {
    const list = (roles || []).filter(Boolean);
    return list.length > 0 && list.every((r) => REVIEWER_ROLE_SET.has(r)) ? 'reviewer' : 'doer';
}

const PERMISSION_PROBE_TIMEOUT_S = 60;

function memberDetailJson(res) {
    const text = resultText(res);
    return JSON.parse(text);
}

// A compose_permissions result that reports failure in its text (the tool
// returns its refusals/delivery failures as a text result, not a throw).
function composeFailureText(res) {
    if (res && typeof res === 'object' && res.isError) return resultText(res) || 'compose_permissions reported an error';
    const text = resultText(res).trim();
    if (/^(\u274c|\[FAIL\])/.test(text)) return text;
    return null;
}

/**
 * Member-init check for every dispatch member's composed per-folder
 * permission config (a re-cloned work folder, `git clean -xdf` or a fresh
 * worktree loses it, and the member's role then has its tool calls -- bd
 * included -- refused as "requires approval" while member init still reports
 * OK). For each member, BEFORE any dispatch:
 *
 *   1. read the provider's permission config file(s) from member_detail
 *      (`permissionConfigPaths`, straight from the member's ProviderAdapter --
 *      never assumed to be Claude's);
 *   2. probe each work-folder-relative one with a per-OS/shell command
 *      (memberShell(member).fileExistsProbe -- never shell-level expansion);
 *   3. if any is missing, call compose_permissions ONCE for the member's
 *      role (composeRoleForRoles) and re-probe;
 *   4. still missing, compose failing, or a probe that cannot answer ->
 *      MemberPermissionConfigError naming member, file(s) and the fix.
 *
 * Present configs are left untouched (no compose call). Home-anchored paths
 * ("~/...", agy) are not work-folder files: they are logged and left to
 * compose_permissions/execute_prompt, which provision them. A server too old
 * to report permissionConfigPaths is logged and that member is not checked.
 *
 * `ledgerFolderFor(member)` (optional) names the member's compose_permissions
 * ledger folder; a re-compose passes it as project_folder so grants an
 * earlier sprint's permission heal recorded there are restored too.
 *
 * @param {{ callTool: Function, command: Function, memberShell: (member: string) => Promise<{ fileExistsProbe: (relPath: string) => string }>, ledgerFolderFor?: (member: string) => string|undefined, log?: Function }} opts
 * @returns {(memberRoles: Map<string, string[]>) => Promise<{ composed: string[] }>}
 */
export function createPermissionConfigPreflight(opts = {}) {
    const { callTool, command, memberShell, ledgerFolderFor = () => undefined, log = () => {} } = opts;
    if (typeof callTool !== 'function') throw new TypeError('createPermissionConfigPreflight: callTool is required');
    if (typeof command !== 'function') throw new TypeError('createPermissionConfigPreflight: command is required');
    if (typeof memberShell !== 'function') throw new TypeError('createPermissionConfigPreflight: memberShell is required');
    const fleetApi = new ApraFleet({ callTool });

    const quoted = (files) => files.map((f) => "'" + f + "'").join(', ');
    const fixFor = (member, role, files) =>
        'run compose_permissions for ' + member + ' with role ' + role + ', check ' + quoted(files) +
        " exists in that member's workFolder, then rerun the sprint";

    const fail = (member, role, files, cause, details) => new MemberPermissionConfigError(
        "Member preflight failed: member '" + member + "' is missing its composed permission config " + quoted(files) + ' (' + cause + '). ' +
        'A role dispatched there would have its tool calls refused as requiring approval, so the sprint stops before any dispatch. ' +
        `To fix: ${fixFor(member, role, files)}.`,
        { member, files, role, details }
    );

    async function probe(member, role, shell, file) {
        let cmd;
        try {
            cmd = shell.fileExistsProbe(file);
        } catch (err) {
            throw fail(member, role, [file], `no probe could be built for it: ${err.message}`, { step: 'probe' });
        }
        let res;
        try {
            res = await command(cmd, { member_name: member, silent: true, failSoft: true, timeout_s: PERMISSION_PROBE_TIMEOUT_S, label: `Probe permission config ${file}` });
        } catch (err) {
            res = { ok: false, error: err && err.message ? err.message : String(err) };
        }
        if (res && typeof res === 'object' && res.ok === false) {
            throw fail(member, role, [file], `its probe failed: ${String(res.error || 'command failed').replace(/\s+/g, ' ').slice(0, 300)}`, { step: 'probe' });
        }
        const out = (res && typeof res === 'object') ? String(res.output ?? '') : String(res ?? '');
        const last = out.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
        if (last === FILE_PROBE_PRESENT) return true;
        if (last === FILE_PROBE_ABSENT) return false;
        throw fail(member, role, [file], `its probe answered '${last.slice(0, 120)}', not '${FILE_PROBE_PRESENT}'/'${FILE_PROBE_ABSENT}'`, { step: 'probe' });
    }

    return async function verifyPermissionConfigs(memberRoles) {
        const composed = [];
        for (const [member, roles] of memberRoles) {
            const role = composeRoleForRoles(roles);
            // Which files to check comes only from member_detail. When it
            // cannot say (unreachable, unparseable, or an older server without
            // the field) there is nothing to probe: that is a loud WARNING, and
            // an unreachable member then fails at its own first dispatch.
            let detail = null;
            let detailError = null;
            try {
                detail = memberDetailJson(await fleetApi.memberDetail({ member_name: member, format: 'json' }));
            } catch (err) {
                detailError = err && err.message ? err.message : String(err);
            }
            const reported = detail && typeof detail === 'object' ? detail.permissionConfigPaths : undefined;
            if (!Array.isArray(reported)) {
                const why = detailError
                    ? 'member_detail could not be read (' + detailError.replace(/\s+/g, ' ').slice(0, 200) + ')'
                    : 'member_detail does not report permissionConfigPaths (older fleet server)';
                log('[permission-config] WARNING: ' + why + " for member '" + member + "'; its composed permission config is not verified this sprint.");
                continue;
            }
            const files = [];
            for (const p of reported) {
                const f = String(p || '');
                if (!f) continue;
                if (f.startsWith('~')) {
                    log(`[permission-config] member '${member}': '${f}' is home-anchored, not a workFolder file; left to compose_permissions/execute_prompt to provision.`);
                    continue;
                }
                files.push(f);
            }
            if (files.length === 0) continue;
            const shell = await memberShell(member);
            const missing = [];
            for (const f of files) if (!(await probe(member, role, shell, f))) missing.push(f);
            if (missing.length === 0) {
                log(`[permission-config] member '${member}': composed permission config present (${files.join(', ')}).`);
                continue;
            }
            log(`[permission-config] member '${member}' is missing its composed permission config (${missing.join(', ')}); re-composing it with compose_permissions role '${role}'.`);
            let res;
            try {
                const ledger = ledgerFolderFor(member);
                res = await fleetApi.composePermissions({ member_name: member, role, ...(ledger ? { project_folder: ledger } : {}) });
            } catch (err) {
                throw fail(member, role, missing, `compose_permissions failed: ${err && err.message ? err.message : err}`, { step: 'compose' });
            }
            const composeErr = composeFailureText(res);
            if (composeErr) throw fail(member, role, missing, `compose_permissions failed: ${composeErr.replace(/\s+/g, ' ').slice(0, 300)}`, { step: 'compose' });
            const still = [];
            for (const f of missing) if (!(await probe(member, role, shell, f))) still.push(f);
            if (still.length > 0) throw fail(member, role, still, 'it is still missing after compose_permissions', { step: 'verify' });
            composed.push(member);
            log(`[permission-config] member '${member}': permission config re-composed (${missing.join(', ')}).`);
        }
        return { composed };
    };
}

// ---------------------------------------------------------------------------
// Mid-sprint permission-refusal heal (dispatch reason 'permission_denied')
// ---------------------------------------------------------------------------

/**
 * The compose_permissions ledger folder (project_folder) for one member: a
 * per-member folder under `baseDir` when given, else under the fleet server's
 * data directory (APRA_FLEET_DATA_DIR, default ~/.apra-fleet/data) -- the
 * same machine, since the server resolves project_folder on its own
 * filesystem and the sprint engine runs beside it. compose_permissions
 * creates the folder on its first grant. One folder per member keeps grants
 * scoped to that member.
 * @param {string} member
 * @param {string} [baseDir]
 * @returns {string|undefined}
 */
export function permissionLedgerFolder(member, baseDir) {
    if (!member) return undefined;
    const root = baseDir || path.join(process.env.APRA_FLEET_DATA_DIR || path.join(os.homedir(), '.apra-fleet', 'data'), 'permission-ledgers');
    return path.join(root, String(member).replace(/[^\w.-]/g, '_'));
}

/** Heals per member per sprint. Each heal re-runs a whole role dispatch, and
 *  real denial sets name one or two distinct tools, so three progressive
 *  grants (A, then B, then C) cover the observed cases while bounding the
 *  re-dispatch cost of a member that keeps reaching for new tools. */
export const PERMISSION_HEAL_MEMBER_CAP = 3;
/** Heals within one dispatch ladder (one role dispatch and its retries): a
 *  single dispatch that needs a third new tool after two grants is more likely
 *  wandering than blocked, and the member cap still allows a later dispatch
 *  to heal. */
export const PERMISSION_HEAL_LADDER_CAP = 2;

// A grant payload with any of these can chain or substitute another command,
// so it is never in policy whatever the composed list says (compose_permissions
// refuses the same set as NEVER_AUTO_GRANT).
const GRANT_CHAIN_RE = /[|;&`<>]|\$\(/;

/** Splits `Tool(payload)`; a bare tool name has payload null. */
function splitRule(rule) {
    const s = String(rule || '').trim();
    const m = /^([A-Za-z_][\w.-]*)\((.*)\)$/s.exec(s);
    return m ? { tool: m[1], payload: m[2].trim().replace(/\s+/g, ' ') } : { tool: s, payload: null };
}

/** The literal prefix a wildcard payload matches (`x:*` and `x *` both mean
 *  "x, then anything"; `x*` is a raw prefix), or null for an exact payload. */
function wildcardBase(payload) {
    if (payload.endsWith(':*')) return { base: payload.slice(0, -2), word: true };
    if (payload.endsWith(' *')) return { base: payload.slice(0, -2), word: true };
    if (payload.endsWith('*')) return { base: payload.slice(0, -1), word: false };
    return null;
}

/** True when payload rule `rule` allows the literal command line `cmd`. */
function bashRuleAllows(rule, cmd) {
    const w = wildcardBase(rule);
    if (!w) return rule === cmd;
    return w.word ? (cmd === w.base || cmd.startsWith(w.base + ' ')) : cmd.startsWith(w.base);
}

/** True when payload rule `rule` allows everything payload `wanted` allows. */
function bashRuleCovers(rule, wanted) {
    if (rule === wanted) return true;
    const ww = wildcardBase(wanted);
    if (!ww) return bashRuleAllows(rule, wanted);
    const rw = wildcardBase(rule);
    if (!rw) return false;
    return rw.word ? (ww.base === rw.base || ww.base.startsWith(rw.base + ' ')) : ww.base.startsWith(rw.base);
}

/**
 * True when the composed allow list `policy` already covers `grant` -- the
 * code-level guard that keeps a heal inside what the user's role profile
 * (plus detected stacks) grants. A bare tool name in the policy covers any
 * scoped form of that tool; a Bash rule covers a grant only if it allows
 * everything the grant would.
 * @param {string} grant
 * @param {string[]} policy
 */
export function grantWithinPolicy(grant, policy) {
    const g = splitRule(grant);
    if (g.payload !== null && GRANT_CHAIN_RE.test(g.payload)) return false;
    for (const raw of policy || []) {
        const r = splitRule(raw);
        if (r.tool !== g.tool) continue;
        if (r.payload === null) return true;
        if (g.payload === null) continue;
        if (r.tool === 'Bash' ? bashRuleCovers(r.payload, g.payload) : r.payload === g.payload) return true;
    }
    return false;
}

/** True when an already-landed grant should have allowed this refused call. */
function grantAllowsCall(grant, item) {
    const g = splitRule(grant);
    if (g.tool !== item.action) return false;
    if (g.payload === null) return true;
    if (typeof item.target !== 'string') return false;
    const call = item.target.trim().replace(/\s+/g, ' ');
    return g.tool === 'Bash' ? bashRuleAllows(g.payload, call) : g.payload === call;
}

const describeCall = (d) => (d.target ? `${d.action} "${d.target}"` : d.action);

/**
 * Builds the dispatch engine's `onPermissionDenied` hook: a PROGRESSIVE heal
 * of a member whose dispatch was refused tool calls for lack of a grant.
 * Denied tool A -> grant A, retry; tool B denied next -> grant B, retry; it
 * keeps going while each heal adds a grant that was not there before, and
 * stops (healed: false, with a `step`) only when no progress is possible:
 *
 *   not_healable  the session ran in an auto/bypass permission mode: the
 *                 refusal is the safety classifier or a deny rule, which no
 *                 grant may override (only acceptEdits-mode sessions -- e.g.
 *                 a model without auto support -- are healed);
 *   no_progress   a call was refused again although a landed grant covers
 *                 it (the grant did not take: something overrides it), a
 *                 call maps to no grant, or a needed grant is outside the
 *                 member's composed policy;
 *   cap           PERMISSION_HEAL_MEMBER_CAP heals for this member this
 *                 sprint, or PERMISSION_HEAL_LADDER_CAP in this ladder;
 *   heal          compose_permissions failed or refused the grant (its
 *                 NEVER_AUTO_GRANT floor); the grants are named.
 *
 * Security model: the member never grants itself anything -- the
 * orchestrator grants on need, only grants the member's own composed policy
 * already contains (compose_permissions dry_run for its role + stacks, not a
 * hand-kept copy), and compose_permissions' NEVER_AUTO_GRANT floor still
 * applies on the server.
 *
 * State is per sprint (this hook's lifetime) and per member: the grants that
 * landed and the heal count. Only the member's FIRST heal re-composes its
 * config from the role profile (restoring a config a re-clone dropped); later
 * heals only ADD grants, because a proactive compose rewrites the allow list
 * and would wipe the grants of earlier heals. Every grant is recorded in the
 * member's ledger folder (`ledgerFolderFor`, passed as project_folder), so a
 * later sprint's compose of that member keeps it.
 *
 * Resolves `{ healed, step?, composeRole, grants, rejectedGrants, reason }`;
 * never throws. healed is true only when at least one new grant landed.
 *
 * @param {{ callTool: Function, memberRoles?: (member: string) => string[], ledgerFolderFor?: (member: string) => string|undefined, log?: Function }} opts
 */
export function createPermissionDenialHeal(opts = {}) {
    const { callTool, memberRoles = () => [], ledgerFolderFor = () => undefined, log = () => {} } = opts;
    if (typeof callTool !== 'function') throw new TypeError('createPermissionDenialHeal: callTool is required');
    const fleetApi = new ApraFleet({ callTool });

    /** @type {Map<string, { granted: string[], healCount: number, recomposed: boolean, policy: Map<string, string[]> }>} */
    const state = new Map();
    const stateFor = (member) => {
        if (!state.has(member)) state.set(member, { granted: [], healCount: 0, recomposed: false, policy: new Map() });
        return state.get(member);
    };

    const compose = async (args) => {
        let res;
        try {
            res = await fleetApi.composePermissions(args);
        } catch (err) {
            return { error: `compose_permissions failed: ${err && err.message ? err.message : err}`, res: null };
        }
        const failure = composeFailureText(res);
        return failure
            ? { error: `compose_permissions failed: ${failure.replace(/\s+/g, ' ').slice(0, 300)}`, res }
            : { error: null, res };
    };

    const policyFor = async (member, st, composeRole) => {
        if (st.policy.has(composeRole)) return { allow: st.policy.get(composeRole) };
        const { error, res } = await compose({ member_name: member, role: composeRole, dry_run: true });
        if (error) return { error };
        let parsed = null;
        try { parsed = JSON.parse(resultText(res)); } catch { /* checked below */ }
        if (!parsed || parsed.dry_run !== true || !Array.isArray(parsed.allow)) {
            return { error: 'compose_permissions dry_run did not return the composed allow list (fleet server too old?)' };
        }
        const allow = parsed.allow.filter((p) => typeof p === 'string');
        st.policy.set(composeRole, allow);
        return { allow };
    };

    return async function onPermissionDenied({ member, role, denial, ladderHeals = 0 }) {
        const roles = [...new Set([...(memberRoles(member) || []), role].filter(Boolean))];
        const composeRole = composeRoleForRoles(roles);
        const st = stateFor(member);
        const stop = (step, reason, rejectedGrants = []) => {
            log(`[permission-heal] member '${member}' (${role}): not healed (${step}) -- ${reason}`);
            return { healed: false, step, composeRole, grants: [], rejectedGrants, reason };
        };

        const items = denial && Array.isArray(denial.denials) ? denial.denials : [];
        const what = items.length ? items.map(describeCall).join(', ') : ((denial && denial.actions.join(', ')) || 'unknown actions');

        if (denial && (denial.healable === false || denial.permissionMode === 'auto' || denial.permissionMode === 'bypassPermissions')) {
            return stop('not_healable', `the session ran in ${denial.permissionMode || 'a non-healable'} permission mode, where ${what} was refused by the safety classifier or a deny rule; no grant is ever added for that.`);
        }
        if (st.healCount >= PERMISSION_HEAL_MEMBER_CAP) {
            return stop('cap', `${st.healCount} permission heals already ran for this member this sprint (limit ${PERMISSION_HEAL_MEMBER_CAP}).`);
        }
        if (ladderHeals >= PERMISSION_HEAL_LADDER_CAP) {
            return stop('cap', `${ladderHeals} permission heals already ran for this dispatch (limit ${PERMISSION_HEAL_LADDER_CAP}).`);
        }
        if (items.length === 0) return stop('no_progress', 'the refusal named no tool call to grant.');

        // Refused again although a landed grant covers the call: the grant
        // did not take (a deny rule or managed setting overrides it).
        for (const item of items) {
            const landed = st.granted.find((g) => grantAllowsCall(g, item));
            if (landed) return stop('no_progress', `${describeCall(item)} was refused again after ${landed} was granted, so granting cannot fix it (a deny rule or managed setting likely overrides the grant).`);
        }

        const policy = await policyFor(member, st, composeRole);
        if (policy.error) return stop('heal', policy.error);

        const picked = new Set();
        const alreadyGranted = new Set(st.granted);
        const rejected = [];
        for (const item of items) {
            const options = Array.isArray(item.suggestedGrants) ? item.suggestedGrants : (denial.suggestedGrants || []);
            if (options.length === 0) return stop('no_progress', `no compose_permissions grant maps to ${describeCall(item)} (e.g. a chained shell command).`);
            const pick = options.find((g) => grantWithinPolicy(g, policy.allow));
            if (!pick) { rejected.push(...options); continue; }
            if (!alreadyGranted.has(pick)) picked.add(pick);
        }
        const newGrants = [...picked];
        if (rejected.length) {
            return stop('no_progress', `${[...new Set(rejected)].join(', ')} is outside the '${composeRole}' composed policy for this member; an operator must grant it deliberately.`, [...new Set(rejected)]);
        }
        if (newGrants.length === 0) return stop('no_progress', `every grant for ${what} is already in place.`);

        const ledger = ledgerFolderFor(member);
        const ledgerArg = ledger ? { project_folder: ledger } : {};
        if (!st.recomposed) {
            log(`[permission-heal] member '${member}' (${role}) was refused ${what}; re-composing its permissions with role '${composeRole}' (first heal this sprint).`);
            const re = await compose({ member_name: member, role: composeRole, ...ledgerArg });
            if (re.error) return stop('heal', re.error);
            st.recomposed = true;
        }
        const granted = await compose({
            member_name: member,
            role: composeRole,
            grant: newGrants,
            grant_reason: `sprint ${role} dispatch was refused these tool calls`,
            ...ledgerArg,
        });
        // A refused grant call (compose_permissions' NEVER_AUTO_GRANT floor,
        // or a delivery failure -- its own message says which) lands nothing:
        // stop and name the grants for an operator.
        if (granted.error) return stop('heal', granted.error, newGrants);
        st.granted.push(...newGrants);
        st.healCount += 1;
        log(`[permission-heal] member '${member}': granted ${newGrants.join(', ')} (heal ${st.healCount}/${PERMISSION_HEAL_MEMBER_CAP} this sprint).`);
        return { healed: true, composeRole, grants: newGrants, rejectedGrants: [], reason: null };
    };
}

/**
 * Stage `content` to a fresh temp file ON THE MEMBER that will run the
 * subsequent `bd` command, and return that MEMBER-LOCAL absolute path.
 * `command()` may dispatch `bd` to a different machine than the workflow
 * engine runs on, so a body file written to the engine host's own tmpdir
 * would not exist where `bd --body-file` reads it. Staging via `command()`
 * (member_name: member) guarantees the file lands on the SAME filesystem.
 *
 * The write is performed by a member-side `node` one-liner -- `node` is
 * present on every fleet member -- and the recipe is shell-agnostic: it
 * contains no `$`-expansion, backticks, template literals, or `%`-vars, so it
 * is inert as syntax in POSIX shells, PowerShell, and cmd.exe alike.
 * `content` is base64-encoded and passed as a SINGLE argv token whose
 * alphabet (A-Za-z0-9+/=) is likewise inert in all of those shells, and node
 * decodes it back to the exact literal bytes. This is the injection-safety
 * property: caller-supplied free text is NEVER interpolated into the shell
 * command string. The staged file is a member-side OS temp file the member's
 * OS reaps on its own.
 * @param {{ command: Function, member: string, content: string, label?: string }} opts
 * @returns {Promise<string>} the MEMBER-LOCAL temp file path
 */
export async function stageCommandBodyMemberSide({ command, member, content, label }) {
    const b64 = Buffer.from(content, 'utf-8').toString('base64');
    // No backticks / no `$` / no template literals: inert across POSIX,
    // PowerShell, and cmd.exe. Reads the base64 body from argv[1] (the first
    // arg after the `-e` script), decodes it to raw bytes, writes them to a
    // fresh member-local temp file, and prints ONLY that path to stdout.
    const stageScript =
        "const os=require('os'),p=require('path'),fs=require('fs');" +
        "const f=p.join(os.tmpdir(),'fleet-sprint-body-'+process.pid+'-'+Date.now()+'-'+Math.random().toString(36).slice(2)+'.txt');" +
        "fs.writeFileSync(f,Buffer.from(process.argv[1],'base64'));process.stdout.write(f)";
    const out = await command(
        `node -e "${stageScript}" "${b64}"`,
        { member_name: member, silent: true, label: label ?? 'Stage bd body file member-side' }
    );
    const staged = String(out ?? '').trim();
    if (!staged) throw new Error('member-side body staging returned an empty path');
    return staged;
}
