// Fixture for apra-fleet-btj9.9: phantom-string SHAPE (a) -- a regex body
// holding an apostrophe, the branch-ensure.mjs shape (`/couldn't find remote
// ref/i`) -- placed BEFORE a real explicit-id `bd create` dispatch in the
// same module. Under the OLD quote-walk (maskComments()/skipStringLiteral(),
// which never modeled regex literals), the apostrophe inside this regex
// opened a phantom `'`-delimited string span that swallowed everything up to
// the NEXT matching quote -- including the dispatch literal below -- so the
// guard reported this module clean. scanModuleLiterals() (18580c9a) treats a
// `/.../` regex body as a single opaque token via
// canStartRegex()/skipRegexLiteral() and never opens a phantom string on the
// apostrophe inside it, so the dispatch below is still seen.
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

function checkFetch(branchFetchOk, branchFetchError) {
    if (!branchFetchOk && !/couldn't find remote ref/i.test(branchFetchError || '')) {
        throw new Error(branchFetchError);
    }
}

function runOne(title, id, member) {
    return runBd(`bd create "${title}" --id ${id} --silent`, { member_name: member });
}

export { checkFetch, runOne };
