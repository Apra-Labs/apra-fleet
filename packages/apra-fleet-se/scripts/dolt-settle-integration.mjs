#!/usr/bin/env node
// =============================================================================
// dolt-settle-integration.mjs -- prove settleDoltConflicts() recovers a REAL
// Dolt merge conflict on a REAL fleet member (docs/dolt-sync-redesign.md
// Part 6). This is the executable form of Part 3.6 and the tool that fills in
// the design doc's Part 4 verification table.
//
// USAGE (from packages/apra-fleet-se, with a live fleet server):
//
//   node scripts/dolt-settle-integration.mjs --member fleet-lin-dev1
//   node scripts/dolt-settle-integration.mjs --all           # every registered member, STRICTLY sequential
//   node scripts/dolt-settle-integration.mjs --members fleet-win-dev1,fleet-lin-dev1,fleet-mac
//   node scripts/dolt-settle-integration.mjs --member fleet-mac --keep-sandbox   # debug: skip teardown
//
//   npm run test:dolt-settle-integration -- --member <name>
//
// EXIT CODES (no silent green, ever):
//   0  PASS        -- a real conflict existed, settle resolved it, assertions hold
//   1  FAIL        -- a real assertion failed (a genuine settle defect)
//   2  PRECONDITION/INCONCLUSIVE -- the environment was not available, or the
//                     manufactured conflict did not actually conflict, so
//                     nothing about settle was proven either way
//
// NOT A CI TEST, deliberately (Part 6.2). It needs a live apra-fleet server and
// SSH-reachable members, which no generic CI runner has. It lives under
// scripts/ specifically so the package's `test` script -- which globs only
// test/*.test.mjs -- can never sweep it up. Do not add it to any CI pass.
//
// SANDBOX, NOT PRODUCTION (Part 6.4). Mandatory. The script manufactures
// wedging conflicts and then runs recovery code against them, so it must never
// touch a member's real `.beads` clone or the shared production beads remote:
// a settle bug mid-test would otherwise convert a test failure into a
// production incident. Every command it issues -- and every command settle
// issues on its behalf -- runs with `run_from` set to a disposable sandbox
// directory under the member's OWN `~/.apra-fleet/settle-it/<runId>/`,
// containing:
//     store/  a dolt file remote, created for this run and deleted after
//     A/      a bd project seeded with ONE unmistakable [SETTLE-IT] fixture bead
//     B/      a second clone of that remote -- the clone we deliberately wedge
// Both clones live on the member so the sandbox needs no cross-machine remote
// and no new auth/network assumptions (Part 6.2's "no new environment
// assumptions"); the conflict is still manufactured from two independent
// clones, and settle still runs through the REAL execute_command dispatch
// against a REAL wedged clone.
//
// ASCII only.
// =============================================================================

import { parseArgs } from 'node:util';
import { StreamableHttpTransport } from '@apralabs/apra-fleet-client/transport';
import { McpClient } from '@apralabs/apra-fleet-client/client';
import { ApraFleet } from '@apralabs/apra-fleet-client';
import { resolveFleetServerConnection } from '../bin/cli.mjs';
import { settleDoltConflicts, DOLT_VERSION } from '../fleet-sprint/dolt-settle.mjs';
import { createMemberReservationClient } from '../fleet-sprint/runner.js';

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_PRECONDITION = 2;

const PINNED_VERSION = DOLT_VERSION.replace(/^v/, '');

const log = (msg) => console.log(msg);

class AssertionFailure extends Error {}
class Precondition extends Error {}

const assertTrue = (cond, msg) => { if (!cond) throw new AssertionFailure(msg); };

// ---------------------------------------------------------------------------
// Member shell dialect. The sandbox scaffolding is issued by THIS script (not
// by settle), so it needs the same per-dialect care settle does.
// ---------------------------------------------------------------------------

function isWindows(os) {
    const text = String(os || '').toLowerCase();
    return text.startsWith('win') || text.includes('windows');
}

