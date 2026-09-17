// Child-bead allocation and batched-claim surface for fleet-sprint
// (apra-fleet-3swo.6.13). Extracted out of runner.js; runner.js re-exports
// every symbol it previously exported from this region, so existing importers
// of fleet-sprint/runner.js resolve unchanged.
//
// This module owns the bd COMMAND SITES that create/claim/verify child beads:
//   - computeChildFloor: best-effort read of a parent's existing direct
//     children, used to seed the id allocator's floor.
//   - createChildBeadWithAllocatedId: the single bead-creation seam every
//     proposed newTask flows through (allocate -> bd create -> bd update
//     --parent -> confirm/release).
//   - verifyDoerStreakClosed: the orchestrator's post-streak D-pull + `bd
//     show` verification read.
//   - claimBeadsBatched: the batched `bd update ... --claim --json` streak
//     work-claiming call.
//
// Deliberately kept OUT of coordination.mjs: coordination.mjs owns the
// TRANSPORT clients for the child-id allocator and the dolt push mutex
// (createHttpChildIdAllocatorClient, createMcpChildIdAllocatorClient and
// friends) -- this module's four functions are the CALLERS that issue bd
// commands on top of that transport. Mixing them would put a bd command
// surface inside a module whose whole point is transport.
//
// resolveSettleShell did NOT move -- it is module-private composition-root
// wiring that test/sprint-state.test.mjs anchors to runner.js by symbol, and
// six of its seven call sites are runner.js's own orchestrator-side settle
// brackets -- so this module imports it back from runner.js, the same
// back-import pattern member-sync.mjs already uses.

import { parseBdJson } from './beads-scope.mjs';
import { stageCommandBodyMemberSide } from './member-provisioning.mjs';
import { DoltSync } from './dolt-sync.mjs';
import { buildSettleCallback } from './dolt-settle.mjs';
import { resolveSettleShell } from './runner.js';

/**
 * The count of children a parent ALREADY has, i.e. the highest trailing `.N`
 * segment across its direct children. Passed to the allocator as `floor` so
 * that on its FIRST allocation under a parent it never mints an id colliding
 * with a child created before the allocator's persisted state was seeded.
 * Best-effort: a failed or unparseable list yields 0 (the allocator's own
 * persisted high-water still guards against re-minting after that).
 *
 * MUST include closed children (documented `--all` flag): `bd list --parent`
 * excludes closed issues by default, so once every existing child under a
 * parent is closed an unfiltered list would return [], the floor would
 * compute to 0, and the allocator would re-mint already-used ids (`.1`/`.2`,
 * ...) -- the trigger for the id-collision overwrite bug (apra-fleet-btj9).
 * `--all` ("Show all issues including closed") is `bd list`'s documented
 * spelling for this, per `bd list --help` on installed bd 1.1.0 -- `--status
 * all` is undocumented there (it is a documented value for `bd search`'s `-s`
 * flag, not `bd list`'s).
 *
 * SILENT FAILURE, apra-fleet-btj9.3: every failure mode here -- `bd` exiting
 * non-zero on a rejected flag, a dispatch timeout, unparseable JSON --
 * collapses to "this parent has no children", re-seeding the floor to 0 and
 * letting the allocator re-mint an already-used id. The best-effort RETURN
 * VALUE (0) is deliberate and stays; the optional `log` callback below makes
 * the failure itself visible to sprint output instead of vanishing into a
 * bare catch, matching the injected-log convention this module's other
 * functions already use (see createChildBeadWithAllocatedId's/
 * claimBeadsBatched's `log = () => {}` default).
 *
 * SUCCESS-PATH LOG, apra-fleet-btj9.3: a non-zero result is ALSO logged (a
 * zero floor -- the common "parent has no children yet" case -- is not, to
 * stay non-noisy). This is the only externally observable signal that the
 * `--all` closed-children read actually found and counted a prior child,
 * which is what lets a replayed mock-sprint scenario prove end to end that
 * this read reaches a genuine non-zero floor rather than only being covered
 * by the direct unit tests in child-floor-includes-closed-children.test.mjs.
 *
 * @param {{ command: Function, member: string, parentId: string, log?: Function }} opts
 * @returns {Promise<number>}
 */
