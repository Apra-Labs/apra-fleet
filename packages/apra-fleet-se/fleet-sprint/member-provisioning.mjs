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
//   3. createDeployPermissionsProvisioner -- before a deployer/integ-test-
//      runner/regression-test-runner dispatch, reads THAT role's own runbook
//      `## Permissions` section (RUNBOOK_BY_ROLE) off the target member and
//      grants every declared entry via compose_permissions, failing loudly
//      (RunbookPermissionsError) when an entry cannot be granted, so a
//      runbook/permission mismatch never waits for a dispatch to stop on it.
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
// runner.js: createDeployPermissionsProvisioner's `node -e ...` read of the
// role's runbook Permissions section, and stageCommandBodyMemberSide's `node -e
// ...` member-side temp-file write. Both already avoid shell-level variable
// expansion (base64-encoded argv, no `$`/backtick/template-literal
// interpolation), which is exactly the invariant shell-command-guard.mjs
// enforces and reads GUARDED_MODULES to find.

import { ApraFleet } from '@apralabs/apra-fleet-client';
import { resultText } from './mcp-result.mjs';
import { RunbookPermissionsError, RUNBOOK_PERMISSIONS_FAILURE_REASONS } from './errors.mjs';

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
 * The runbook each runbook-driven role reads its own `## Permissions` section
 * from, and cross-checks at its own Step 0/0a before running anything. A
 * closed map: the provisioner below refuses any other role rather than
 * guessing a filename.
 */
export const RUNBOOK_BY_ROLE = Object.freeze({
    'deployer': 'deploy.md',
    'integ-test-runner': 'integ-test-playbook.md',
    'regression-test-runner': 'regression-test-playbook.md',
});

const PERMISSION_TOKEN_RE = /^[A-Za-z_][A-Za-z0-9_-]*\(.*\)$/;

/**
 * Parses the permission entries a runbook's `## Permissions` section
 * declares. One entry per TOP-LEVEL bullet (a line starting `- `; indented
 * continuation lines are prose): the first backticked token on that bullet
 * that is permission-shaped (`Tool(...)`). Runbooks name a family in two
 * shapes and both resolve to the same entry:
 *   - `Bash(npm ci)`                          -> Bash(npm ci)
 *   - `npm test ...` (e.g. `Bash(npm test*)`) -> Bash(npm test*)
 * A bullet with no permission-shaped token is skipped (never granted as a
 * garbage string). Returns [] when there is no Permissions section.
 *
 * @param {string} text - the runbook's full markdown
 * @returns {string[]}
 */