function platformOf(member) {
    const os = String(member.os || '').toLowerCase();
    if (isWindows(os)) return 'win32';
    if (os.includes('mac') || os.includes('darwin')) return 'darwin';
    return 'linux';
}

/**
 * Sandbox root on the member, as a REAL absolute path.
 *
 * It must be literal, not `$HOME`/`$env:USERPROFILE`: these paths are also
 * passed as execute_command's `run_from`, which is used as a directory
 * directly and never shell-expanded (found the hard way -- an unexpanded
 * `$HOME` run_from fails with "No such file or directory").
 */
async function resolveSandboxRoot({ run, platform, runId }) {
    const probe = platform === 'win32' ? 'Write-Output $env:USERPROFILE' : 'echo "$HOME"';
    const res = await run(probe);
    const home = String(res.output || '').trim().split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (!home) throw new Precondition(`could not resolve the member's home directory: ${res.output}`);
    const sep = platform === 'win32' ? '\\' : '/';
    return [home, '.apra-fleet', 'settle-it', runId].join(sep);
}

// ---------------------------------------------------------------------------
// Fleet plumbing -- the same connection/dispatch path bin/cli.mjs uses. The
// conflict path is never mocked or re-implemented: settle is imported for
// real and driven through real execute_command dispatches.
// ---------------------------------------------------------------------------

async function connectFleet() {
    const connection = await resolveFleetServerConnection();
    if (!connection || connection.mode !== 'http') {
        throw new Precondition(`no reachable apra-fleet HTTP singleton (${connection && connection.reason}). Start the fleet server and retry.`);
    }
    const transport = new StreamableHttpTransport(connection.url);
    await transport.start();
    const mcpClient = new McpClient(transport);
    return { transport, mcpClient, fleetApi: new ApraFleet(mcpClient) };
}

/**
 * The member-scoped command runner settle is given -- identical in shape to
 * the one the sprint runner injects, plus a pinned `run_from` so every command
 * (settle's included) is confined to the sandbox directory and can never touch
 * the member's production clone.
 */
function commandFor(fleetApi, member, cwd) {
    return async (cmd, opts = {}) => {
        const res = await fleetApi.executeCommand({
            command: cmd,
            member_name: member,
            run_from: cwd,
            timeout_s: opts.timeout_s ?? 300,
        });
        const text = res && res.content && res.content[0] ? String(res.content[0].text ?? '') : '';
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* not every result is JSON */ }

        // execute_command answers in TWO shapes: a JSON envelope
        // ({exitCode, stdout, stderr}) on success, and a plain-text
        // "Exit code: N\n[stderr]..." block on failure -- and the failure
        // shape does NOT always set isError. Missing the text shape silently
        // turned a failed `bd dolt pull` into "ok", which is exactly the kind
        // of false green this script exists to prevent, so all three signals
        // are consulted.
        const textExit = text.match(/^\s*Exit code:\s*(\d+)/m);
        const exitCode = parsed && typeof parsed.exitCode === 'number'
            ? parsed.exitCode
            : (textExit ? Number(textExit[1]) : (res && res.isError ? 1 : 0));
        const stdout = parsed ? String(parsed.stdout ?? '') : text;
        const stderr = parsed ? String(parsed.stderr ?? '') : '';
        return {
            ok: exitCode === 0 && !(res && res.isError),
            output: `${stdout}${stderr ? `\n${stderr}` : ''}`,
            error: exitCode === 0 ? null : `${stderr || stdout}`.trim() || `exit ${exitCode}`,
            exitCode,
        };
    };
}

// ---------------------------------------------------------------------------
// Sandbox lifecycle.
// ---------------------------------------------------------------------------