export async function computeChildFloor({ command, member, parentId, log = () => {} }) {
    try {
        const label = `bd list --parent ${parentId} --json --all`;
        const raw = await command(label, { member_name: member, silent: true });
        const beads = parseBdJson(raw, label);
        let max = 0;
        const prefix = `${parentId}.`;
        for (const b of beads) {
            if (!b || typeof b.id !== 'string' || !b.id.startsWith(prefix)) continue;
            const tail = b.id.slice(prefix.length);
            // Only a DIRECT child (single trailing numeric segment) counts.
            if (!/^\d+$/.test(tail)) continue;
            const n = Number(tail);
            if (Number.isInteger(n) && n > max) max = n;
        }
        if (max > 0) {
            log(`[id-allocator] computeChildFloor: parent ${parentId} closed-children read found floor ${max}`);
        }
        return max;
    } catch (err) {
        log(`[id-allocator] computeChildFloor: bd list --parent ${parentId} --json --all failed or was unparseable (${err.message}); falling back to floor 0`);
        return 0;
    }
}

/**
 * Classifies a `bd show <id> --json` probe failure (apra-fleet-btj9.6) into
 * one of two outcomes, so the collision guard above can tell a genuine "the
 * id is free" result apart from "the probe itself could not be evaluated":
 *
 *   - 'absent': the thrown error's payload positively matches bd's documented
 *     no-such-issue shape (`{"error": "no issues found matching the provided
 *     IDs", ...}`, verified against installed bd 1.1.0). This is the ordinary,
 *     expected outcome of probing a genuinely free id.
 *   - 'unknown': anything else -- unparseable output, a differently-shaped
 *     error payload, a transport/dispatch fault. The caller MUST fail closed
 *     on this outcome rather than assume the id is free.
 *
 * Reads `probeErr.details.text` first (the raw stdout a typed CommandError
 * carries, see packages/apra-fleet-workflow/src/workflow/errors.mjs) and
 * falls back to `probeErr.message` (which production's FleetWorkflow.command()
 * also embeds the same raw stdout into, e.g. `Exit code 1: {...}`) for
 * callers/fakes that only ever throw a plain Error.
 *
 * @param {Error} probeErr
 * @returns {'absent'|'unknown'}
 */
export function classifyBdShowProbeError(probeErr) {
    const text = (probeErr && probeErr.details && typeof probeErr.details.text === 'string')
        ? probeErr.details.text
        : (probeErr && typeof probeErr.message === 'string' ? probeErr.message : '');
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
        try {
            const parsed = JSON.parse(match[0]);
            if (parsed && typeof parsed.error === 'string' && /no issues found/i.test(parsed.error)) {
                return 'absent';
            }
        } catch {
            // Not JSON, or not the expected shape -- fall through to unknown.
        }
    }
    return 'unknown';
}

/**
 * The probe-and-refuse half of the explicit-id collision guard, extracted
 * (apra-fleet-btj9.7) out of createChildBeadWithAllocatedId's inline block so
 * it is a single reusable, exported seam rather than logic private to that one
 * function. `bd create --id <id>` SILENTLY OVERWRITES an existing bead (open
 * OR closed) that already holds that id -- it reuses the same row and
 * clobbers its title/description/priority/type with no error. This function
 * probes for an existing bead at `childId` FIRST and throws rather than let
 * the caller proceed into an overwrite:
 *
 *   - ABSENT (the common, expected case): resolves normally, no throw.
 *   - PRESENT: throws, naming the existing bead's status.
 *   - UNKNOWN (the probe itself could not be evaluated -- unparseable output,
 *     an unrecognized error payload, a transport/dispatch fault): throws,
 *     FAILING CLOSED rather than assuming the id is free (apra-fleet-btj9.6).
 *
 * Does NOT touch the allocator reservation itself (release/confirm) -- that
 * stays the caller's responsibility, exactly as it was before extraction, so
 * a future caller with a different reservation lifecycle can reuse this probe
 * without inheriting allocator-specific side effects.
 *
 * @param {{ command: Function, member: string, childId: string, parentId: string }} opts
 * @returns {Promise<void>}
 */
