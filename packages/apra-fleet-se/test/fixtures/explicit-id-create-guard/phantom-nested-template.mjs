// Fixture for apra-fleet-btj9.9: phantom-string SHAPE (c) -- a nested
// template literal inside a `${...}` interpolation, the vcs-providers/
// shell-helpers.mjs shQuote shape (a `.replace()` whose second argument is
// itself a backtick literal) -- placed BEFORE a real explicit-id `bd create`
// dispatch in the same module. skipStringLiteral() has no notion of template
// interpolation, so under the OLD quote-walk the inner backtick literal ends
// the OUTER template at the wrong place and every literal boundary after it
// is off by one -- swallowing the dispatch literal below. scanModuleLiterals()
// (18580c9a) recurses through `${...}` interpolations directly in
// scanTemplateLiteral(), so the inner template never desyncs the outer one
// and the dispatch below is still seen.
//
// The dispatch below is routed through a NON-command `runBd` wrapper
// (wrapper-dispatch.mjs's shape), deliberately, so this fixture exercises
// ONLY the command-literal rule -- a `command(...)` call would also trip the
// call-site rule, which reads extractBalancedCall() independently of
// maskComments(), muddying which rule actually caught the dispatch.
//
// This module is never imported/executed by anything other than the
// explicit-id-create guard checker itself -- its `runBd` identifier is a
// free variable, exactly like wrapper-dispatch.mjs.

function shQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runOne(title, id, member) {
    return runBd(`bd create "${title}" --id ${id} --silent`, { member_name: member });
}

export { shQuote, runOne };
