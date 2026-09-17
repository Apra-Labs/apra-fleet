// Fixture for apra-fleet-btj9.9: phantom-string SHAPE (b) -- a regex
// character class holding a quote, the newtask-text.mjs SAFE_TEXT_RE shape
// (`/^[A-Za-z0-9 .,:;!?()'_/+[\]-]+$/`) -- placed BEFORE a real explicit-id
// `bd create` dispatch in the same module. Same cause, same fix as shape (a):
// under the OLD quote-walk the apostrophe inside this character class opened
// a phantom `'`-delimited string span that swallowed the dispatch literal
// below; scanModuleLiterals() treats the whole regex (character class
// included) as one opaque token, so the dispatch below is still seen.
//
// The dispatch below is routed through a NON-command `runBd` wrapper
// (wrapper-dispatch.mjs's shape), deliberately, so this fixture exercises
// ONLY the command-literal rule -- a `command(...)` call would also trip the
// call-site rule, which reads extractBalancedCall() and already skips regex
// spans on its own, muddying which rule actually caught the dispatch.
//
// This module is never imported/executed by anything other than the
// explicit-id-create guard checker itself -- its `runBd` identifier is a
// free variable, exactly like wrapper-dispatch.mjs.

export const SAFE_TEXT_RE = /^[A-Za-z0-9 .,:;!?()'_/+[\]-]+$/;

function runOne(title, id, member) {
    return runBd(`bd create "${title}" --id ${id} --silent`, { member_name: member });
}

export { runOne };