export async function assertChildIdFree({ command, member, childId, parentId }) {
    const probeLabel = `bd show ${childId} --json`;
    let existing = null;
    try {
        const raw = await command(probeLabel, { member_name: member, silent: true });
        const beads = parseBdJson(raw, probeLabel);
        const list = Array.isArray(beads) ? beads : (beads ? [beads] : []);
        existing = list.find((b) => b && b.id === childId) || null;
    } catch (probeErr) {
        // VERIFIED against installed bd 1.1.0 (8e4e59d3): `bd show
        // <missing-id> --json` does NOT yield `[]` -- it exits non-zero and
        // prints `{"error": "no issues found matching the provided IDs",
        // "schema_version": 1}`. So the free-id case (the common, expected
        // outcome of this probe) always lands here, indistinguishable at
        // the throw site alone from a genuine dispatch fault. Classify the
        // catch into ABSENT (bd positively reported no such issue -- proceed)
        // vs UNKNOWN (anything else -- the probe could not be evaluated).
        //
        // FleetWorkflow.command() (packages/apra-fleet-workflow/src/workflow
        // /index.mjs _commandDispatch) DOES surface the child process's raw
        // stdout on a non-zero exit: a typed CommandError carries it on
        // `.details.text`, and its `.message` also embeds it (`Exit code N:
        // ${outText}`). That makes option 1 (parse the error payload)
        // implementable, so it is used here rather than the parent-listing
        // probe alternative.
        const outcome = classifyBdShowProbeError(probeErr);
        if (outcome === 'absent') {
            // The id is free -- the common path. Stay fast and non-noisy:
            // no log line, proceed to create exactly as before.
            existing = null;
        } else {
            // UNKNOWN: the probe itself could not be evaluated (unparseable
            // or unrecognized error payload, e.g. a transient dispatch
            // fault). FAIL CLOSED rather than silently degrading back into
            // the overwrite behavior apra-fleet-btj9 exists to prevent.
            throw new Error(
                `[id-allocator] refusing to create child bead at id '${childId}': the collision probe could not be ` +
                `evaluated (${probeErr.message}) -- treating as UNKNOWN, not a confirmed-free id. Released the reservation ` +
                'rather than risking an overwrite.',
            );
        }
    }
    if (existing) {
        throw new Error(
            `[id-allocator] refusing to create child bead at id '${childId}': a bead with that id already exists ` +
            `(status: ${existing.status ?? 'unknown'}); a 'bd create --id' on that id would silently overwrite it. ` +
            'Released the reservation rather than clobbering the existing bead.',
        );
    }
}

/**
 * Create a child bead under `parentId` using an allocator-minted,
 * collision-free explicit id. This is the single bead-creation seam every
 * proposed newTask flows through, so that two concurrent sprints never mint
 * the same child id.
 *
 * Sequence (mirrors the allocator's reserve -> confirm/release contract):
 *   1. allocate() reserves the next distinct child id under the shared parent.
 *   1a. Explicit-id path only: probe (`bd show <childId> --json`) that no bead
 *      already holds that id. `bd create --id` SILENTLY OVERWRITES an existing
 *      bead, so a collision releases the reservation and throws rather than
 *      clobbering it.
 *   2. `bd create` runs with `--id <childId>` (or, under the null client where
 *      childId is null, lets bd derive the id from `--parent`).
 *   3. confirm() as soon as `bd create` lands (the id is now durably used --
 *      release() from here on would hand out an id that is genuinely
 *      occupied, apra-fleet-btj9.2). release() only fires if step 2 itself
 *      (staging the description or the `bd create` dispatch) fails, so the
 *      reserved id returns to the pool with no permanent gap. confirm()
 *      ITSELF can fail (allocator transport fault, apra-fleet-btj9.5); that
 *      failure is caught (never released -- the bead already exists) and
 *      reported via a distinct orphan-naming error after step 4 runs.
 *   4. On the explicit-id path only, a follow-up `bd update <childId> --parent
 *      <parentId>` establishes the real parent edge, attempted regardless of
 *      whether confirm() in step 3 failed. A failure here does NOT release
 *      the reservation (the bead already exists) -- it throws a distinct
 *      "created but UNLINKED" error naming the orphan id so an operator can
 *      re-link it, rather than leaving the id allocator's next probe hit a
 *      confusing already-exists refusal. If step 3's confirm() ALSO failed,
 *      that failure is reported instead (with the link outcome folded in),
 *      never masked by this one.
 *
 * `bd create` REJECTS `--id` and `--parent` together, so on the explicit-id
 * path `--parent` must be dropped: the allocator's `${parentId}.${seq}` id
 * shape already encodes the hierarchy. A dotted id alone does NOT record the
 * explicit parent edge, which is what the separate `bd update --parent`
 * supplies; that link step is deliberately NOT best-effort -- a failure
 * throws and degrades loudly rather than leaving an edgeless child, but
 * (unlike the create step) it does NOT release the reservation, because by
 * that point the bead genuinely exists at the allocated id.
 *
 * @param {{
 *   command: Function, allocator: { allocate: Function, confirm: Function, release: Function },
 *   member: string, title: string, description: string, priority: string,
 *   parentId: string, sprintId?: string, floor?: number, label?: string,
 *   log?: Function,
 * }} opts
 * @returns {Promise<{ childId: string|null }>}
 */
