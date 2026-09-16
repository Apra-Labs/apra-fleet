// Fixture for apra-fleet-btj9.8: a deliberately unguarded explicit-id `bd
// create` call site that does NOT route through beads-children.mjs's
// assertChildIdFree() / createChildBeadWithAllocatedId probe-and-refuse seam.
//
// This module is never imported/executed by anything other than the
// explicit-id-create guard checker itself (packages/apra-fleet-se/fleet-
// sprint/explicit-id-create-guard.mjs, via checkExplicitIdCreatePath()) --
// its `command` identifier is a free variable, not a real import, because
// the checker only does a source-text scan and never actually evaluates
// this file. It exists solely to prove the checker can fail: the line below
// issues `bd create ... --id ...` directly instead of routing through
// beads-children.mjs, so checkExplicitIdCreatePath() against this file must
// report exactly one violation naming this fixture and its line. The id
// flag is assembled into an interpolated template-literal expression
// (mirroring beads-children.mjs:287's own `${parentageFlags}` shape) rather
// than appearing as a literal `--id` substring, which is exactly the shape
// the guard is widened to still catch (see explicit-id-create-guard.mjs's
// module header).

function runOne(title, id, member) {
    return command(`bd create "${title}" --id ${id} --silent`, { member_name: member });
}

export { runOne };
