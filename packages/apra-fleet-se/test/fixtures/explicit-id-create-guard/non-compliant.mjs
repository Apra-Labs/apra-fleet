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
// flag here is a LITERAL `--id` whose VALUE is interpolated (corrected by
// apra-fleet-btj9.4 -- the previous wording claimed the flag itself was
// interpolated). The genuinely interpolated shape, with the whole flag
// assembled into a variable like beads-children.mjs's `${parentageFlags}`,
// is covered by the inline-source subtest in the guard's own test file.

function runOne(title, id, member) {
    return command(`bd create "${title}" --id ${id} --silent`, { member_name: member });
}

export { runOne };