export async function createChildBeadWithAllocatedId(opts) {
    const { command, allocator, member, title, description, priority, parentId, sprintId, floor, label, log = () => {} } = opts;
    const grant = await allocator.allocate(parentId, { pid: process.pid, sprintId, floor });
    // The explicit-id path relies on the allocator's `${parentId}.${seq}` id
    // shape to carry the hierarchy that `--parent` can no longer carry
    // alongside `--id` (see the doc comment above). Fail loudly rather than
    // create a child whose id does not place it under this parent at all.
    if (grant.childId && !String(grant.childId).startsWith(`${parentId}.`)) {
        await allocator.release(grant.token);
        throw new Error(
            `[id-allocator] allocated child id '${grant.childId}' is not a child of parent '${parentId}' ` +
            '(expected the `<parentId>.<seq>` shape); released the reservation rather than creating an unparented bead',
        );
    }
    // Collision guard: `bd create --id <childId>` SILENTLY OVERWRITES an
    // existing bead (open OR closed) that already holds that id -- it reuses the
    // same row and clobbers its title/description/priority/type with no error.
    // The allocator should never hand back an in-use id, but a crashed/partial
    // prior run, a stale persisted high-water, or a manually-created bead can
    // leave one occupied. So on the explicit-id path only, probe for an existing
    // bead at that id FIRST via the shared assertChildIdFree() seam (apra-fleet-
    // btj9.7) and REFUSE (release the reservation, throw loudly) rather than
    // overwrite. The null-allocator path (`bd create --parent`) lets bd mint a
    // fresh id natively and never collides, so it needs no probe.
    if (grant.childId) {
        try {
            await assertChildIdFree({ command, member, childId: grant.childId, parentId });
        } catch (probeErr) {
            await allocator.release(grant.token);
            throw probeErr;
        }
    }
    // `bd create` refuses `--id` together with `--parent`: carry EITHER the
    // allocator-minted explicit id (hierarchy encoded in the id, parent edge
    // linked immediately after the create) OR `--parent` and let bd derive the
    // id (null-allocator path).
    const parentageFlags = grant.childId ? `--id ${grant.childId}` : `--parent ${parentId}`;
    // The description is LLM-authored free text: stage it to a member-local
    // temp file (see stageCommandBodyMemberSide) and hand THAT path to `bd
    // create --body-file` rather than interpolating it into the shell command
    // string. Only `title` (short, allowlist-validated by validateNewTask)
    // remains inline.
    try {
        const descriptionFile = await stageCommandBodyMemberSide({
            command, member, content: description,
            label: `Stage newTask description for '${title}'`,
        });
        await command(
            `bd create "${title}" --body-file "${descriptionFile}" -p "${priority}" ${parentageFlags} --silent`,
            { member_name: member, silent: true, label: label ?? `Create follow-up task: ${title}` }
        );
    } catch (err) {
        // The create did NOT land -- return the reserved id to the pool so the
        // next allocation reuses it (no permanent gap), then re-throw.
        await allocator.release(grant.token);
        log(`[id-allocator] bd create failed for '${grant.childId ?? '(bd-derived)'}'; released reservation: ${err.message}`);
        throw err;
    }
    // The create landed locally -- durably commit the id BEFORE the D-push, so a
    // crash after this point can never reclaim an id that now genuinely exists.
    // From here on the reservation MUST stay confirmed: the bead already
    // exists at grant.childId (or bd's own derived id), so releasing it back
    // to the pool after this point would hand out an id that is genuinely
    // occupied -- the exact collision assertChildIdFree exists to refuse
    // (apra-fleet-btj9.2).
    //
    // confirm() itself can fail (an HTTP allocator route erroring, an MCP
    // transport fault, a supervisor restart) -- apra-fleet-btj9.5. That
    // failure sits OUTSIDE any release-on-failure try/catch, by design: the
    // bead already exists at this id, so release() must NEVER fire here,
    // exactly as for a link failure below. Capture the error instead of
    // letting it propagate raw, so the caller gets an orphan-naming message
    // rather than a bare transport-fault string with no indication that a
    // child bead now exists, is possibly unlinked, and may not be durably
    // confirmed in the allocator's own state.
    let confirmError = null;
    try {
        await allocator.confirm(grant.token);
    } catch (err) {
        confirmError = err;
        log(`[id-allocator] bd create landed for '${grant.childId ?? '(bd-derived)'}' but allocator.confirm() failed; reservation stays UNRELEASED (the id is genuinely in use) but may not be durably confirmed in the allocator's own state: ${err.message}`);
    }
    // Explicit-id path only: record the real parent edge that `--parent`
    // would have recorded, had bd allowed it on the same create. Deliberately
    // OUTSIDE the create's release-on-failure try/catch above: a failure here
    // must not release grant.token (the id is already in use, not free) and
    // must not be conflated with the create's own failure. Throw a distinct,
    // orphan-naming error instead so an operator can re-link rather than hit
    // an inexplicable id-already-exists refusal on the next newTask under
    // this parent.
    //
    // DECISION (apra-fleet-btj9.5): the link is attempted even when confirm()
    // above already failed. confirm() talks to the id-allocator's own
    // bookkeeping (HTTP/MCP transport); the link is a separate `bd update`
    // dispatch against bd itself, and a fault in the former says nothing
    // about whether the latter would also fail -- attempting it anyway means
    // a transient confirm blip does not ALSO cost the parent edge. If the
    // link then also fails, the confirm failure is still reported (it is the
    // more actionable signal: durable allocator state is what guards against
    // a future re-mint) with the link outcome folded into the SAME message,
    // rather than thrown separately, so the confirm failure is never masked
    // by a later link error.
    let linkError = null;
    if (grant.childId) {
        try {
            await command(
                `bd update ${grant.childId} --parent ${parentId}`,
                { member_name: member, silent: true, label: `Link follow-up task ${grant.childId} under ${parentId}` }
            );
        } catch (err) {
            linkError = err;
            log(`[id-allocator] bd create landed for '${grant.childId}' but the follow-up bd update --parent link failed; reservation stays confirmed (the id is genuinely in use): ${err.message}`);
        }
    }
    if (confirmError) {
        const idLabel = grant.childId ?? '(bd-derived id, unknown to the allocator)';
        throw new Error(
            `[id-allocator] child bead '${idLabel}' was created but allocator.confirm() FAILED: ${confirmError.message}. ` +
            `The bead exists at that id and is ${linkError ? 'also UNLINKED from' : 'linked under'} parent '${parentId}', ` +
            "and the reservation may not be durably confirmed in the allocator's own state -- do NOT release this id; " +
            'investigate the allocator directly rather than retrying newTask under this parent.' +
            (linkError ? ` (the follow-up parent-link dispatch also failed: ${linkError.message})` : ''),
        );
    }
    if (linkError) {
        throw new Error(
            `[id-allocator] child bead '${grant.childId}' was created but is UNLINKED under parent '${parentId}': ` +
            `the follow-up 'bd update ${grant.childId} --parent ${parentId}' failed (${linkError.message}). The id is ` +
            'genuinely in use -- re-link it manually rather than retrying newTask under this parent.',
        );
    }
    return { childId: grant.childId ?? null };
}

