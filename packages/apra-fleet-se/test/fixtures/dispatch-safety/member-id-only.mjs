// Fixture for apra-fleet-eft.3.3: a call site carrying member_id (not
// member_name) -- the checker must accept this as compliant, since the
// invariant is member_name OR member_id, never both required.
//
// As with non-compliant.mjs, this file's `command`/`agent` identifiers are
// free variables never actually evaluated -- the checker only parses this
// file's source text (packages/apra-fleet-se/auto-sprint/
// dispatch-safety-guard.mjs's checkPath()), it does not import/run it.

function runOne() {
    return command('git status --porcelain', { member_id: 'member-1', silent: true });
}

export { runOne };
