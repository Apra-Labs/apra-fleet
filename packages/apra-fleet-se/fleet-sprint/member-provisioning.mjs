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

import { ApraFleet } from '@apralabs/apra-fleet-client';
import { resultText } from './mcp-result.mjs';

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
