// Fixture for apra-fleet-eft.3.3: a deliberately non-compliant call site.
//
// This module is never imported/executed by anything other than the
// dispatch-safety-guard checker itself (packages/apra-fleet-se/auto-sprint/
// dispatch-safety-guard.mjs, via checkPath()) -- its `command`/`agent`
// identifiers are free variables, not real imports, because the checker
// only does a source-text parse and never actually evaluates this file. It
// exists solely to prove the checker can fail: the `command()` call below
// omits both member_name and member_id, so checkPath() against this file
// must report exactly one violation naming this fixture and line 13.

function runOne() {
    return command('git status --porcelain', { silent: true });
}

export { runOne };
