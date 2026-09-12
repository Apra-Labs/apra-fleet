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
 * @param {{ command: Function, member: string, parentId: string }} opts
 * @returns {Promise<number>}
 */
export async function computeChildFloor({ command, member, parentId }) {
    try {
        const label = `bd list --parent ${parentId} --json`;
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
        return max;
    } catch {
        return 0;
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
 *   2. `bd create` runs with `--id <childId>` (or, under the null client where
 *      childId is null, lets bd derive the id from `--parent`).
 *   3. On the explicit-id path only, a follow-up `bd update <childId> --parent
 *      <parentId>` establishes the real parent edge.
 *   4. confirm() on success (the id is now durably used) or release() on
 *      failure (the reserved id returns to the pool, never a permanent gap).
 *
 * `bd create` REJECTS `--id` and `--parent` together, so on the explicit-id
 * path `--parent` must be dropped: the allocator's `${parentId}.${seq}` id
 * shape already encodes the hierarchy. A dotted id alone does NOT record the
 * explicit parent edge, which is what the separate `bd update --parent`
 * supplies; that link step is deliberately NOT best-effort -- a failure
 * throws, releases the reservation, and degrades loudly rather than leaving
 * an edgeless child.
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
        // Explicit-id path only: record the real parent edge that `--parent`
        // would have recorded, had bd allowed it on the same create.
        if (grant.childId) {
            await command(
                `bd update ${grant.childId} --parent ${parentId}`,
                { member_name: member, silent: true, label: `Link follow-up task ${grant.childId} under ${parentId}` }
            );
        }
    } catch (err) {
        // The create did NOT land -- return the reserved id to the pool so the
        // next allocation reuses it (no permanent gap), then re-throw.
        await allocator.release(grant.token);
        log(`[id-allocator] bd create failed for '${grant.childId ?? '(bd-derived)'}'; released reservation: ${err.message}`);
        throw err;
    }
    // The create landed locally -- durably commit the id BEFORE the D-push, so a
    // crash after this point can never reclaim an id that now genuinely exists.
    await allocator.confirm(grant.token);
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
