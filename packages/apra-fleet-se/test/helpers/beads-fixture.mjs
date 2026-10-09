// Hermetic beads DB for tests that need a real, queryable tracker (supervisor
// serve, dashboard/backlog). Tests must never resolve this repo's own .beads:
// each fixture is a fresh temp dir initialised from the shared `bd init`
// template (bd-replay.mjs) plus a small checked-in issues JSONL, and is named
// explicitly (e.g. serve --beads-dir) instead of found by walking up from cwd.
import { exec } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bdInitFromTemplate } from './bd-replay.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE_ISSUES = path.join(__dirname, '..', 'fixtures', 'beads-fixture', 'issues.jsonl');

/** process.env plus `extra`, minus BEADS_DIR (which would redirect bd away from the fixture). */
export function envWithoutBeadsDir(extra = {}) {
    const env = { ...process.env, ...extra };
    delete env.BEADS_DIR;
    return env;
}

function bdIn(args, cwd) {
    return new Promise((resolve) => {
        exec(`bd ${args}`, { cwd, env: envWithoutBeadsDir(), windowsHide: true }, (err, stdout, stderr) => resolve({ err, stdout, stderr }));
    });
}

/**
 * Create a temp project dir with an initialised beads DB holding the fixture
 * issues. Returns { dir, beadsDir, issues, cleanup }; `issues` is the
 * fixture's `bd list --all --json` rows.
 */
export async function createBeadsFixture({ issuesFile = DEFAULT_FIXTURE_ISSUES } = {}) {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bdfx-'));
    const cleanup = () => fsp.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
    try {
        const init = await bdInitFromTemplate(dir);
        if (init.err) throw new Error(`bd init for the beads fixture failed: ${init.err.message}\n${init.stderr || ''}`);
        const imp = await bdIn(`import "${issuesFile}"`, dir);
        if (imp.err) throw new Error(`bd import into the beads fixture failed: ${imp.err.message}\n${imp.stderr || ''}`);
        const list = await bdIn('list --all --limit 0 --json', dir);
        if (list.err) throw new Error(`bd list in the beads fixture failed: ${list.err.message}\n${list.stderr || ''}`);
        const issues = JSON.parse(list.stdout);
        if (!Array.isArray(issues) || issues.length === 0) {
            throw new Error(`beads fixture at ${dir} has no issues after importing ${issuesFile}`);
        }
        return { dir, beadsDir: path.join(dir, '.beads'), issues, cleanup };
    } catch (err) {
        await cleanup();
        throw err;
    }
}
