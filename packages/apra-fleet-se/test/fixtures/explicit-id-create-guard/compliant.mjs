// Fixture for apra-fleet-btj9.8: mentions `bd create` ONLY inside a comment
// and an import line referencing the single permitted bead-creation module
// (beads-children.mjs) -- checkExplicitIdCreatePath() against this file must
// report ZERO violations.
//
// Comment carve-out: this line itself mentions `bd create` in prose, same as
// beads-children.mjs's own header comment above its guarded call site.
import { createChildBeadWithAllocatedId } from '../../../fleet-sprint/beads-children.mjs';

function runOne(title, member) {
    // Routes through createChildBeadWithAllocatedId, which internally issues
    // the guarded `bd create ... --id ...` command only after
    // assertChildIdFree() has confirmed the allocated id is free.
    return createChildBeadWithAllocatedId({ title, member });
}

export { runOne, createChildBeadWithAllocatedId };
