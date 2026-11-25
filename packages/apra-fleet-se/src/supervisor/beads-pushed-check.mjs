// Launch preflight: does the supervisor's local beads clone hold changes the
// Dolt remote lacks? A sprint launched in that state makes the target member
// plan from stale scope, so POST /api/sprints refuses it with the remedy.
//
// The reader is dolt-sync.mjs's own readUnpushedWith (bd vc status --json,
// then bd diff remotes/origin/<branch> <branch> --json), run locally through
// this supervisor's bd exec in its beads folder.

import { readUnpushedWith } from '../../fleet-sprint/dolt-sync.mjs';
import { execBdAsync } from './lib/exec-bd.mjs';

export const UNPUSHED_BEADS_REMEDY = 'bd dolt commit && bd dolt push';

const BD_PREFIX = /^bd\s+/;

/**
 * Build the injectable probe used by createSprintController.
 * @param {{ cwd: string, execBd?: typeof execBdAsync }} opts
 * @returns {() => Promise<{ pending: boolean|null, why?: string }>}
 */
export function createBeadsPushedProbe({ cwd, execBd = execBdAsync }) {
    return async function probe() {
        const run = async (cmd) => {
            try {
                const args = cmd.replace(BD_PREFIX, '').split(/\s+/).filter(Boolean);
                const res = await execBd(args, { cwd, encoding: 'utf8', timeout: 30_000 });
                return { ok: true, output: String(res && res.stdout != null ? res.stdout : '') };
            } catch (err) {
                const out = err && err.stdout != null ? String(err.stdout) : '';
                return { ok: false, output: out, error: (err && err.message) || String(err) };
            }
        };
        return readUnpushedWith(run);
    };
}

export function unpushedBeadsMessage() {
    return `launch refused: the supervisor's local beads clone holds changes not pushed to the Dolt remote, so the target member would plan from stale scope. ` +
        `Run \`${UNPUSHED_BEADS_REMEDY}\` in the supervisor's beads folder, then relaunch.`;
}
