// Fixture for apra-fleet-417.2.3: a deliberately reintroduced direct dolt
// command literal.
//
// This module is never imported/executed by anything other than the
// dolt-literal-guard checker itself (packages/apra-fleet-se/fleet-sprint/
// dolt-literal-guard.mjs, via checkDoltLiteralPath()) -- its `command`
// identifier is a free variable, not a real import, because the checker
// only does a source-text scan and never actually evaluates this file. It
// exists solely to prove the checker can fail: the line below issues 'bd
// dolt push' directly instead of routing through ./dolt-sync.mjs, so
// checkDoltLiteralPath() against this file must report exactly one
// violation naming this fixture and its line.

function runOne(member) {
    return command('bd dolt push', { member_name: member, silent: true });
}

export { runOne };
