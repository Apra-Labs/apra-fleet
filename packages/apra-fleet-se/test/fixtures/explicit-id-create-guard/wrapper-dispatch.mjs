// Fixture for apra-fleet-btj9.9: a bead-creation command dispatched through a
// NON-command wrapper -- a local `runBd` helper -- instead of a call spelled
// literally `command(...)`. This is exactly the WIDENING 2 gap named in
// explicit-id-create-guard.mjs's own header: findCallSites()'s lookbehind
// recognises only `command(`/`agent(`, so the call-site rule alone sees
// NOTHING here. Only the command-literal rule (any string/template literal
// whose content begins with `bd create` and continues into an argument,
// regardless of the enclosing call expression) catches this dispatch.
//
// This module is never imported/executed by anything other than the
// explicit-id-create guard checker itself -- its `runBd` identifier is a
// free variable, not a real import, because the checker only does a
// source-text scan and never actually evaluates this file. It exists solely
// to prove the command-literal rule's coverage: checkExplicitIdCreatePath()
// against this file must report exactly one violation naming this fixture
// and its line.

function runOne(title, id, member) {
    return runBd(`bd create "${title}" --id ${id} --silent`, { member_name: member });
}

export { runOne };