export function parseRunbookPermissions(text) {
    const section = String(text ?? '').split(/^## Permissions\b.*$/m)[1]?.split(/^## /m)[0] ?? '';
    const entries = new Set();
    for (const line of section.split(/\r?\n/)) {
        if (!/^-\s/.test(line)) continue;
        const token = [...line.matchAll(/`([^`]+)`/g)].map(m => m[1].trim()).find(t => PERMISSION_TOKEN_RE.test(t));
        if (token) entries.add(token);
    }
    return [...entries];
}

// Member-side reader: prints the named file's content when it exists, nothing
// when it does not. The file name arrives base64-encoded as argv[1] -- the
// first arg after the `-e` script -- so the member-bound command string holds
// no `$`-expansion, backticks, template literals or `%`-vars, and is inert
// syntax under POSIX shells, PowerShell and cmd.exe alike.
const READ_FILE_SCRIPT =
    "const fs=require('fs');const f=Buffer.from(process.argv[1],'base64').toString('utf8');" +
    "if(fs.existsSync(f))process.stdout.write(fs.readFileSync(f,'utf8'))";

// compose_permissions' success glyph (U+2705), built from its code point so
// this file stays ASCII.
const COMPOSE_SUCCESS_MARK = String.fromCodePoint(0x2705);

/** Strips a leading non-ASCII status glyph so a surfaced message stays ASCII. */
function asciiDetail(text) {
    return String(text ?? '').replace(/^[^\x00-\x7F]+\s*/, '').trim() || '(no detail)';
}

/**
 * Provisions, BEFORE each deployer / integ-test-runner / regression-test-runner
 * dispatch, the Permissions entries declared by THAT role's own runbook (see
 * RUNBOOK_BY_ROLE) -- the exact list the dispatched agent cross-checks at its
 * own Step 0/0a -- via compose_permissions' grant mode on the target member.
 * Without this, a runbook permission the member lacks only surfaces when the
 * dispatched agent stops at its permission check mid-sprint, losing the cycle.
 *
 * Reads the runbook via `command()` against the FIRST target member it is
 * asked to provision for that runbook (that member is about to run it, so
 * its checkout is the source of truth) and caches the parsed entries per
 * runbook for the lifetime of the returned function. Grants are cached per
 * (member, runbook): in a small sprint one member plays several of these
 * roles and must receive each runbook's entries, but repeat cycles do not
 * re-grant. Deliberately does NOT read via a separate orchestrator member:
 * the orchestrator role may be shared across concurrent sprints and carries
 * no git checkout of its own to read from.
 *
 * A runbook that is absent, or has no Permissions section / no
 * permission-shaped entries, is a no-op. Every other failure is LOUD: a
 * RunbookPermissionsError naming the runbook and the entries is thrown
 * before dispatch when
 *   - compose_permissions refuses an entry (its never-auto-grant denylist),
 *   - compose_permissions errors, throws, or reports anything but success,
 *   - the runbook read itself fails.
 * When a grant batch fails, each entry is re-granted on its own so the error
 * names exactly the entries that cannot be granted. Success is judged from
 * each call's status (throw / isError / the tool's leading success glyph),
 * never by inspecting its message prose.
 * Nothing here widens what compose_permissions will grant; a denylisted
 * entry stays denied and is reported, never worked around.
 *
 * @param {{ callTool: (name: string, args: object) => Promise<any>, command: Function, log?: Function }} opts
 * @returns {(member: string, role: string) => Promise<void>}
 */
export function createDeployPermissionsProvisioner(opts = {}) {
    const { callTool, command, log = () => {} } = opts;
    const fleetApi = new ApraFleet({ callTool });
    /** @type {Set<string>} `${member}\0${runbook}` pairs already granted this run. */
    const provisioned = new Set();
    /** @type {Map<string, string[]>} runbook -> parsed entries ([] = nothing to grant). */
    const cachedEntries = new Map();
    /** @type {Map<string, string[]>} member -> every entry successfully granted to it this run. */
    const grantedByMember = new Map();

    /**
     * One compose_permissions grant. Success is judged from the call's STATUS
     * only -- a throw, `isError`, or a result not led by the tool's success
     * glyph is a failure -- never by reading its message. The text travels
     * along solely to quote in a surfaced error.
     * @returns {Promise<{ ok: boolean, text: string }>}
     */
    async function tryGrant(member, grant, grantReason) {
        try {
            const result = await fleetApi.composePermissions({
                member_name: member,
                role: 'doer',
                grant,
                grant_reason: grantReason,
            });
            const text = resultText(result);
            return { ok: !result?.isError && text.trimStart().startsWith(COMPOSE_SUCCESS_MARK), text };
        } catch (err) {
            return { ok: false, text: err?.message ?? String(err) };
        }
    }

    async function loadRunbookEntries(runbook, targetMember) {
        if (cachedEntries.has(runbook)) return cachedEntries.get(runbook);
        const b64 = Buffer.from(runbook, 'utf-8').toString('base64');
        let res;
        try {
            res = await command(
                `node -e "${READ_FILE_SCRIPT}" "${b64}"`,
                { member_name: targetMember, silent: true, label: `Read ${runbook} permissions`, failSoft: true },
            );
        } catch (err) {
            res = { ok: false, output: err?.message ?? String(err) };
        }
        if (!res || !res.ok) {
            throw new RunbookPermissionsError(
                `Could not read ${runbook} on member '${targetMember}' to provision its Permissions section before dispatch: ` +
                `${asciiDetail(res?.output)}`,
                { reason: RUNBOOK_PERMISSIONS_FAILURE_REASONS.READ_FAILED, runbook, member: targetMember },
            );
        }
        const entries = parseRunbookPermissions(res.output ?? '');
        cachedEntries.set(runbook, entries);
        return entries;
    }

    return async function ensureRunbookPermissions(member, role) {
        const runbook = RUNBOOK_BY_ROLE[role];
        if (!runbook) {
            throw new TypeError(
                `ensureRunbookPermissions: role must be one of ${Object.keys(RUNBOOK_BY_ROLE).join(', ')}; got ${JSON.stringify(role)}`,
            );
        }
        if (!member) return;
        const key = `${member}\u0000${runbook}`;
        if (provisioned.has(key)) return;
        const entries = await loadRunbookEntries(runbook, member);
        if (!entries.length) {
            provisioned.add(key);
            return;
        }

        // Every grant carries the union of everything already granted to this
        // member this run: for some providers compose_permissions' grant mode
        // REPLACES the member's allow list with the call's grants rather than
        // merging, so a member playing deployer then integ-test-runner would
        // otherwise lose deploy.md's entries to the integ grant. Harmless
        // where the tool merges (it dedupes).
        const prior = grantedByMember.get(member) ?? [];
        const withPrior = (list) => [...new Set([...prior, ...list])];
        const grantReason = `${runbook}'s declared Permissions section, auto-provisioned before the ${role} dispatch`;
        const batch = await tryGrant(member, withPrior(entries), grantReason);
        if (!batch.ok) {
            // compose_permissions refuses a grant batch as a whole when any
            // one entry is refused, so re-grant each entry on its own to name
            // exactly the entries that cannot be granted -- decided from each
            // call's success status alone, never by reading its message.
            const failures = [];
            for (const entry of entries) {
                const single = await tryGrant(member, withPrior([entry]), grantReason);
                if (!single.ok) failures.push({ entry, text: single.text });
            }
            const named = failures.length ? failures.map(f => f.entry) : entries;
            const detail = failures.length ? failures[0].text : batch.text;
            throw new RunbookPermissionsError(
                `${runbook} declares Permissions entr${named.length === 1 ? 'y' : 'ies'} that could not be granted to member ` +
                `'${member}' before the ${role} dispatch: ${named.join(', ')} -- compose_permissions said: ${asciiDetail(detail)}. ` +
                `Fix the runbook's Permissions section or grant these entries explicitly, then rerun.`,
                { reason: RUNBOOK_PERMISSIONS_FAILURE_REASONS.GRANT_FAILED, runbook, member, entries: named },
            );
        }
        provisioned.add(key);
        grantedByMember.set(member, withPrior(entries));
        log(`[runbook-permissions] granted ${entries.length} ${runbook} Permissions entr${entries.length === 1 ? 'y' : 'ies'} on '${member}' before the ${role} dispatch.`);
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