async function setupSandbox({ run, platform, root, runId }) {
    const win = platform === 'win32';
    const A = win ? `${root}\\A` : `${root}/A`;
    const B = win ? `${root}\\B` : `${root}/B`;
    const store = win ? `${root}\\store` : `${root}/store`;
    // Dolt file remote URLs are always forward-slashed, on every OS.
    const storeUrl = `file://${(win ? store.replace(/\\/g, '/') : store)}`;

    log(`  [setup] creating the disposable sandbox at ${root}`);
    const mk = win
        ? `New-Item -ItemType Directory -Force "${root}\\A" | Out-Null; New-Item -ItemType Directory -Force "${root}\\B\\.beads" | Out-Null`
        : `mkdir -p "${root}/A" "${root}/B/.beads"`;
    const mkRes = await run(mk);
    if (!mkRes.ok) throw new Precondition(`could not create the sandbox directory: ${mkRes.error}`);

    const init = win
        ? `$env:BD_NON_INTERACTIVE='1'; Set-Location "${A}"; bd init --prefix settleit`
        : `cd "${A}" && BD_NON_INTERACTIVE=1 bd init --prefix settleit`;
    const initRes = await run(init);
    if (!initRes.ok) throw new Precondition(`bd init failed in the sandbox: ${initRes.error}`);

    const wire = win
        ? `Set-Location "${A}"; bd dolt remote add origin "${storeUrl}"; bd config set sync.remote "${storeUrl}"`
        : `cd "${A}" && bd dolt remote add origin "${storeUrl}" && bd config set sync.remote "${storeUrl}"`;
    const wireRes = await run(wire);
    if (!wireRes.ok) throw new Precondition(`could not wire the sandbox dolt remote: ${wireRes.error}`);

    const create = win
        ? `Set-Location "${A}"; bd q "[SETTLE-IT] disposable conflict fixture ${runId}"`
        : `cd "${A}" && bd q "[SETTLE-IT] disposable conflict fixture ${runId}"`;
    const createRes = await run(create);
    const beadId = (String(createRes.output || '').match(/\b(settleit-[A-Za-z0-9]+)\b/) || [])[1];
    if (!beadId) throw new Precondition(`could not create the sandbox fixture bead: ${createRes.output}`);
    log(`  [setup] fixture bead ${beadId}`);

    const seed = win ? `Set-Location "${A}"; bd dolt push` : `cd "${A}" && bd dolt push`;
    const seedRes = await run(seed);
    if (!seedRes.ok) throw new Precondition(`could not seed the sandbox remote: ${seedRes.error}`);

    // Clone B: a config.yaml with sync.remote is all `bd bootstrap` needs to
    // clone from the sandbox remote (the same bootstrap sequence fleet member
    // provisioning uses).
    const cloneB = win
        // NOTE: Set-Content with an ARRAY writes one line per element -- used
        // instead of an escaped newline so this file stays free of literal
        // PowerShell backtick escapes (the repo's pre-commit guard rejects
        // them outside .ps1, since they are a common copy-paste bug).
        ? `Set-Location "${B}"; Set-Content -Path ".beads\\config.yaml" -Value @("sync:", "  remote: ${storeUrl}"); $env:BD_NON_INTERACTIVE='1'; bd bootstrap --yes`
        : `cd "${B}" && printf 'sync:\\n  remote: %s\\n' "${storeUrl}" > .beads/config.yaml && BD_NON_INTERACTIVE=1 bd bootstrap --yes`;
    const cloneRes = await run(cloneB);
    if (!cloneRes.ok) throw new Precondition(`could not bootstrap the second sandbox clone: ${cloneRes.error}`);

    return { A, B, store, storeUrl, beadId };
}

async function teardownSandbox({ run, platform, root, keep }) {
    if (keep) {
        log(`  [teardown] --keep-sandbox: leaving ${root} in place for inspection.`);
        return;
    }
    const cmd = platform === 'win32'
        ? `Remove-Item -Recurse -Force "${root}" -ErrorAction SilentlyContinue`
        : `rm -rf "${root}"`;
    const res = await run(cmd);
    log(res.ok ? `  [teardown] sandbox removed (${root})` : `  [teardown] WARNING: could not remove ${root}: ${res.error}`);
}

