// =============================================================================
// Workflow-package manifest -- fleet-supervisor registers as 'se'
// (apra-fleet-g6ap.2.1)
// =============================================================================
//
// Builds the manifest object POSTed to the apra-fleet server's
// `POST /api/workflow-packages/register` (src/console/routes/workflow-packages.ts,
// validated by src/services/workflow-packages.ts's parseWorkflowPackageManifest).
// Every `path`-shaped field below (health/ownerRefs/holds/nav[].path/panels[].path)
// must be a path on THIS package's own baseUrl starting with '/', with no
// protocol-relative ('//...') or '..' segment -- the validator on the other
// end rejects anything else with a 400 naming the offending field.
//
// PACKAGE_ID is exported so other modules in this package (notably
// supervisor/auth.mjs, which accepts the derived per-package credential
// bound to this id) never hand-copy the literal 'se' string.
// =============================================================================

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** This workflow package's id -- the SAME value the project-domain sprint
 *  writes as the owner package (see the parent feature's description). */
export const PACKAGE_ID = 'se';

/**
 * apraFleetApi compatibility range this package declares at registration.
 * Must be satisfied (via src/services/workflow-packages.ts's
 * satisfiesVersionRange()) by the CURRENT apra-fleet server version -- the
 * repo's own version.json is "0.4.3" today, which a caret range on 0.4.0
 * covers (>=0.4.0, <0.5.0). Bump this only in lockstep with a verified
 * compatibility check against whatever the server version becomes.
 */
export const APRA_FLEET_API_RANGE = '^0.4.0';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** packages/apra-fleet-se/package.json -- two levels up from this file
 *  (src/registration/manifest.mjs -> src/ -> package root). */
const PACKAGE_JSON_PATH = path.join(__dirname, '..', '..', 'package.json');

/**
 * Read this package's own version from package.json. Never throws -- a
 * missing/corrupt package.json (should not happen in a real install) falls
 * back to '0.0.0' rather than taking registration down with it.
 * @returns {string}
 */
function readPackageVersion() {
    try {
        const raw = readFileSync(PACKAGE_JSON_PATH, 'utf-8');
        const pkg = JSON.parse(raw);
        return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0';
    } catch {
        return '0.0.0';
    }
}

/**
 * Build the manifest for this package's registration call.
 *
 * @param {{ baseUrl: string, version?: string }} args `baseUrl` is this
 *   supervisor's own real listening address, e.g. `http://127.0.0.1:8787`
 *   (no hardcoded port -- callers pass the port the HTTP server actually
 *   bound). `version` overrides the package.json read (tests only); omitted,
 *   it is resolved from packages/apra-fleet-se/package.json.
 * @returns {object} the manifest body to POST to
 *   `${serverUrl}/api/workflow-packages/register` alongside `id`/`baseUrl`/`apraFleetApi`.
 */
export function buildManifest({ baseUrl, version } = {}) {
    if (typeof baseUrl !== 'string' || baseUrl === '') {
        throw new TypeError('buildManifest: baseUrl must be a non-empty string');
    }
    return {
        id: PACKAGE_ID,
        name: 'Software engineering',
        process: 'fleet-supervisor',
        version: typeof version === 'string' && version !== '' ? version : readPackageVersion(),
        apraFleetApi: APRA_FLEET_API_RANGE,
        baseUrl,
        health: '/api/health',
        nav: [
            { label: 'Projects', path: '/ui/projects' },
            { label: 'Sprints', path: '/ui/sprints', scope: 'project' },
            { label: 'KB', path: '/ui/kb', scope: 'project' },
            { label: 'Code', path: '/ui/code', scope: 'project' },
        ],
        panels: [
            { slot: 'member.drawer', path: '/ui/panels/git' },
        ],
        ownerRefs: '/api/owner-refs',
        holds: '/api/members/:id/holds',
    };
}
