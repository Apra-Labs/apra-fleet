// =============================================================================
// Supervisor project-folder API -- GET/POST /api/project (apra-fleet-i9ag.17.2.1)
// =============================================================================
//
// The guarded (bearer-token, /api/ prefix -- see supervisor/auth.mjs's
// requiresAuth(), which matches every /api/ path automatically) read/write
// surface for the supervisor's persisted project folder, so the console's
// Projects page (apra-fleet-i9ag.17.2.2) has something to talk to.
//
// Deliberately NOT /api/projects (that domain is the sqlite-backed
// multi-project CRUD store, src/projects/routes/projects.mjs, 11 routes,
// left completely untouched by this feature) -- see project-config.mjs's
// header for why the two must not merge. This route module's export is
// deliberately named registerProjectFolderRoutes (note the extra
// "Folder"), so it cannot be confused with -- or accidentally shadow --
// that sibling module's own route-registration export for the CRUD domain.
//
// WRITE VALIDATION reuses resolveBeadsDirArg() (./beads-identity.mjs) -- the
// SAME validator `--beads-dir` uses, including its convenience of accepting
// either a project folder or its .beads subdirectory -- so the flag and the
// console accept exactly the same inputs. This route never grows a second,
// divergent path validator.
//
// PERSISTENCE goes through project-config.mjs's writeSupervisorConfig(), the
// ONLY code in the repo that opens supervisor.config.json by name; this
// route never touches the file directly.
//
// FLAG OVERRIDE: a `--beads-dir` flag always wins the precedence
// (resolveProjectDir() in ./beads-identity.mjs). A save while the flag is in
// force is still validated and persisted (so it takes effect the moment the
// flag is later dropped and the supervisor restarted), but the response
// says so explicitly -- silently persisting a value that does nothing is
// the failure apra-fleet-i9ag.17.2.1's acceptance criteria calls out.
//
// SET-TIME USABILITY CHECK: a submitted path must be a folder a sprint can
// actually run against, not merely a folder that exists. The engine's beads
// identity precondition (../../fleet-sprint/beads-identity.mjs's
// isCompleteIdentity/COMPARED_FIELDS) is FATAL to a sprint, so a folder with
// no initialised `.beads`, no git `origin` remote, or no bd `sync.remote` can
// never run one -- and the operator setting it is standing right here, able
// to fix it, which is exactly when to say so. The route therefore probes the
// submitted folder (checkProjectFolderIdentity() in ./beads-identity.mjs) and
// refuses with 400 { error, missing } naming every missing field and its fix,
// persisting NOTHING.
//
// This deliberately REPLACES the route's original staleness-tolerant write
// (which accepted any existing directory, .beads or not, on the theory that
// the operator might initialise it later). That tolerance handed back a
// cheerful 200 for a setting guaranteed to fail at the next launch -- the
// silent-wrong-thing failure this whole feature exists to remove. The
// asymmetry resolveProjectDir() applies at STARTUP is unchanged and is a
// different question: an already-persisted folder that went stale must not
// stop the supervisor booting, because the console that fixes it is served
// by that same process.
// =============================================================================

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
    resolveBeadsDirArg, checkProjectFolderIdentity, BEADS_DIR_NAME, PROJECT_DIR_SOURCE,
} from './beads-identity.mjs';
import { writeSupervisorConfig } from './project-config.mjs';

/**
 * Does `dir` itself contain a `.beads` entry? A lightweight existence check
 * (mirrors discoverBeadsDir()'s single-directory test in
 * ./beads-identity.mjs), not a full `bd where` probe -- this route reports
 * on a filesystem path (the live resolved folder, or a freshly submitted
 * one), never on the supervisor's own resolved bd identity object.
 * @param {string} dir
 * @param {{ existsSync: Function, statSync?: Function }} fsImpl
 * @returns {boolean}
 */
function hasBeadsDbAt(dir, fsImpl) {
    const candidate = path.join(dir, BEADS_DIR_NAME);
    try {
        return fsImpl.existsSync(candidate)
            && (typeof fsImpl.statSync !== 'function' || fsImpl.statSync(candidate).isDirectory());
    } catch {
        return false;
    }
}