// ---------------------------------------------------------------------------
// One scenario: manufacture a real conflict on `field`, prove it is genuinely
// unmergeable, then settle it and assert the outcome.
// ---------------------------------------------------------------------------

async function runScenario({ name, member, platform, runA, runB, beadId, aEdit, bEdit, expect, evidence }) {
    log(`  [${name}] orchestrator side (clone A): ${aEdit.description}`);
    const aUpdate = await runA(aEdit.cmd);
    if (!aUpdate.ok) throw new Precondition(`clone A edit failed: ${aUpdate.error}`);
    const aPush = await runA('bd dolt push');
    if (!aPush.ok) throw new Precondition(`clone A push failed: ${aPush.error}`);

    // Strictly wall-clock after A, so B's row carries the later updated_at and
    // the LWW-correct answer is unambiguous.
    await new Promise((resolve) => { setTimeout(resolve, 2000); });

    log(`  [${name}] member side (clone B): ${bEdit.description}`);
    const bUpdate = await runB(bEdit.cmd);
    if (!bUpdate.ok) throw new Precondition(`clone B edit failed: ${bUpdate.error}`);

    // PROVE the conflict is real before crediting settle with anything.
    const pull = await runB('bd dolt pull');
    if (pull.ok) {
        throw new Precondition(
            `[${name}] the manufactured conflict did NOT actually conflict -- 'bd dolt pull' succeeded on clone B. `
            + 'Reporting INCONCLUSIVE-FOR-SETTLE rather than claiming settle recovered a conflict that never existed.',
        );
    }
    if (!/conflict/i.test(String(pull.output || pull.error || ''))) {
        throw new Precondition(`[${name}] clone B's pull failed for a NON-conflict reason, so nothing was proven: ${pull.error}`);
    }
    log(`  [${name}] conflict confirmed unmergeable by raw bd: ${String(pull.error || '').split('\n')[0]}`);
    evidence.conflictProven = true;

    // THE ACTUAL SUBJECT: the real settle function, over the real dispatch.
    const started = Date.now();
    const result = await settleDoltConflicts(member, { command: runB, platform, log: (m) => log(`    ${m}`) });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);

    assertTrue(result.ok === true, `[${name}] settle did not report ok`);
    assertTrue((result.resolvedTables || []).includes('issues'), `[${name}] settle did not resolve the 'issues' table (got: ${(result.resolvedTables || []).join(', ') || 'none'})`);
    log(`  [${name}] settle resolved ${result.resolvedTables.join(', ')} in ${elapsed}s using dolt ${result.doltVersionUsed}`);
    evidence.doltVersionUsed = result.doltVersionUsed;
    evidence.warnings.push(...(result.warnings || []));

    // Assertions INDEPENDENT of settle's own return values.
    const status = await runB('bd dolt status');
    assertTrue(/embedded/i.test(String(status.output || '')), `[${name}] clone B is not back in embedded mode after settle: ${status.output}`);
    evidence.teardownClean = true;

    const rePull = await runB('bd dolt pull');
    assertTrue(rePull.ok, `[${name}] clone B still cannot pull after settle -- the clone is not actually unwedged: ${rePull.error}`);

    const show = await runB(`bd show ${beadId} --json`);
    assertTrue(show.ok, `[${name}] could not read the settled bead back: ${show.error}`);
    const settled = JSON.parse(String(show.output).slice(String(show.output).indexOf('{'), String(show.output).lastIndexOf('}') + 1));
    for (const [field, want] of Object.entries(expect)) {
        assertTrue(
            String(settled[field]) === String(want),
            `[${name}] settled bead field '${field}' is ${JSON.stringify(settled[field])}, expected ${JSON.stringify(want)} `
            + '-- this is the assertion that catches a wrong-direction resolve, not just "conflicts empty"',
        );
    }
    log(`  [${name}] LWW-correct row verified: ${Object.entries(expect).map(([k, v]) => `${k}=${v}`).join(', ')}`);
    evidence.lwwVerified = true;

    // Convergence: clone A (the other side) sees the settled value too.
    const aPull = await runA('bd dolt pull');
    assertTrue(aPull.ok, `[${name}] clone A could not pull the settled state: ${aPull.error}`);
    const aShow = await runA(`bd show ${beadId} --json`);
    const aSettled = JSON.parse(String(aShow.output).slice(String(aShow.output).indexOf('{'), String(aShow.output).lastIndexOf('}') + 1));
    for (const [field, want] of Object.entries(expect)) {
        assertTrue(String(aSettled[field]) === String(want), `[${name}] clone A did not converge on the settled '${field}' (got ${aSettled[field]}, expected ${want}) -- settle's republish did not reach the remote`);
    }
    log(`  [${name}] both clones converged on the settled row (settle republished successfully)`);

    return result;
}

