// Fixture for apra-fleet-417.2.3: mentions 'bd dolt pull'/'bd dolt push'
// ONLY inside a comment and an import line referencing the sync module --
// checkDoltLiteralPath() against this file must report ZERO violations.
//
// Comment carve-out: this line itself mentions `bd dolt pull` and
// `bd dolt push` in prose, same as runner.js's own header comment above
// ./dolt-sync.mjs's call sites.
import { doltPullBefore, doltPushAfter } from '../../../fleet-sprint/dolt-sync.mjs';

function runOne(member) {
    return doltPullBefore(member, { command: () => {} });
}

export { runOne, doltPushAfter };