/**
 * The orchestrator's post-streak verification read, with its mandatory
 * D-pull. A remote doer closes its assigned beads in its OWN clone and
 * D-pushes them, so the orchestrator MUST D-pull its own clone BEFORE the `bd
 * show` -- otherwise it reads stale (still-open) status and falsely reports
 * every remote doer streak as FAILED.
 *
 * Returns the ids that are NOT closed after the D-pull-then-read. An empty
 * array means the streak genuinely closed everything it was assigned.
 *
 * @param {{ command: Function, orchestratorMember: string, beadIds: string[], log?: Function, args?: { callTool?: Function }, sprintState?: object }} opts
 * @returns {Promise<string[]>} the still-unclosed bead ids
 */
export async function verifyDoerStreakClosed({ command, orchestratorMember, beadIds, log = () => {}, args, sprintState }) {
    // D-pull FIRST so the orchestrator's clone observes the doer's just-pushed
    // closes. Routed through the single dolt-sync module's purpose-based BEFORE
    // bracket (apra-fleet-417.2.1); behavior is identical to the previous
    // direct doltPullBefore() call.
    // Thread the orchestrator member's REGISTERED shell into dolt-settle,
    // guarded on args.callTool the same way the pre-dispatch bracket is
    // (apra-fleet-7dir.24).
    const shell = await resolveSettleShell({ args, member: orchestratorMember, log, sprintState });
    await DoltSync.syncBefore(orchestratorMember, { command, log, fatal: true, settle: buildSettleCallback(orchestratorMember, { command, log, shell }) });
    const label = `bd show ${beadIds.join(' ')} --json`;
    const showRes = await command(label, { member_name: orchestratorMember, silent: true });
    const showBeads = parseBdJson(showRes, label);
    const statusById = new Map(showBeads.map((b) => [b.id, b.status]));
    return beadIds.filter((id) => statusById.get(id) !== 'closed');
}