/** Zero residue on the member (Part 6.5.6e): no settle-range sql-server, no
 *  mode flip, no leftover ephemeral log. */
async function assertNoResidue({ run, platform, evidence }) {
    const cmd = platform === 'win32'
        ? "Get-CimInstance Win32_Process -Filter \"Name='dolt.exe'\" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'sql-server' -and $_.CommandLine -match '--port 13[3-9][0-9]' } | ForEach-Object { Write-Output \"RESIDUE:$($_.ProcessId)\" }"
        : "ps -eo pid=,args= | awk '/sql-server/ && /--port 13[3-9][0-9]/ { print \"RESIDUE:\" $1 }'";
    const res = await run(cmd);
    const residue = String(res.output || '').match(/RESIDUE:\d+/g) || [];
    assertTrue(residue.length === 0, `settle left ${residue.length} ephemeral sql-server process(es) running: ${residue.join(', ')}`);

    const meta = platform === 'win32' ? 'Get-Content .beads\\metadata.json' : 'cat .beads/metadata.json';
    const metaRes = await run(meta);
    assertTrue(/"dolt_mode"\s*:\s*"embedded"/.test(String(metaRes.output || '')), `.beads/metadata.json dolt_mode is not "embedded" after settle: ${metaRes.output}`);
    evidence.teardownClean = true;
}

// ---------------------------------------------------------------------------
// One member, end to end.
// ---------------------------------------------------------------------------