/**
 * Register GET/POST /api/project against a supervisor (server.mjs). Both are
 * auto-guarded by auth.mjs's requiresAuth() (every /api/ path); a test
 * asserts an unauthenticated call to each is refused with the supervisor's
 * normal 401.
 *
 * @param {{ route: (method: string, path: string, handler: Function) => void }} supervisor
 * @param {{
 *   projectDir: string,
 *   source: string,
 *   flagActive: boolean,
 *   dataDir: string,
 *   readJsonBody: (req: any) => Promise<any>,
 *   sendJson: (res: any, status: number, payload: object) => void,
 *   fs?: { existsSync: Function, statSync?: Function },
 *   fsp?: { readFile: Function, writeFile: Function, mkdir: Function, rename?: Function },
 *   execBd?: Function,
 *   execGit?: Function,
 * }} deps `projectDir`/`source` are the project-folder resolution decided
 *   once at startup (resolveProjectDir(), the same values GET /api/health
 *   reports); `flagActive` is whether that resolution's source is the
 *   `--beads-dir` flag (`source === PROJECT_DIR_SOURCE.FLAG`). `fs`/`fsp`
 *   are injectable purely for tests, as are `execBd`/`execGit` -- the two
 *   child-process shapes the POST usability probe runs through, so no test
 *   of this route ever needs a real bd or git on PATH.
 */
export function registerProjectFolderRoutes(supervisor, deps) {
    const { projectDir, source, flagActive, dataDir, readJsonBody, sendJson } = deps;
    const fsImpl = deps.fs ?? fs;
    const fspImpl = deps.fsp ?? fsp;

    // GET /api/project -- the currently resolved folder, its winning source,
    // and whether a beads DB was actually found there, in one call (so the
    // console page never needs a second round trip to render its state).
    supervisor.route('GET', '/api/project', async (req, res) => {
        sendJson(res, 200, {
            projectDir,
            source,
            hasBeadsDb: hasBeadsDbAt(projectDir, fsImpl),
            flagActive,
        });
    });

    // POST /api/project { projectDir } -- validate, persist, report.
    supervisor.route('POST', '/api/project', async (req, res) => {
        const body = (await readJsonBody(req)) ?? {};
        if (typeof body.projectDir !== 'string' || !body.projectDir.trim()) {
            sendJson(res, 400, { error: 'projectDir is required' });
            return;
        }
        let resolved;
        try {
            // Throws (a message naming the path) for anything that does not
            // exist or is not a directory -- nothing is persisted below in
            // that case.
            resolved = resolveBeadsDirArg(body.projectDir, { fs: fsImpl });
        } catch (err) {
            sendJson(res, 400, { error: err && err.message ? err.message : String(err) });
            return;
        }
        // The folder exists; can a sprint actually RUN there? See this
        // module's SET-TIME USABILITY CHECK header. `missing` is returned
        // alongside the human message so a caller can render the individual
        // failures without re-parsing prose.
        const usability = await checkProjectFolderIdentity({
            cwd: resolved,
            execBd: deps.execBd,
            execGit: deps.execGit,
        });
        if (!usability.ok) {
            sendJson(res, 400, { error: usability.error, missing: usability.missing });
            return;
        }
        const result = await writeSupervisorConfig({ projectDir: resolved, dataDir, fs: fspImpl });
        sendJson(res, 200, {
            projectDir: result.projectDir,
            hasBeadsDb: hasBeadsDbAt(result.projectDir, fsImpl),
            flagActive,
            // The source the SAVED value will have once the supervisor is
            // restarted: 'config', unless a --beads-dir flag is in force, in
            // which case the flag keeps winning the precedence
            // (resolveProjectDir()) and this setting stays dormant. Reported
            // because the console re-renders its whole Current block from
            // this response -- without it the Source row falls back to
            // "unknown" the instant a save succeeds.
            source: flagActive ? PROJECT_DIR_SOURCE.FLAG : PROJECT_DIR_SOURCE.CONFIG,
            // The config is read only during startup resolution (see
            // beads-identity.mjs's resolveProjectDir()) -- a save is never
            // live, so this is unconditionally true.
            restartRequired: true,
            note: flagActive
                ? `saved, but the --beads-dir flag is currently overriding this setting; it will not take effect until the flag is removed and the supervisor is restarted`
                : 'saved; restart the supervisor for this to take effect',
        });
    });
}