/**
 * Batched per-streak work-claiming (apra-fleet-7h6n.7, audit R6): claims
 * every id in `beadIds` with ONE `bd update <id...> --claim --json`
 * invocation instead of one `bd update <id> --claim` call per bead.
 *
 * RESEARCH FINDING this batching relies on (verified against real `bd`
 * 1.1.0, both by reading `bd update --help`'s `Usage: bd update [id...]`
 * and by exercising a scratch sandbox DB): `bd update` DOES accept a
 * variadic id list, and `--claim --json` on a MULTI-id invocation returns a
 * JSON array containing ONLY the issues that were successfully claimed --
 * an id that fails to resolve, or is already claimed by a DIFFERENT
 * assignee, is silently dropped from the array (its error goes to stderr,
 * not stdout) rather than aborting the whole call. Two non-obvious
 * consequences, both load-bearing for this function's design:
 *   1. This is NOT atomic in the transactional sense -- ids before a
 *      failing one are still committed, there is no all-or-nothing
 *      rollback. It IS enough to cut the streak's claim step from N
 *      subprocess spawns to 1, which is this bead's actual goal.
 *   2. The process exit code stays 0 even when SOME ids in the batch
 *      failed to claim (verified: a lone failing id exits 1, but the exact
 *      same failure mixed into a multi-id batch with a succeeding id exits
 *      0) -- so, unlike the old single-id-per-call loop, success can NEVER
 *      be inferred from "command() did not throw". The returned JSON array
 *      is the only reliable signal, which is why this function always
 *      diffs `beadIds` against the parsed array rather than relying on a
 *      catch block.
 *
 * A total call failure (command() itself throws -- e.g. a transient
 * dispatch/network fault reaching the member) is treated the same way the
 * old loop treated "every id failed": every id is reported skipped, never
 * thrown, so one bad batch degrades the streak (all its beads stay
 * unclaimed, caller decides whether to skip the streak) rather than
 * crashing the sprint.
 *
 * @param {{ command: Function, orchestratorMember: string, beadIds: string[], log?: Function }} opts
 * @returns {Promise<{ claimedBeadIds: string[], skippedBeadIds: string[] }>}
 */
export async function claimBeadsBatched({ command, orchestratorMember, beadIds, log = () => {} }) {
    if (!Array.isArray(beadIds) || beadIds.length === 0) {
        return { claimedBeadIds: [], skippedBeadIds: [] };
    }
    const label = `bd update ${beadIds.join(' ')} --claim --json`;
    let raw;
    try {
        raw = await command(label, { member_name: orchestratorMember, silent: true });
    } catch (err) {
        // A dispatch/exec-level failure (member unreachable, transient
        // network fault) degrades gracefully -- every id in this batch
        // stays unclaimed, same as the old per-id loop's catch-and-skip.
        // This is DISTINCT from a malformed-JSON parse failure below, which
        // stays fatal (per parseBdJson's own doc comment: a parse failure
        // must be LOUD, never silently swallowed as "everything skipped").
        log(`Batched claim failed for [${beadIds.join(', ')}]: ${err.message}`);
        return { claimedBeadIds: [], skippedBeadIds: [...beadIds] };
    }
    const claimed = parseBdJson(raw, label);
    const claimedIds = new Set((Array.isArray(claimed) ? claimed : []).map((b) => b && b.id).filter(Boolean));
    const claimedBeadIds = beadIds.filter((id) => claimedIds.has(id));
    const skippedBeadIds = beadIds.filter((id) => !claimedIds.has(id));
    if (skippedBeadIds.length > 0) {
        log(`Batched claim: claimed ${claimedBeadIds.length} bead(s) [${claimedBeadIds.join(', ')}]; skipped ${skippedBeadIds.length} already-claimed/unresolvable bead(s) [${skippedBeadIds.join(', ')}].`);
    }
    return { claimedBeadIds, skippedBeadIds };
}