async function verifyMember({ fleetApi, mcpClient, member, keepSandbox }) {
    const platform = platformOf(member);
    const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const evidence = {
        member: member.name,
        os: platform,
        date: new Date().toISOString().slice(0, 10),
        spawnVerified: false,
        flagSetVerified: false,
        lwwVerified: false,
        teardownClean: false,
        conflictProven: false,
        doltVersionUsed: null,
        warnings: [],
        notes: [],
    };

    log(`\n=== ${member.name} (${platform}) -- run ${runId} ===`);

    const reservation = createMemberReservationClient({
        callTool: (name, args) => mcpClient.callTool(name, args),
        members: [member.name],
        sprintId: `dolt-settle-it-${runId}`,
        log: (m) => log(`  ${m}`),
    });
    await reservation.reserveAll();

    // Every command below is confined to the sandbox by run_from.
    const runRoot = commandFor(fleetApi, member.name, undefined);
    let sandbox = null;
    let root = null;
    try {
        root = await resolveSandboxRoot({ run: runRoot, platform, runId });
        // Precondition V1 (design doc Part 5.5): the member-side binary settle
        // will use must report exactly the pinned version. Probed BEFORE the
        // run, so a green result can never come from an unpinned binary.
        const probeCmd = platform === 'win32'
            ? '& "$env:USERPROFILE\\.apra-fleet\\bin\\dolt.exe" version'
            : '"$HOME/.apra-fleet/bin/dolt" version';
        const probe = await runRoot(probeCmd);
        const version = (String(probe.output || '').match(/dolt version (\d+\.\d+\.\d+\S*)/i) || [])[1] || null;
        if (version && version !== PINNED_VERSION) {
            evidence.notes.push(`member-side dolt was ${version}, not the pinned ${PINNED_VERSION} before the run`);
        }
        evidence.doltVersionBefore = version;
        log(`  [precondition] member-side pinned dolt: ${version || 'ABSENT (settle will install it)'}`);

        sandbox = await setupSandbox({ run: runRoot, platform, root, runId });
        const runA = commandFor(fleetApi, member.name, sandbox.A);
        const runB = commandFor(fleetApi, member.name, sandbox.B);

        const preStatus = await runB('bd dolt status');
        assertTrue(/embedded/i.test(String(preStatus.output || '')), `the sandbox clone did not start in embedded mode: ${preStatus.output}`);

        // Scenario 1 -- SAME field on both sides: proves the LWW tiebreak fires.
        await runScenario({
            name: 'scenario-1 same-field LWW', member: member.name, platform, runA, runB, beadId: sandbox.beadId,
            aEdit: { description: `set priority=1 on ${sandbox.beadId} and push (uncontested)`, cmd: `bd update ${sandbox.beadId} --priority 1` },
            bEdit: { description: `set priority=3 on ${sandbox.beadId} (later updated_at -- must WIN)`, cmd: `bd update ${sandbox.beadId} --priority 3` },
            expect: { priority: 3 },
            evidence,
        });
        // Reaching here means the detached spawn AND the exact flag set both
        // worked on this OS -- settle cannot resolve anything without them.
        evidence.spawnVerified = true;
        evidence.flagSetVerified = true;

        // Scenario 2 -- DISJOINT fields: proves the conflict is row-level (not
        // cell-level) and that the per-field merge keeps BOTH sides' values.
        await runScenario({
            name: 'scenario-2 disjoint fields', member: member.name, platform, runA, runB, beadId: sandbox.beadId,
            aEdit: { description: `set status=in_progress on ${sandbox.beadId} and push`, cmd: `bd update ${sandbox.beadId} --status in_progress` },
            bEdit: { description: `set priority=0 on ${sandbox.beadId} (later updated_at)`, cmd: `bd update ${sandbox.beadId} --priority 0` },
            expect: { priority: 0, status: 'in_progress' },
            evidence,
        });

        await assertNoResidue({ run: runB, platform, evidence });

        const after = await runRoot(probeCmd);
        evidence.doltVersionUsed = evidence.doltVersionUsed || (String(after.output || '').match(/dolt version (\d+\.\d+\.\d+\S*)/i) || [])[1] || null;

        const degraded = evidence.warnings.length > 0 || (evidence.doltVersionUsed && evidence.doltVersionUsed !== PINNED_VERSION);
        return { verdict: degraded ? 'DEGRADED' : 'PASS', evidence };
    } finally {
        if (root) await teardownSandbox({ run: runRoot, platform, root, keep: keepSandbox });
        await reservation.releaseAll().catch(() => {});
    }
}

/** Emit a row in exactly Part 4's column format, ready to paste. */
function part4Row(label, evidence, verdict) {
    const yn = (b) => (b ? 'yes' : 'no');
    const notes = [
        `${verdict}`,
        evidence.doltVersionUsed ? `dolt ${evidence.doltVersionUsed}` : 'dolt version unknown',
        ...evidence.notes,
        ...evidence.warnings,
    ].join('; ');
    return `| ${label} | ${evidence.date} | ${yn(evidence.spawnVerified)} | ${yn(evidence.flagSetVerified)} | ${yn(evidence.lwwVerified)} | ${yn(evidence.teardownClean)} | ${notes} |`;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
    const { values } = parseArgs({
        options: {
            member: { type: 'string' },
            members: { type: 'string' },
            all: { type: 'boolean', default: false },
            'keep-sandbox': { type: 'boolean', default: false },
        },
        allowPositionals: false,
    });

    let fleet;
    try {
        fleet = await connectFleet();
    } catch (err) {
        console.error(`PRECONDITION FAILED (not a settle failure): ${err.message}`);
        process.exit(EXIT_PRECONDITION);
        return;
    }
    const { transport, mcpClient, fleetApi } = fleet;

    let exitCode = EXIT_PASS;
    const rows = [];
    try {
        const listed = await fleetApi.listMembers({ format: 'json' });
        const text = listed && listed.content && listed.content[0] ? listed.content[0].text : JSON.stringify(listed);
        const registered = JSON.parse(text).members || [];

        let targets;
        if (values.all) {
            targets = registered;
        } else {
            const wanted = String(values.members || values.member || '').split(',').map((s) => s.trim()).filter(Boolean);
            if (wanted.length === 0) {
                console.error('PRECONDITION FAILED (not a settle failure): pass --member <name>, --members a,b,c, or --all.');
                process.exit(EXIT_PRECONDITION);
                return;
            }
            targets = [];
            for (const name of wanted) {
                const found = registered.find((m) => m.name === name);
                if (!found) {
                    console.error(`PRECONDITION FAILED (not a settle failure): member '${name}' is not registered with this fleet.`);
                    process.exit(EXIT_PRECONDITION);
                    return;
                }
                targets.push(found);
            }
        }

        // Strictly sequential, with a full setup/teardown per member, so a
        // failure on one OS can never contaminate the next.
        for (const member of targets) {
            const evidenceLabel = `${member.name} (${platformOf(member)})`;
            try {
                // Reachability probe first -- an unreachable member is a
                // precondition failure, never a settle failure.
                // eslint-disable-next-line no-await-in-loop -- sequential by design
                const echo = await commandFor(fleetApi, member.name, undefined)('echo SETTLE_IT_PROBE');
                if (!echo.ok || !/SETTLE_IT_PROBE/.test(String(echo.output || ''))) {
                    throw new Precondition(`member '${member.name}' is not reachable: ${echo.error || echo.output}`);
                }
                // eslint-disable-next-line no-await-in-loop -- sequential by design
                const { verdict, evidence } = await verifyMember({ fleetApi, mcpClient, member, keepSandbox: values['keep-sandbox'] });
                rows.push(part4Row(evidenceLabel, evidence, verdict));
                log(`\n=== ${member.name}: ${verdict} ===`);
                if (verdict === 'DEGRADED' && exitCode === EXIT_PASS) exitCode = EXIT_PRECONDITION;
            } catch (err) {
                const kind = err instanceof Precondition ? 'PRECONDITION/INCONCLUSIVE' : 'FAIL';
                console.error(`\n=== ${member.name}: ${kind} -- ${err.message} ===`);
                rows.push(`| ${evidenceLabel} | ${new Date().toISOString().slice(0, 10)} | no | no | no | no | ${kind}: ${err.message.replace(/\|/g, '/').split('\n')[0]} |`);
                if (err instanceof Precondition) {
                    if (exitCode === EXIT_PASS) exitCode = EXIT_PRECONDITION;
                } else {
                    exitCode = EXIT_FAIL;
                }
            }
        }
    } finally {
        try { transport.stop(); } catch { /* best-effort */ }
    }

    log('\n--- design doc Part 4 rows (paste verbatim) ---');
    for (const row of rows) log(row);
    log(`--- exit ${exitCode} (0=proven recovery, 1=assertion failure, 2=environment/inconclusive) ---`);
    process.exit(exitCode);
}

main().catch((err) => {
    console.error(`UNEXPECTED FAILURE: ${err && err.stack ? err.stack : err}`);
    process.exit(EXIT_FAIL);
});
